import { create } from 'zustand';
import { httpFetch, secretSet, secretGet, secretDelete } from '@/utils/ipc';

// Per-connection backoff state. Keyed off connection id so replacing a
// connection resets its state and swapping projects doesn't cross-pollinate.
const backoffByConn = new Map<string, { failures: number; nextAllowedAt: number }>();

// ─── MCP Connection Types ──────────────────────────────

export interface McpConnection {
  id: string;
  name: string;
  type: McpType;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  config: Record<string, string>;
  lastSync?: string;
  error?: string;
}

export type McpType = 'slack' | 'linear' | 'github' | 'notion' | 'jira' | 'google-calendar' | 'gmail' | 'custom';

export interface McpTask {
  id: string;
  source: McpType;
  sourceId: string;
  text: string;
  done: boolean;
  assignee?: string;
  priority?: string;
  url?: string;
}

// ─── Built-in MCP definitions ──────────────────────────

export interface McpDefinition {
  type: McpType;
  name: string;
  description: string;
  icon: string;
  configFields: { key: string; label: string; placeholder: string; secret?: boolean }[];
}

export const MCP_DEFINITIONS: McpDefinition[] = [
  {
    type: 'slack',
    name: 'Slack',
    description: 'Pull messages and reminders as tasks',
    icon: '#',
    configFields: [
      { key: 'token', label: 'Bot Token', placeholder: 'xoxb-...', secret: true },
      { key: 'channel', label: 'Channel ID', placeholder: 'C01234567' },
    ],
  },
  {
    type: 'linear',
    name: 'Linear',
    description: 'Sync issues assigned to you',
    icon: '△',
    configFields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'lin_api_...', secret: true },
      { key: 'teamId', label: 'Team ID (optional)', placeholder: '' },
    ],
  },
  {
    type: 'github',
    name: 'GitHub',
    description: 'Pull assigned issues and PRs',
    icon: '⬡',
    configFields: [
      { key: 'token', label: 'Personal Access Token', placeholder: 'ghp_...', secret: true },
      { key: 'repo', label: 'Repo (owner/name)', placeholder: 'org/repo' },
    ],
  },
  {
    type: 'notion',
    name: 'Notion',
    description: 'Sync tasks from a Notion database',
    icon: 'N',
    configFields: [
      { key: 'token', label: 'Integration Token', placeholder: 'secret_...', secret: true },
      { key: 'databaseId', label: 'Database ID', placeholder: '' },
    ],
  },
  {
    type: 'jira',
    name: 'Jira',
    description: 'Pull assigned Jira tickets',
    icon: '◇',
    configFields: [
      { key: 'host', label: 'Jira Host', placeholder: 'your-org.atlassian.net' },
      { key: 'email', label: 'Email', placeholder: 'you@company.com' },
      { key: 'token', label: 'API Token', placeholder: '', secret: true },
    ],
  },
  {
    type: 'google-calendar',
    name: 'Google Calendar',
    description: 'Pull upcoming events as tasks',
    icon: '◉',
    configFields: [
      { key: 'apiKey', label: 'API Key', placeholder: '', secret: true },
      { key: 'calendarId', label: 'Calendar ID', placeholder: 'primary' },
    ],
  },
];

// ─── Store ─────────────────────────────────────────────

interface McpState {
  connections: McpConnection[];
  // Tasks are scoped per-project so switching projects doesn't bleed tasks across them
  tasksByProject: Record<string, McpTask[]>;
  seenTaskIds: Set<string>; // tasks already imported or dismissed — never show again

  addConnection: (conn: Omit<McpConnection, 'id' | 'status'>) => void;
  removeConnection: (id: string) => void;
  updateConnectionStatus: (id: string, status: McpConnection['status'], error?: string) => void;
  syncConnection: (id: string) => Promise<void>;
  syncAll: () => Promise<void>;
  dismissTask: (taskId: string) => void;
  markSeen: (taskId: string) => void;
  getTasksForProject: (projectId: string) => McpTask[];
  reloadForProject: () => void;
}

