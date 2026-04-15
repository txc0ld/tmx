import { create } from 'zustand';
import { httpFetch } from '@/utils/ipc';

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
  tasks: McpTask[];
  seenTaskIds: Set<string>; // tasks already imported or dismissed — never show again

  addConnection: (conn: Omit<McpConnection, 'id' | 'status'>) => void;
  removeConnection: (id: string) => void;
  updateConnectionStatus: (id: string, status: McpConnection['status'], error?: string) => void;
  syncConnection: (id: string) => Promise<void>;
  syncAll: () => Promise<void>;
  dismissTask: (taskId: string) => void;
  markSeen: (taskId: string) => void;
  getTasks: () => McpTask[];
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
  localStorage.setItem(`tx-mcp-connections-${pid}`, JSON.stringify(connections));
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
  tasks: [],
  seenTaskIds: loadSeenIds(),

  addConnection: (conn) => {
    set(s => {
      const newConn: McpConnection = {
        ...conn,
        id: crypto.randomUUID(),
        status: 'disconnected',
      };
      const next = [...s.connections, newConn];
      saveConnections(next);
      return { connections: next };
    });
  },

  removeConnection: (id) => {
    set(s => {
      const next = s.connections.filter(c => c.id !== id);
      saveConnections(next);
      return {
        connections: next,
        tasks: s.tasks.filter(t => {
          const conn = s.connections.find(c => c.id === id);
          return !conn || t.source !== conn.type;
        }),
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

    get().updateConnectionStatus(id, 'connecting');

    try {
      const allTasks = await fetchTasksForConnection(conn);
      const seen = get().seenTaskIds;
      // Only keep tasks we haven't seen before
      const newTasks = allTasks.filter(t => !seen.has(t.id));
      set(s => ({
        tasks: [
          ...s.tasks.filter(t => t.source !== conn.type),
          ...newTasks,
        ],
      }));
      get().updateConnectionStatus(id, 'connected');
    } catch (e) {
      get().updateConnectionStatus(id, 'error', String(e));
    }
  },

  syncAll: async () => {
    const conns = get().connections;
    // Sequential with small jitter to avoid hammering all APIs simultaneously
    for (const c of conns) {
      try {
        await get().syncConnection(c.id);
      } catch { /* already captured in status */ }
      await new Promise(r => setTimeout(r, 250));
    }
  },

  dismissTask: (taskId) => {
    const seen = new Set(get().seenTaskIds);
    seen.add(taskId);
    saveSeenIds(seen);
    set(s => ({ tasks: s.tasks.filter(t => t.id !== taskId), seenTaskIds: seen }));
  },

  markSeen: (taskId) => {
    const seen = new Set(get().seenTaskIds);
    seen.add(taskId);
    saveSeenIds(seen);
    set({ seenTaskIds: seen });
  },

  getTasks: () => get().tasks,

  // Reload connections for the current project
  reloadForProject: () => {
    set({
      connections: loadConnections(),
      seenTaskIds: loadSeenIds(),
      tasks: [],
    });
  },
}));

// Reload MCP state when active project changes — subscribe to projectStore
import { useProjectStore } from './projectStore';

let lastPid = getProjectId();
useProjectStore.subscribe((state) => {
  const pid = state.active;
  if (pid && pid !== lastPid) {
    lastPid = pid;
    useMcpStore.getState().reloadForProject();
  }
});

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

async function fetchGitHubTasks(config: Record<string, string>): Promise<McpTask[]> {
  const { token, repo } = config;
  if (!token) throw new Error('GitHub token required');

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' };
  const url = repo
    ? `https://api.github.com/repos/${repo}/issues?state=open&per_page=20`
    : `https://api.github.com/issues?filter=assigned&state=open&per_page=20`;

  const issues = await proxyGet(url, headers) as { id: number; number: number; title: string; html_url: string; labels: { name: string }[]; pull_request?: unknown }[];

  return issues
    .filter(issue => !issue.pull_request)
    .map(issue => ({
      id: `gh-${issue.id}`,
      source: 'github' as McpType,
      sourceId: String(issue.number),
      text: `#${issue.number} ${issue.title}`,
      done: false,
      priority: issue.labels?.some(l => l.name === 'priority') ? 'high' : undefined,
      url: issue.html_url,
    }));
}

async function fetchSlackTasks(config: Record<string, string>): Promise<McpTask[]> {
  const { token, channel } = config;
  if (!token) throw new Error('Slack token required');
  if (!channel) throw new Error('Slack channel ID required');

  const data = await proxyGet(
    `https://slack.com/api/conversations.history?channel=${channel}&limit=20`,
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
    `https://${host}/rest/api/3/search?jql=assignee=currentUser() AND status!=Done&maxResults=20`,
    { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  ) as { issues?: { id: string; key: string; fields: { summary: string } }[] };

  return (data.issues || []).map(i => ({
    id: `jira-${i.id}`,
    source: 'jira' as McpType,
    sourceId: i.key,
    text: `${i.key} ${i.fields.summary}`,
    done: false,
    url: `https://${host}/browse/${i.key}`,
  }));
}

async function fetchNotionTasks(config: Record<string, string>): Promise<McpTask[]> {
  const { token, databaseId } = config;
  if (!token || !databaseId) throw new Error('Notion token and database ID required');

  const data = await proxyPost(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
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
