import { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useCanvasStore } from '@/stores/canvasStore';
import { useThemeStore } from '@/stores/themeStore';
import { usePty } from '@/hooks/usePty';
import { agentSpawn, onAgentStatus, ptyWrite } from '@/utils/ipc';
import { colors, fonts, spacing, typography, radius, agentColors, alpha } from '@/design/tokens';
import { attachKeyboardCapture } from './xtermInput';
import type { AgentTile as AgentTileType } from '@/types';

function isLightTheme(t: { bg: string }): boolean {
  const hex = t.bg.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}

function getXtermTheme() {
  const t = useThemeStore.getState().getActiveTheme();
  const light = isLightTheme(t);
  return {
    background: light ? '#2d3228' : t.bg,
    foreground: light ? '#e0e0e0' : t.fg + 'c4',
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: t.accent + '26',
  };
}

interface AgentTileProps {
  tile: AgentTileType;
}

const STATUS_COLORS: Record<string, string> = {
  spawning: colors.secondary,
  idle: colors.onSurfaceVariant,
  working: colors.primary,
  done: colors.green,
  error: colors.red,
};

export function AgentTile({ tile }: AgentTileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [customCmd, setCustomCmd] = useState(tile.command || '');

  // ─── Auto-complete detection ─────────────────────────────────────────
  // Fires the agent's status → 'done' without requiring the process to exit,
  // so agent-chain wires can trigger after each response.
  //
  // Two triggers, both optional and configurable per-tile:
  //  1. DONE sentinel — the agent (or user) writes "DONE" / "✅ DONE" /
  //     "[DONE]" on its own line. Fires immediately.
  //  2. Idle — no PTY output for `idleThresholdMs` (default 8s) after
  //     the agent has produced substantial output since its last transition.
  const idleTimerRef = useRef<number | null>(null);
  const sentinelFiredRef = useRef(false);
  const bytesSinceResetRef = useRef(0);
  const spawnedAtRef = useRef<number>(Date.now());

  const autoComplete = tile.autoComplete !== false; // default on
  const idleMs = tile.idleThresholdMs ?? 8000;
  const sentinelSource = tile.doneSentinel
    ?? String.raw`(?:^|\n)\s*(?:[✅✓]\s*|\[|##\s*)?DONE(?:\]|!|\.)?\s*(?:$|\n|\r)`;

  const markDoneFromAuto = useCallback((reason: 'sentinel' | 'idle') => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    const current = (store.tiles[pid] || []).find(t => t.id === tile.id) as AgentTileType | undefined;
    if (!current || current.status !== 'working') return;
    // Visually tag the agent's output so the user knows why the wire fired
    const marker = reason === 'sentinel'
      ? '\r\n\x1b[90m[auto-complete: DONE sentinel detected]\x1b[0m\r\n'
      : `\r\n\x1b[90m[auto-complete: idle > ${Math.round(idleMs / 1000)}s]\x1b[0m\r\n`;
    termRef.current?.write(marker);
    store.updateTile(tile.id, { status: 'done' } as Partial<AgentTileType>);
  }, [tile.id, idleMs]);

  const onData = useCallback((data: string) => {
    termRef.current?.write(data);
    termRef.current?.scrollToBottom();

    if (!autoComplete) return;

    // Grace period: ignore the first 3 seconds after spawn (welcome banners,
    // initial prompt render etc. shouldn't count as work).
    const elapsedSinceSpawn = Date.now() - spawnedAtRef.current;
    if (elapsedSinceSpawn < 3000) return;

    bytesSinceResetRef.current += data.length;

    // If we're currently 'done' and fresh output arrives, reset to 'working'
    // so the next idle/sentinel cycle can fire again on the next response.
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    const current = (store.tiles[pid] || []).find(t => t.id === tile.id) as AgentTileType | undefined;
    if (current && current.status === 'done') {
      sentinelFiredRef.current = false;
      bytesSinceResetRef.current = data.length;
      store.updateTile(tile.id, { status: 'working' } as Partial<AgentTileType>);
    }

    // Sentinel: literal "DONE" (case-insensitive) on its own line
    if (!sentinelFiredRef.current) {
      try {
        const re = new RegExp(sentinelSource, 'im');
        if (re.test(data)) {
          sentinelFiredRef.current = true;
          // Brief delay so the engine sees the final output in wireData
          setTimeout(() => markDoneFromAuto('sentinel'), 250);
          return;
        }
      } catch { /* bad regex — silently skip */ }
    }

    // Idle: reset timer on every output chunk, fire after silence
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      // Require substantial output since last reset to avoid firing on
      // transient status lines / boot messages.
      if (bytesSinceResetRef.current >= 50) {
        markDoneFromAuto('idle');
      }
    }, idleMs);
  }, [autoComplete, idleMs, sentinelSource, tile.id, markDoneFromAuto]);

  const onExit = useCallback(() => {
    termRef.current?.write('\r\n\x1b[90m[agent exited]\x1b[0m\r\n');
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    useCanvasStore.getState().updateTile(tile.id, { status: 'done' } as Partial<AgentTileType>);
  }, [tile.id]);

  // Clean up idle timer on unmount
  useEffect(() => () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
  }, []);

  const { write, resize } = usePty(tile.ptyId, onData, onExit);

  // Keep a ref so keyboard capture always uses the current write fn
  const writeRef = useRef(write);
  useEffect(() => { writeRef.current = write; }, [write]);

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const terminal = new Terminal({
      theme: getXtermTheme(),
      fontFamily: fonts.mono,
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    const detachKb = attachKeyboardCapture(
      containerRef.current,
      (data) => writeRef.current(data),
    );
    requestAnimationFrame(() => {
      fitAddon.fit();
      containerRef.current?.focus({ preventScroll: true });
    });

    termRef.current = terminal;
    fitRef.current = fitAddon;

    terminal.onData(data => writeRef.current(data));

    return () => {
      detachKb();
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // React to theme changes
  useEffect(() => {
    const unsub = useThemeStore.subscribe(() => {
      if (termRef.current) {
        termRef.current.options.theme = getXtermTheme();
      }
    });
    return unsub;
  }, []);

  // Subscribe to agent status events
  useEffect(() => {
    if (!tile.ptyId) return;
    const unsub = onAgentStatus(({ id, status }) => {
      if (id === tile.ptyId) {
        useCanvasStore.getState().updateTile(tile.id, { status: status as AgentTileType['status'] } as Partial<AgentTileType>);
      }
    });
    return () => { unsub.then(fn => fn()); };
  }, [tile.id, tile.ptyId]);

  // Spawn agent
  useEffect(() => {
    if (spawnedRef.current || tile.ptyId) return;
    spawnedRef.current = true;
    spawnedAtRef.current = Date.now(); // anchor for the 3s grace period
    bytesSinceResetRef.current = 0;
    sentinelFiredRef.current = false;

    const agentTypeMap: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
    const agentType = agentTypeMap[tile.agent] || 'Claude';

    agentSpawn({
      agentType: agentType as 'Claude' | 'Codex' | 'Gemini',
      cwd: tile.cwd || '~',
      ...(tile.command ? { customCommand: tile.command } : {}),
    }).then(async (id) => {
      useCanvasStore.getState().updateTile(tile.id, { ptyId: id, status: 'working' } as Partial<AgentTileType>);
      // Inject agent memory context if set for this project
      const { useAgentMemoryStore } = await import('@/stores/agentMemoryStore');
      const { ptyWrite: ptyWriteCtx } = await import('@/utils/ipc');
      const pid = useCanvasStore.getState().activeProject;
      const memory = useAgentMemoryStore.getState().getMemory(pid);
      if (memory) {
        // Strip control chars and ANSI escapes to prevent terminal injection
        const safeMem = memory.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        setTimeout(() => {
          ptyWriteCtx(id, `Project context: ${safeMem}`).catch(() => {});
          setTimeout(() => ptyWriteCtx(id, '\r').catch(() => {}), 300);
        }, 2000);
      }
    }).catch(err => {
      const msg = String(err);
      termRef.current?.write(`\x1b[1m--- Agent Spawn Failed ---\x1b[0m\r\n\r\n`);
      termRef.current?.write(`${msg}\r\n\r\n`);
      if (msg.toLowerCase().includes('not found')) {
        termRef.current?.write(`The '${tile.agent}' CLI is not installed or not in PATH.\r\n`);
        termRef.current?.write(`Install it, or click the gear icon to set a custom command.\r\n`);
      }
      useCanvasStore.getState().updateTile(tile.id, { status: 'error' } as Partial<AgentTileType>);
    });
  }, [tile.id, tile.ptyId, tile.agent, tile.cwd]);

  // Resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        if (fitRef.current && termRef.current) {
          fitRef.current.fit();
          resize(termRef.current.cols, termRef.current.rows);
        }
      }, 100);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [resize]);

  // Elapsed timer — use getState() to avoid effect cascade from tile.elapsed dep
  useEffect(() => {
    if (tile.status !== 'working') return;
    const interval = setInterval(() => {
      const store = useCanvasStore.getState();
      const pid = store.activeProject;
      const current = (store.tiles[pid] || []).find(t => t.id === tile.id) as AgentTileType | undefined;
      if (current) {
        store.updateTile(tile.id, { elapsed: current.elapsed + 1 } as Partial<AgentTileType>);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [tile.id, tile.status]);

  const handleSaveCommand = () => {
    useCanvasStore.getState().updateTile(tile.id, { command: customCmd } as Partial<AgentTileType>);
    setConfigOpen(false);
  };

  const agentColor = agentColors[tile.agent] || colors.primary;
  const statusColor = STATUS_COLORS[tile.status] || colors.secondary;
  const elapsedMin = Math.floor(tile.elapsed / 60);
  const elapsedSec = tile.elapsed % 60;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Agent header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: spacing.sm,
        padding: `4px ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineGhost}`,
        flexShrink: 0,
      }}>
        <span style={{
          ...typography.labelSm,
          color: agentColor,
          background: alpha(agentColor, 9),
          padding: '1px 6px',
          borderRadius: radius.sm,
          textTransform: 'uppercase',
          fontWeight: 600,
        }}>
          {tile.agent}
        </span>

        <span style={{ ...typography.labelSm, color: colors.secondary }}>
          {tile.model}
        </span>

        <div style={{ flex: 1 }} />

        {/* Status dot */}
        <div style={{
          width: 6, height: 6, borderRadius: radius.full,
          background: statusColor,
          boxShadow: tile.status === 'working' ? `0 0 6px ${statusColor}` : 'none',
        }} />

        {/* Elapsed */}
        <span style={{ ...typography.labelSm, color: colors.secondary, fontFamily: fonts.mono }}>
          {elapsedMin}m {elapsedSec}s
        </span>

        {/* Pipe context from incoming wires */}
        <button
          onClick={() => {
            if (!tile.ptyId) return;
            const store = useCanvasStore.getState();
            const pid = store.activeProject;
            const wires = store.wires[pid] || [];
            const incoming = wires.filter(w => w.toTile === tile.id && w.wireType === 'context-pipe');
            if (incoming.length === 0) return;
            let context = '';
            for (const wire of incoming) {
              const tiles = store.tiles[pid] || [];
              const src = tiles.find(t => t.id === wire.fromTile);
              if (!src) continue;
              const srcPtyId = 'ptyId' in src ? (src as { ptyId?: string }).ptyId : undefined;
              if (!srcPtyId) continue;
              const data = store.wireData[srcPtyId] || '';
              if (data) {
                context += `--- Piped from ${src.title || src.id} ---\n${data}\n`;
              }
            }
            if (context) {
              ptyWrite(tile.ptyId, context).catch(() => {});
            }
          }}
          title="Pipe context from connected tiles"
          style={{
            background: 'none', border: `1px solid ${colors.outlineGhost}`,
            borderRadius: radius.sm, cursor: 'pointer',
            color: colors.secondary, fontSize: '0.5625rem', padding: '1px 4px',
            fontFamily: fonts.mono,
          }}
        >
          Pipe
        </button>

        {/* Config gear */}
        <button
          onClick={() => setConfigOpen(!configOpen)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: colors.onSurfaceVariant, fontSize: 12, padding: 0,
            fontFamily: fonts.mono,
          }}
        >
          ⚙
        </button>
      </div>

      {/* Config panel */}
      {configOpen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: spacing.xs,
          padding: `4px ${spacing.sm}`,
          borderBottom: `1px solid ${colors.outlineGhost}`,
          flexShrink: 0,
        }}>
          <input
            value={customCmd}
            onChange={e => setCustomCmd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSaveCommand(); }}
            placeholder="Custom command (e.g. claude --dangerously-skip-permissions)"
            style={{
              flex: 1, background: 'transparent', border: 'none',
              color: colors.onSurfaceVariant, fontFamily: fonts.mono,
              fontSize: '0.75rem', outline: 'none',
            }}
          />
          <button
            onClick={handleSaveCommand}
            style={{
              background: colors.primary, border: 'none', borderRadius: radius.sm,
              color: colors.bg, fontFamily: fonts.mono, fontSize: '0.625rem',
              padding: '2px 6px', cursor: 'pointer',
            }}
          >
            Save
          </button>
        </div>
      )}

      {/* Terminal */}
      <div
        ref={containerRef}
        style={{ flex: 1, background: colors.bg, padding: '4px 0 0 4px', cursor: 'text' }}
      />
    </div>
  );
}