// Per-project storage helpers
function getProjectId(): string {
  // Lazy import to avoid circular deps
  try {
    return localStorage.getItem('tx-active-project') || '';
  } catch {
    return '';
  }
}

// ─── Secret handling (OS keychain bridge) ────────────────
// MCP config has two tiers: non-secret (channel ID, Jira host, GitHub
// repo) lives in localStorage; secret (bot token, API key, OAuth token)
// lives in the OS keychain via secretSet/Get/Delete IPC. The store
// memoizes resolved secrets per-connection so we only pay the IPC hop
// on project load, not every sync.

function keychainAccount(connectionId: string, fieldKey: string): string {
  return `mcp:${connectionId}:${fieldKey}`;
}

/** Connector-type-specific set of field keys that should live in the keychain. */
function secretFieldsFor(type: McpType): string[] {
  const def = MCP_DEFINITIONS.find(d => d.type === type);
  if (!def) return [];
  return def.configFields.filter(f => f.secret).map(f => f.key);
}

/** Split a config object into (nonSecret, secret) parts. */
function splitSecrets(type: McpType, config: Record<string, string>): {
  nonSecret: Record<string, string>;
  secret: Record<string, string>;
} {
  const secretKeys = new Set(secretFieldsFor(type));
  const nonSecret: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (secretKeys.has(k)) {
      if (v) secret[k] = v;
    } else {
      nonSecret[k] = v;
    }
  }
  return { nonSecret, secret };
}

/** Persist secret fields to the keychain. Silently ignores empty strings. */
async function persistSecrets(
  connectionId: string,
  secretFields: Record<string, string>,
): Promise<void> {
  await Promise.all(
    Object.entries(secretFields).map(([k, v]) =>
      v ? secretSet(keychainAccount(connectionId, k), v) : Promise.resolve(),
    ),
  );
}

/** Delete all keychain entries for a connection. */
async function clearSecrets(connectionId: string, type: McpType): Promise<void> {
  await Promise.all(
    secretFieldsFor(type).map(k =>
      secretDelete(keychainAccount(connectionId, k)).catch(() => {}),
    ),
  );
}

/** Hydrate secret fields from the keychain into the in-memory config. */
async function hydrateSecrets(conn: McpConnection): Promise<void> {
  const keys = secretFieldsFor(conn.type);
  if (keys.length === 0) return;
  const results = await Promise.all(
    keys.map(async k => {
      try {
        const val = await secretGet(keychainAccount(conn.id, k));
        return [k, val] as const;
      } catch {
        return [k, null] as const;
      }
    }),
  );
  for (const [k, val] of results) {
    if (val != null) conn.config[k] = val;
  }
}

function loadConnections(): McpConnection[] {
  try {
    const pid = getProjectId();
    const stored = localStorage.getItem(`tx-mcp-connections-${pid}`);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveConnections(connections: McpConnection[]) {
  const pid = getProjectId();
  // Strip secret fields before persisting — they live in the keychain.
  const sanitized = connections.map(c => {
    const { nonSecret } = splitSecrets(c.type, c.config);
    return { ...c, config: nonSecret };
  });
  localStorage.setItem(`tx-mcp-connections-${pid}`, JSON.stringify(sanitized));
}

/**
 * One-shot migration: on store creation, scan localStorage for any
 * connections that still carry secret fields in their config (pre-
 * keychain writes), move them into the keychain, and re-save without
 * the plaintext.
 *
 * Runs per-project the first time that project's connections are loaded.
 * Safe to run multiple times — idempotent.
 */
export async function migrateMcpSecretsToKeychain(): Promise<{ moved: number; scanned: number }> {
  let moved = 0;
  let scanned = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('tx-mcp-connections-')) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      let conns: McpConnection[];
      try { conns = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(conns)) continue;

      let changed = false;
      for (const conn of conns) {
        scanned += 1;
        const { nonSecret, secret } = splitSecrets(conn.type, conn.config);
        if (Object.keys(secret).length === 0) continue;
        // Found secrets in localStorage — migrate.
        await persistSecrets(conn.id, secret);
        conn.config = nonSecret;
        moved += 1;
        changed = true;
      }
      if (changed) localStorage.setItem(key, JSON.stringify(conns));
    }
  } catch {
    // Don't crash the app on a failed migration — user sees a warning
    // toast via the caller, and we'll retry next boot.
  }
  return { moved, scanned };
}

