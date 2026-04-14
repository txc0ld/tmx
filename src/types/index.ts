// ─── Tile Types ───────────────────────────────────────────────────────

export type TileType = 'agent' | 'terminal' | 'browser' | 'todo' | 'diff' | 'editor' | 'note' | 'kanban' | 'filetree' | 'group' | 'runner' | 'ssh' | 'docker' | 'git' | 'usage';
export type AgentType = 'claude' | 'codex' | 'gemini';
export type AgentStatus = 'spawning' | 'idle' | 'working' | 'done' | 'error';

export interface TileBase {
  id: string;
  type: TileType;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
}

export interface AgentTile extends TileBase {
  type: 'agent';
  agent: AgentType;
  model: string;
  effort: string;
  mode: string;
  version: string;
  cwd: string;
  branch: string;
  status: AgentStatus;
  ptyId?: string;
  elapsed: number;
  command?: string;
}

export interface TerminalTile extends TileBase {
  type: 'terminal';
  cwd: string;
  branch: string;
  node: string;
  ptyId?: string;
  splits?: TerminalSplit[];
}

export interface TerminalSplit {
  id: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  ptyId: string;
}

export interface BrowserTile extends TileBase {
  type: 'browser';
  url: string;
}

export interface TodoTile extends TileBase {
  type: 'todo';
  items: TodoItem[];
  autoDispatch?: boolean; // auto-send new MCP tasks to a connected agent
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  assignedAgent?: string;
}

export interface DiffTile extends TileBase {
  type: 'diff';
  filePath: string;
  hunks: DiffHunk[];
  comments: DiffComment[];
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
}

export interface DiffComment {
  id: string;
  line: number;
  text: string;
  resolved: boolean;
}

export interface EditorTile extends TileBase {
  type: 'editor';
  filePath: string;
  language: string;
}

export interface NoteTile extends TileBase {
  type: 'note';
  content: string; // Markdown
}

export interface KanbanTile extends TileBase {
  type: 'kanban';
  columns: KanbanColumn[];
}

export interface KanbanColumn {
  id: string;
  title: string;
  items: KanbanItem[];
}

export interface KanbanItem {
  id: string;
  text: string;
  color?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  node_type: 'File' | 'Directory';
  children?: FileTreeNode[];
}

export interface FileTreeTile extends TileBase {
  type: 'filetree';
  rootPath: string;
  expandedPaths: string[];
  selectedFile?: string;
}

export interface GroupTile extends TileBase {
  type: 'group';
  label: string;
  childTileIds: string[];
  collapsed: boolean;
}

export type RunnerStatus = 'idle' | 'running' | 'pass' | 'fail';

export interface RunnerTile extends TileBase {
  type: 'runner';
  command: string;
  cwd: string;
  status: RunnerStatus;
  lastOutput: string;
  ptyId?: string;
}

export interface SshTile extends TileBase {
  type: 'ssh';
  host: string;
  port: number;
  user: string;
  ptyId?: string;
  connected: boolean;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
}

export interface DockerTile extends TileBase {
  type: 'docker';
  containers: DockerContainer[];
  selectedContainer?: string;
  ptyId?: string;
}

export interface GitTile extends TileBase {
  type: 'git';
  repoPath: string;
}

export interface UsageTile extends TileBase {
  type: 'usage';
}

export type Tile = AgentTile | TerminalTile | BrowserTile | TodoTile | DiffTile | EditorTile | NoteTile | KanbanTile | FileTreeTile | GroupTile | RunnerTile | SshTile | DockerTile | GitTile | UsageTile;

// ─── Project ──────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  cwd: string;
  gitUrl?: string;
  branch?: string;
}

// ─── Wiring ───────────────────────────────────────────────────────────

export type WireType = 'context-pipe' | 'refresh-trigger' | 'task-assign' | 'diff-feed' | 'agent-chain';

export interface Wire {
  id: string;
  fromTile: string;
  fromPort: 'output' | 'stdout' | 'complete';
  toTile: string;
  toPort: 'input' | 'context' | 'trigger';
  wireType: WireType;
  active: boolean;
}

// ─── Timeline ─────────────────────────────────────────────────────────

export type TimelineEventType =
  | 'command-executed'
  | 'file-modified'
  | 'agent-prompt'
  | 'agent-complete'
  | 'build-result'
  | 'git-operation'
  | 'wire-triggered'
  | 'snapshot-saved';

export interface TimelineEvent {
  id: string;
  timestamp: string;
  eventType: TimelineEventType;
  tileId?: string;
  agentId?: string;
  summary: string;
  detail?: string;
}

// ─── Canvas ───────────────────────────────────────────────────────────

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

export interface WorkspaceSnapshot {
  name: string;
  tiles: Tile[];
  wires: Wire[];
  transform: CanvasTransform;
  zStack?: string[];
  createdAt: string;
}

// ─── Command Palette ──────────────────────────────────────────────────

export interface PaletteAction {
  id: string;
  label: string;
  category: 'project' | 'tile' | 'command' | 'navigate' | 'workspace';
  icon?: string;
  shortcut?: string;
  action: () => void;
}
