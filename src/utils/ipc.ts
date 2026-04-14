import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Tile, Wire, TimelineEvent, TimelineEventType } from '@/types';

// ─── Terminal / PTY ───────────────────────────────────────────────────

export async function ptySpawn(opts: {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  args?: string[];
}): Promise<string> {
  return invoke('pty_spawn', opts);
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke('pty_write', { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke('pty_resize', { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  return invoke('pty_kill', { id });
}

interface PtyOutputPayload {
  id: string;
  data: string;
}

export async function onPtyOutput(
  callback: (event: PtyOutputPayload) => void
): Promise<UnlistenFn> {
  return listen<PtyOutputPayload>('pty-output', (event) => callback(event.payload));
}

export async function onPtyExit(
  callback: (id: string) => void
): Promise<UnlistenFn> {
  return listen<string>('pty-exit', (event) => callback(event.payload));
}

// ─── Agents ───────────────────────────────────────────────────────────

export type AgentType = 'Claude' | 'Codex' | 'Gemini';

export async function agentSpawn(opts: {
  agentType: AgentType;
  cwd: string;
  task?: string;
  customCommand?: string;
}): Promise<string> {
  return invoke('agent_spawn', {
    agentType: opts.agentType,
    cwd: opts.cwd,
    task: opts.task,
    customCommand: opts.customCommand,
  });
}

export async function agentKill(id: string): Promise<void> {
  return invoke('agent_kill', { id });
}

interface AgentInfo {
  id: string;
  agent_type: string;
  status: string;
  cwd: string;
  pid: number | null;
  uptime_secs: number;
}

export async function agentList(): Promise<AgentInfo[]> {
  return invoke('agent_list');
}

interface AgentStatusPayload {
  id: string;
  status: string;
}

export async function onAgentStatus(
  callback: (event: AgentStatusPayload) => void
): Promise<UnlistenFn> {
  return listen<AgentStatusPayload>('agent-status', (event) => callback(event.payload));
}

// ─── Filesystem ───────────────────────────────────────────────────────

export interface FileTreeNode {
  name: string;
  path: string;
  node_type: 'File' | 'Directory';
  children: FileTreeNode[] | null;
}

export async function readFileTree(
  path: string,
  maxDepth?: number
): Promise<FileTreeNode[]> {
  return invoke('read_file_tree', { path, maxDepth });
}

export async function watchDirectory(path: string): Promise<void> {
  return invoke('watch_directory', { path });
}

export async function unwatchDirectory(path: string): Promise<void> {
  return invoke('unwatch_directory', { path });
}

export async function onFsChange(
  callback: (event: string) => void
): Promise<UnlistenFn> {
  return listen<string>('fs-change', (event) => callback(event.payload));
}

// ─── Workspace ────────────────────────────────────────────────────────

interface WorkspaceState {
  projectId: string;
  tiles: Tile[];
  wires: Wire[];
  transform: { x: number; y: number; scale: number };
  updatedAt: string;
}

export async function saveWorkspace(state: {
  projectId: string;
  tiles: Tile[];
  wires: Wire[];
  transform: { x: number; y: number; scale: number };
}): Promise<void> {
  return invoke('save_workspace', {
    state: { ...state, updatedAt: new Date().toISOString() },
  });
}

export async function loadWorkspace(
  projectId: string
): Promise<WorkspaceState | null> {
  return invoke('load_workspace', { projectId });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function saveSnapshot(
  projectId: string,
  name: string,
  state: any
): Promise<void> {
  return invoke('save_snapshot', { projectId, name, state });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadSnapshot(
  projectId: string,
  name: string
): Promise<any> {
  return invoke('load_snapshot', { projectId, name });
}

export async function deleteSnapshot(projectId: string, name: string): Promise<void> {
  return invoke('delete_snapshot', { projectId, name });
}

export async function listSnapshots(projectId: string): Promise<string[]> {
  return invoke('list_snapshots', { projectId });
}

// ─── Timeline ─────────────────────────────────────────────────────────

export async function recordEvent(opts: {
  eventType: TimelineEventType;
  tileId?: string;
  agentId?: string;
  summary: string;
  detail?: string;
}): Promise<string> {
  return invoke('record_event', opts);
}

export async function getTimeline(limit?: number): Promise<TimelineEvent[]> {
  return invoke('get_timeline', { limit });
}

export async function clearTimeline(): Promise<void> {
  return invoke('clear_timeline');
}

// ─── Projects ────────────────────────────────────────────────────────

export interface ProjectData {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  cwd: string;
  git_url?: string;
  branch?: string;
}

export async function loadProjects(): Promise<ProjectData[]> {
  return invoke('load_projects');
}

export async function saveProjects(projects: ProjectData[]): Promise<void> {
  return invoke('save_projects', { projects });
}

export async function addProjectToStore(project: ProjectData): Promise<void> {
  return invoke('add_project', { project });
}

export async function deleteProjectFromStore(id: string): Promise<void> {
  return invoke('delete_project', { id });
}

// ─── Git ─────────────────────────────────────────────────────────────

export async function gitAvailable(): Promise<boolean> {
  return invoke('git_available');
}

export async function gitClone(url: string, dest: string): Promise<void> {
  return invoke('git_clone', { url, dest });
}

export async function gitStatus(repoPath: string): Promise<{ branch: string; dirty: boolean; ahead: number; behind: number }> {
  return invoke('git_status', { repoPath });
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

export async function gitLog(repoPath: string, limit?: number): Promise<GitLogEntry[]> {
  return invoke('git_log', { repoPath, limit });
}

export async function gitBranches(repoPath: string): Promise<string[]> {
  return invoke('git_branches', { repoPath });
}

export async function gitCheckout(repoPath: string, branch: string): Promise<void> {
  return invoke('git_checkout', { repoPath, branch });
}

export async function gitDiffSummary(repoPath: string): Promise<string> {
  return invoke('git_diff_summary', { repoPath });
}

export async function gitFilesStatus(repoPath: string): Promise<GitFileStatus[]> {
  return invoke('git_files_status', { repoPath });
}

export async function gitStage(repoPath: string, path: string): Promise<void> {
  return invoke('git_stage', { repoPath, path });
}

export async function gitUnstage(repoPath: string, path: string): Promise<void> {
  return invoke('git_unstage', { repoPath, path });
}

export async function gitCommit(repoPath: string, message: string): Promise<string> {
  return invoke('git_commit', { repoPath, message });
}

// ─── HTTP Proxy (for MCP API calls) ─────────────────────────

export interface ProxyResponse {
  status: number;
  body: string;
}

// ─── Docker ──────────────────────────────────────────────────

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
}

export async function dockerAvailable(): Promise<boolean> {
  return invoke('docker_available');
}

export async function dockerListContainers(): Promise<DockerContainerInfo[]> {
  return invoke('docker_list_containers');
}

// ─── HTTP Proxy (for MCP API calls) ─────────────────────────

export async function httpFetch(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<ProxyResponse> {
  return invoke('http_fetch', { req: opts });
}