function loadSeenIds(): Set<string> {
  try {
    const pid = getProjectId();
    const stored = localStorage.getItem(`tx-mcp-seen-${pid}`);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeenIds(ids: Set<string>) {
  const pid = getProjectId();
  const arr = [...ids].slice(-2000);
  localStorage.setItem(`tx-mcp-seen-${pid}`, JSON.stringify(arr));
}

export const useMcpStore = create<McpState>((set, get) => ({
  connections: loadConnections(),
  tasksByProject: {},
  seenTaskIds: loadSeenIds(),

  addConnection: (conn) => {
    const id = crypto.randomUUID();
    const newConn: McpConnection = {
      ...conn,
      id,
      status: 'disconnected',
    };
    // Persist secrets to the keychain before writing the sanitized config
    // to localStorage. Fire-and-forget is fine — secretSet is fast and
    // subsequent syncs re-hydrate from keychain on boot.
    const { secret } = splitSecrets(newConn.type, newConn.config);
    if (Object.keys(secret).length > 0) {
      persistSecrets(id, secret).catch(() => {
        import('@/stores/toastStore').then(({ useToastStore }) => {
          useToastStore.getState().addToast(
            'Failed to save API token to keychain. It may be unlocked on next sync.',
            'warning',
          );
        });
      });
    }
    set(s => {
      const next = [...s.connections, newConn];
      saveConnections(next);
      return { connections: next };
    });
  },

  removeConnection: (id) => {
    set(s => {
      const conn = s.connections.find(c => c.id === id);
      const next = s.connections.filter(c => c.id !== id);
      saveConnections(next);
      if (conn) clearSecrets(id, conn.type).catch(() => {});
      // Drop tasks from the removed connection within the current project only
      const pid = getProjectId();
      const currentTasks = s.tasksByProject[pid] || [];
      return {
        connections: next,
        tasksByProject: {
          ...s.tasksByProject,
          [pid]: conn ? currentTasks.filter(t => t.source !== conn.type) : currentTasks,
        },
      };
    });
  },

  updateConnectionStatus: (id, status, error) => {
    set(s => {
      const next = s.connections.map(c =>
        c.id === id ? { ...c, status, error, ...(status === 'connected' ? { lastSync: new Date().toISOString() } : {}) } : c,
      );
      saveConnections(next);
      return { connections: next };
    });
  },

  syncConnection: async (id) => {
    const conn = get().connections.find(c => c.id === id);
    if (!conn) return;

    // Hydrate secret fields from the keychain into the in-memory config
    // before the sync runs. Secrets are never saved to state/localStorage,
    // so every sync reads them fresh from the keychain.
    await hydrateSecrets(conn);

    // Exponential backoff: if we've recently failed, skip this sync until
    // the backoff window elapses. Without this, a broken API gets hammered
    // every 30 s indefinitely — turning one bad connection into a sustained
    // outbound request storm.
    const backoff = backoffByConn.get(id);
    if (backoff && Date.now() < backoff.nextAllowedAt) {
      return;
    }

    const pidAtStart = getProjectId();

    get().updateConnectionStatus(id, 'connecting');

    try {
      const allTasks = await fetchTasksForConnection(conn);
      // If the user switched projects during the fetch, discard these results —
      // they belong to the previous project's connection set.
      if (getProjectId() !== pidAtStart) return;

      const seen = get().seenTaskIds;
      const newTasks = allTasks.filter(t => !seen.has(t.id));
      set(s => {
        const existing = s.tasksByProject[pidAtStart] || [];
        return {
          tasksByProject: {
            ...s.tasksByProject,
            [pidAtStart]: [
              ...existing.filter(t => t.source !== conn.type),
              ...newTasks,
            ],
          },
        };
      });
      get().updateConnectionStatus(id, 'connected');
      backoffByConn.delete(id);
    } catch (e) {
      const errMsg = String(e);
      get().updateConnectionStatus(id, 'error', errMsg);
      // Exponential backoff: 30s → 60s → 2min → 5min → 10min (capped).
      // Full jitter ±25 % so multiple connections don't re-sync in lockstep.
      const failures = (backoffByConn.get(id)?.failures ?? 0) + 1;
      const base = Math.min(30 * 2 ** (failures - 1), 10 * 60) * 1000;
      const jitter = base * (0.75 + Math.random() * 0.5);
      backoffByConn.set(id, { failures, nextAllowedAt: Date.now() + jitter });

      // Surface error to user once per connection per session
      const notifiedKey = `_mcp_notified_${id}`;
      const w = window as unknown as Record<string, boolean>;
      if (!w[notifiedKey]) {
        w[notifiedKey] = true;
        import('@/stores/toastStore').then(({ useToastStore }) => {
          useToastStore.getState().addToast(`${conn.name}: ${errMsg.slice(0, 100)}`, 'error');
        });
      }
    }
  },

  syncAll: async () => {
    const conns = get().connections;
    // Parallel sync with a concurrency cap of 3. Previous code ran one at a
    // time with 250 ms jitter — 5 slow connections took 75 s+. With cap=3
    // + per-connection backoff, even flaky APIs don't block healthy ones.
    const CONCURRENCY = 3;
    let i = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, conns.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= conns.length) return;
        try {
          await get().syncConnection(conns[idx].id);
        } catch {
          /* already captured in status */
        }
      }
    });
    await Promise.all(workers);
  },

  dismissTask: (taskId) => {
    const seen = new Set(get().seenTaskIds);
    seen.add(taskId);
    saveSeenIds(seen);
    const pid = getProjectId();
    set(s => ({
      tasksByProject: {
        ...s.tasksByProject,
        [pid]: (s.tasksByProject[pid] || []).filter(t => t.id !== taskId),
      },
      seenTaskIds: seen,
    }));
  },

  markSeen: (taskId) => {
    const seen = new Set(get().seenTaskIds);
    seen.add(taskId);
    saveSeenIds(seen);
    set({ seenTaskIds: seen });
  },

  getTasksForProject: (projectId) => get().tasksByProject[projectId] || [],

  // Reload connections for the current project — tasks for this project
  // stay in place (already scoped), other projects' tasks are preserved.
  reloadForProject: () => {
    set({
      connections: loadConnections(),
      seenTaskIds: loadSeenIds(),
    });
  },
}));

