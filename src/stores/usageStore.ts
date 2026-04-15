import { create } from 'zustand';
import { useCanvasStore } from './canvasStore';
import { httpFetch } from '@/utils/ipc';
import type { AgentTile } from '@/types';

// ─── Internal usage tracking ────────────────────────────

export interface AgentSession {
  id: string;
  agent: string;       // claude, codex, gemini
  startedAt: number;    // timestamp ms
  endedAt?: number;
  durationSecs: number;
  tileId: string;
  estimatedTokens: number;
  estimatedCost: number;
}

export interface UsageStats {
  totalSessions: number;
  totalDurationMins: number;
  byAgent: Record<string, { sessions: number; durationMins: number }>;
  activeSessions: number;
}

// ─── OpenUsage API types ────────────────────────────────

export interface OpenUsageLine {
  type: 'progress' | 'text' | 'badge';
  label: string;
  value?: number;
  maxValue?: number;
  resetAt?: string;
  scope?: string;
}

export interface OpenUsageProvider {
  id: string;
  name: string;
  plan?: string;
  lines: OpenUsageLine[];
  fetchedAt: string;
}

// ─── Store ──────────────────────────────────────────────

interface UsageState {
  sessions: AgentSession[];
  openUsageData: OpenUsageProvider[];
  openUsageConnected: boolean;
  openUsageError: string | null;

  trackSessionStart: (tileId: string, agent: string) => void;
  trackSessionEnd: (tileId: string) => void;
  getStats: () => UsageStats;
  fetchOpenUsage: () => Promise<void>;
}

const MAX_SESSIONS = 500;

export const useUsageStore = create<UsageState>((set, get) => ({
  sessions: [],
  openUsageData: [],
  openUsageConnected: false,
  openUsageError: null,

  trackSessionStart: (tileId, agent) => {
    set(s => {
      if (s.sessions.some(ss => ss.tileId === tileId && !ss.endedAt)) return s;
      const session: AgentSession = {
        id: crypto.randomUUID(),
        agent,
        startedAt: Date.now(),
        durationSecs: 0,
        tileId,
        estimatedTokens: 0,
        estimatedCost: 0,
      };
      return { sessions: [...s.sessions.slice(-MAX_SESSIONS), session] };
    });
  },

  trackSessionEnd: (tileId) => {
    // Estimate tokens from wireData output
    const wireData = useCanvasStore.getState().wireData[tileId] || '';
    // ~4 chars per token is a rough estimate
    const estimatedTokens = Math.round(wireData.length / 4);
    const COST_PER_1K: Record<string, number> = { claude: 0.015, codex: 0.01, gemini: 0.005 };

    set(s => ({
      sessions: s.sessions.map(ss => {
        if (ss.tileId !== tileId || ss.endedAt) return ss;
        const cost = (estimatedTokens / 1000) * (COST_PER_1K[ss.agent] || 0.01);
        return {
          ...ss,
          endedAt: Date.now(),
          durationSecs: Math.round((Date.now() - ss.startedAt) / 1000),
          estimatedTokens,
          estimatedCost: Math.round(cost * 1000) / 1000,
        };
      }),
    }));
  },

  getStats: () => {
    const { sessions } = get();
    const byAgent: Record<string, { sessions: number; durationMins: number }> = {};
    let totalDuration = 0;
    let activeSessions = 0;

    for (const s of sessions) {
      const dur = s.endedAt
        ? s.durationSecs
        : Math.round((Date.now() - s.startedAt) / 1000);

      if (!s.endedAt) activeSessions++;
      totalDuration += dur;

      if (!byAgent[s.agent]) byAgent[s.agent] = { sessions: 0, durationMins: 0 };
      byAgent[s.agent].sessions++;
      byAgent[s.agent].durationMins += Math.round(dur / 60);
    }

    return {
      totalSessions: sessions.length,
      totalDurationMins: Math.round(totalDuration / 60),
      byAgent,
      activeSessions,
    };
  },

  fetchOpenUsage: async () => {
    try {
      const res = await httpFetch({ url: 'http://127.0.0.1:6736/v1/usage', method: 'GET' });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(res.body) as OpenUsageProvider[];
      if (!Array.isArray(data)) throw new Error('Invalid OpenUsage response');
      set({ openUsageData: data, openUsageConnected: true, openUsageError: null });
    } catch {
      set({ openUsageConnected: false, openUsageError: 'OpenUsage not running' });
    }
  },
}));

// ─── Auto-track agent sessions from canvasStore ─────────
// Exposed as an init hook (not a module-side-effect) so the subscription
// can be cleaned up on unmount / HMR. Previously registered at import
// time with no unsubscribe — duplicate subscriptions accumulated on HMR
// reloads and on long sessions with multiple project switches.

let usageTrackerInstalled = false;
const trackedAgents = new Set<string>();

export function initUsageTracking(): () => void {
  if (usageTrackerInstalled) return () => {};
  usageTrackerInstalled = true;
  const unsub = useCanvasStore.subscribe((state) => {
    const pid = state.activeProject;
    if (!pid) return;
    const tiles = state.tiles[pid] || [];
    const currentAgentIds = new Set<string>();

    for (const t of tiles) {
      if (t.type !== 'agent') continue;
      const agent = t as AgentTile;
      currentAgentIds.add(agent.id);

      if ((agent.status === 'working' || agent.status === 'spawning') && !trackedAgents.has(agent.id)) {
        trackedAgents.add(agent.id);
        useUsageStore.getState().trackSessionStart(agent.id, agent.agent);
      }

      if ((agent.status === 'done' || agent.status === 'error') && trackedAgents.has(agent.id)) {
        trackedAgents.delete(agent.id);
        useUsageStore.getState().trackSessionEnd(agent.id);
      }
    }

    // Clean up tracked agents that were removed
    for (const id of trackedAgents) {
      if (!currentAgentIds.has(id)) {
        trackedAgents.delete(id);
        useUsageStore.getState().trackSessionEnd(id);
      }
    }
  });
  return () => {
    usageTrackerInstalled = false;
    unsub();
  };
}