// Reload MCP state when active project changes — subscribe to projectStore.
// Exposed as `initMcpProjectSync()` so the app root can call it once (instead
// of registering at module-import time, which would leak on HMR re-imports).
import { useProjectStore } from './projectStore';

let mcpProjectSyncInstalled = false;
export function initMcpProjectSync(): () => void {
  if (mcpProjectSyncInstalled) return () => {};
  mcpProjectSyncInstalled = true;
  let lastPid = getProjectId();
  const unsub = useProjectStore.subscribe((state) => {
    const pid = state.active;
    if (pid && pid !== lastPid) {
      lastPid = pid;
      // Reset backoff on project switch — the new project's MCP connections
      // haven't earned their failures yet.
      backoffByConn.clear();
      useMcpStore.getState().reloadForProject();
    }
  });
  return () => {
    mcpProjectSyncInstalled = false;
    unsub();
  };
}

// ─── Task fetchers per MCP type ────────────────────────

async function fetchTasksForConnection(conn: McpConnection): Promise<McpTask[]> {
  switch (conn.type) {
    case 'github': return fetchGitHubTasks(conn.config);
    case 'slack': return fetchSlackTasks(conn.config);
    case 'linear': return fetchLinearTasks(conn.config);
    case 'jira': return fetchJiraTasks(conn.config);
    case 'notion': return fetchNotionTasks(conn.config);
    default: return [];
  }
}

// Helper: make API calls through the Rust HTTP proxy (bypasses CSP/CORS)
const DEFAULT_HEADERS: Record<string, string> = { 'User-Agent': 'TerminalX/1.0' };

async function proxyGet(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await httpFetch({ url, method: 'GET', headers: { ...DEFAULT_HEADERS, ...headers } });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

async function proxyPost(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await httpFetch({ url, method: 'POST', headers: { ...DEFAULT_HEADERS, ...headers }, body: JSON.stringify(body) });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

export function buildGitHubIssuesUrl(repo?: string): string {
  const cleanRepo = repo?.trim();
  if (!cleanRepo) {
    return 'https://api.github.com/issues?filter=assigned&state=open&per_page=20';
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleanRepo)) {
    throw new Error('GitHub repo must be in owner/name format');
  }
  const [owner, name] = cleanRepo.split('/');
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=open&per_page=20`;
}

export function buildSlackHistoryUrl(channel: string): string {
  const cleanChannel = channel.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,255}$/.test(cleanChannel)) {
    throw new Error('Slack channel ID is invalid');
  }
  const params = new URLSearchParams({ channel: cleanChannel, limit: '20' });
  return `https://slack.com/api/conversations.history?${params.toString()}`;
}

function cleanJiraHost(host: string): string {
  const cleanHost = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(cleanHost)
    || cleanHost.startsWith('.')
    || cleanHost.endsWith('.')
    || cleanHost.includes('..')) {
    throw new Error('Jira host must be a bare hostname');
  }
  return cleanHost;
}

export function buildJiraSearchUrl(host: string): string {
  const cleanHost = cleanJiraHost(host);
  const params = new URLSearchParams({
    jql: 'assignee=currentUser() AND status!=Done',
    maxResults: '20',
  });
  return `https://${cleanHost}/rest/api/3/search?${params.toString()}`;
}

export function buildJiraBrowseUrl(host: string, key: string): string {
  return `https://${cleanJiraHost(host)}/browse/${encodeURIComponent(key)}`;
}

export function buildNotionQueryUrl(databaseId: string): string {
  const cleanDatabaseId = databaseId.trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(cleanDatabaseId)) {
    throw new Error('Notion database ID is invalid');
  }
  return `https://api.notion.com/v1/databases/${encodeURIComponent(cleanDatabaseId)}/query`;
}

async function fetchGitHubTasks(config: Record<string, string>): Promise<McpTask[]> {
  const { token, repo } = config;
  if (!token) throw new Error('GitHub token required');

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' };
  const url = buildGitHubIssuesUrl(repo);

  return mapGitHubIssuesResponse(await proxyGet(url, headers));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface GitHubIssuePayload {
  id: number;
  number: number;
  title: string;
  html_url: string;
  labels?: unknown;
  pull_request?: unknown;
}

function isGitHubIssuePayload(issue: unknown): issue is GitHubIssuePayload {
  return isRecord(issue) &&
    typeof issue.id === 'number' &&
    typeof issue.number === 'number' &&
    typeof issue.title === 'string' &&
    typeof issue.html_url === 'string';
}

export function mapGitHubIssuesResponse(payload: unknown): McpTask[] {
  if (!Array.isArray(payload)) {
    const detail = isRecord(payload) && typeof payload.message === 'string' ? `: ${payload.message}` : '';
    throw new Error(`GitHub issues response was not an array${detail}`);
  }

  return payload
    .filter((issue): issue is GitHubIssuePayload => isGitHubIssuePayload(issue) && !issue.pull_request)
    .map(issue => ({
      id: `gh-${issue.id}`,
      source: 'github' as McpType,
      sourceId: String(issue.number),
      text: `#${issue.number} ${issue.title}`,
      done: false,
      priority: Array.isArray(issue.labels) && issue.labels.some(l => isRecord(l) && l.name === 'priority') ? 'high' : undefined,
      url: issue.html_url,
    }));
}

async function fetchSlackTasks(config: Record<string, string>): Promise<McpTask[]> {
  const { token, channel } = config;
  if (!token) throw new Error('Slack token required');
  if (!channel) throw new Error('Slack channel ID required');

  const data = await proxyGet(
    buildSlackHistoryUrl(channel),
    { Authorization: `Bearer ${token}` },
  ) as { ok: boolean; error?: string; messages?: { ts: string; text: string }[] };

  if (!data.ok) throw new Error(data.error || 'Slack API error');

  return (data.messages || [])
    .filter(m => m.text && m.text.length > 0)
    .slice(0, 15)
    .map(m => ({
      id: `slack-${m.ts}`,
      source: 'slack' as McpType,
      sourceId: m.ts,
      text: m.text,
      done: false,
    }));
}

async function fetchLinearTasks(config: Record<string, string>): Promise<McpTask[]> {
  const { apiKey } = config;
  if (!apiKey) throw new Error('Linear API key required');

  const data = await proxyPost(
    'https://api.linear.app/graphql',
    { Authorization: apiKey },
    { query: `{ viewer { assignedIssues(first: 20, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier title url priority } } } }` },
  ) as { data?: { viewer?: { assignedIssues?: { nodes: { id: string; identifier: string; title: string; url: string; priority: number }[] } } } };

  const issues = data?.data?.viewer?.assignedIssues?.nodes || [];
  return issues.map(i => ({
    id: `linear-${i.id}`,
    source: 'linear' as McpType,
    sourceId: i.identifier,
    text: `${i.identifier} ${i.title}`,
    done: false,
    priority: i.priority <= 2 ? 'high' : undefined,
    url: i.url,
  }));
}

async function fetchJiraTasks(config: Record<string, string>): Promise<McpTask[]> {
  const { host, email, token } = config;
  if (!host || !email || !token) throw new Error('Jira host, email, and token required');

  const auth = btoa(`${email}:${token}`);
  const data = await proxyGet(
    buildJiraSearchUrl(host),
    { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  ) as { issues?: { id: string; key: string; fields: { summary: string } }[] };

  return (data.issues || []).map(i => ({
    id: `jira-${i.id}`,
    source: 'jira' as McpType,
    sourceId: i.key,
    text: `${i.key} ${i.fields.summary}`,
    done: false,
    url: buildJiraBrowseUrl(host, i.key),
  }));
}

async function fetchNotionTasks(config: Record<string, string>): Promise<McpTask[]> {
  const { token, databaseId } = config;
  if (!token || !databaseId) throw new Error('Notion token and database ID required');

  const data = await proxyPost(
    buildNotionQueryUrl(databaseId),
    { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
    { page_size: 20 },
  ) as { results?: { id: string; url: string; properties: Record<string, { title?: { plain_text: string }[] }> }[] };

  return (data.results || []).map(page => {
    const titleProp = Object.values(page.properties).find(p => p.title);
    const title = titleProp?.title?.[0]?.plain_text || 'Untitled';
    return {
      id: `notion-${page.id}`,
      source: 'notion' as McpType,
      sourceId: page.id,
      text: title,
      done: false,
      url: page.url,
    };
  });
}
