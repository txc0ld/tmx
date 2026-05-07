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

export async function readFileText(path: string): Promise<string> {
  return invoke('read_file_text', { path });
}

export async function writeFileText(path: string, contents: string): Promise<void> {
  return invoke('write_file_text', { path, contents });
}

export async function getFileSize(path: string): Promise<number> {
  return invoke('get_file_size', { path });
}

// ─── OS keychain — sensitive value storage ────────────────
// Never stores the value in localStorage. Use for API tokens, OAuth
// secrets, anything you'd redact in a log. Account convention:
// `<scope>:<subject>:<field>` — e.g. `mcp:<connection-id>:token`.
export async function secretSet(account: string, value: string): Promise<void> {
  return invoke('secret_set', { account, value });
}

export async function secretGet(account: string): Promise<string | null> {
  return invoke('secret_get', { account });
}

export async function secretDelete(account: string): Promise<void> {
  return invoke('secret_delete', { account });
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
  webhook_url?: string;
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

export async function updateProjectInStore(project: ProjectData): Promise<void> {
  return invoke('update_project', { project });
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

export async function gitShowHeadFile(repoPath: string, filePath: string): Promise<string> {
  return invoke('git_show_head_file', { repoPath, filePath });
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

// ─── Pipeline (Phase 1) ───────────────────────────────────────

export interface PreflightResult {
  is_git_repo: boolean;
  working_tree_clean: boolean;
  main_branch: string | null;
  claude_present: boolean;
  codex_present: boolean;
  gh_present: boolean;
  gh_authenticated: boolean;
  worktree_dir_writable: boolean;
  // 2c-ii.6 additions (kept at end so older deserializers stay compat).
  signed_skills_ok: boolean;
  capability_binaries_ok: boolean;
  skill_cache_writable: boolean;
  // 2c-iii.6: project-relative paths matching the sensitive-file pattern
  // set (.env, *.pem, id_rsa, etc.). Capped at 50 entries server-side.
  sensitive_paths_found: string[];
  errors: string[];
}

export interface WorktreeCreateResult {
  path: string;
  branch: string;
}

export interface InstallSkillsResult {
  skills_dir: string;
  installed: string[];
  already_present: string[];
  errors: string[];
  stub: boolean;
}

export async function pipelinePreflight(projectDir: string): Promise<PreflightResult> {
  return invoke<PreflightResult>('pipeline_preflight', { projectDir });
}

export async function pipelineWorktreeCreate(opts: {
  projectDir: string;
  branch: string;
  worktreePath: string;
  baseBranch?: string;
}): Promise<WorktreeCreateResult> {
  return invoke<WorktreeCreateResult>('pipeline_worktree_create', {
    projectDir: opts.projectDir,
    branch: opts.branch,
    worktreePath: opts.worktreePath,
    baseBranch: opts.baseBranch ?? null,
  });
}

export async function pipelineWorktreeDestroy(opts: {
  projectDir: string;
  worktreePath: string;
  branch: string;
}): Promise<void> {
  await invoke<void>('pipeline_worktree_destroy', opts);
}

export async function pipelineInstallSkills(): Promise<InstallSkillsResult> {
  return invoke<InstallSkillsResult>('pipeline_install_skills');
}

/**
 * Read a bundled role-prompt (`planner` / `builder` / `reviewer` /
 * `reviewer-codex`). Returns null if the file is missing or empty —
 * the run factory treats that as "not yet authored" and skips hashing.
 */
export async function pipelineReadRolePrompt(role: string): Promise<string | null> {
  return invoke<string | null>('pipeline_read_role_prompt', { role });
}

export async function pipelineTelemetryLog(opts: {
  projectDir: string;
  runId: string;
  line: string;
}): Promise<void> {
  await invoke<void>('pipeline_telemetry_log', opts);
}

/**
 * Mask detected secrets in arbitrary text. Returns the same string with
 * known-prefix tokens (`sk-…`, `ghp_…`, `xoxb-…`, `AKIA…`, `AIza…`,
 * `ya29.…`, `glpat-…`) replaced by `<MASKED:hash6>`, PEM blocks replaced
 * by `<MASKED:PEM>`, and high-entropy values in `KEY=…` / `"key": …`
 * shapes replaced by `<MASKED:hash6>`. Pure-hex (git SHAs, lock-file
 * checksums) and `sha\d+-…` lock-file integrity hashes are deliberately
 * NOT masked.
 *
 * The pipeline telemetry path applies masking server-side automatically;
 * call this for failure-bundle / webhook payloads where the frontend
 * controls the wire format.
 */
export async function secretsMask(input: string): Promise<string> {
  return invoke<string>('secrets_mask', { input });
}

export async function pipelineGuardrailsInstall(worktreeDir: string): Promise<void> {
  await invoke<void>('pipeline_guardrails_install', { worktreeDir });
}

export async function pipelineGuardrailsUninstall(worktreeDir: string): Promise<void> {
  await invoke<void>('pipeline_guardrails_uninstall', { worktreeDir });
}

// ─── Pipeline failure-bundle generator (Phase 2c-iii.7) ─────────

export interface FailureBundleResult {
  bundle_path: string;
  size_bytes: number;
  entries: string[];
}

/**
 * Generate `<projectDir>/.terminalx/failure-bundles/<runId>.tar.gz` with
 * telemetry, artifacts, preflight, git status/diff, and tool versions.
 * Every text artifact is masked through `secretsMask` server-side before
 * tar-archiving — frontend callers don't have to pre-mask, but doing so
 * is harmless because `mask_secrets` is idempotent.
 */
export async function pipelineFailureBundleGenerate(opts: {
  runId: string;
  projectDir: string;
  branch: string;
  baseBranch: string;
  artifactsJson: string;
  preflightJson: string;
  terminalxVersion: string;
  claudeVersion?: string;
  codexVersion?: string;
}): Promise<FailureBundleResult> {
  return invoke<FailureBundleResult>('pipeline_failure_bundle_generate', {
    input: {
      project_dir: opts.projectDir,
      run_id: opts.runId,
      branch: opts.branch,
      base_branch: opts.baseBranch,
      artifacts_json: opts.artifactsJson,
      preflight_json: opts.preflightJson,
      terminalx_version: opts.terminalxVersion,
      claude_version: opts.claudeVersion ?? null,
      codex_version: opts.codexVersion ?? null,
    },
  });
}

// ─── Pipeline capability scoping (Phase 2c-ii.4) ──────────────

export async function pipelineCapabilitiesInstall(opts: {
  worktreeDir: string;
  role: string;
  capabilities: import('@/types').RoleCapabilities;
}): Promise<void> {
  await invoke<void>('pipeline_capabilities_install', opts);
}

export async function pipelineCapabilitiesUninstall(opts: {
  worktreeDir: string;
  role: string;
}): Promise<void> {
  await invoke<void>('pipeline_capabilities_uninstall', opts);
}

// ─── Pipeline verification step (Phase 2c-i) ──────────────────

export interface VerificationStepResult {
  status: 'pass' | 'fail';
  kind: 'format' | 'lint' | 'typecheck' | 'test';
  exit_code: number | null;
  duration_ms: number;
  output: string;
  timed_out: boolean;
}

/**
 * Run a single verification step (resolved by `verification-chain.ts`) inside
 * the worktree dir. Spawn errors and timeouts come back as
 * `{ status: 'fail', timed_out, output: '[...]' }` rather than rejecting — the
 * controller hook loops over a `Step[]` and renders status uniformly.
 */
export async function pipelineRunVerificationStep(opts: {
  worktreeDir: string;
  command: string;
  kind: 'format' | 'lint' | 'typecheck' | 'test';
  timeoutSecs?: number;
}): Promise<VerificationStepResult> {
  return invoke<VerificationStepResult>('pipeline_run_verification_step', {
    input: {
      worktree_dir: opts.worktreeDir,
      command: opts.command,
      kind: opts.kind,
      timeout_secs: opts.timeoutSecs ?? 600,
    },
  });
}

// ─── Pipeline merger (Phase 2c-ii) ────────────────────────────

export interface MergerResult {
  status: 'success' | 'failure' | 'invalid_token';
  mode: 'pr' | 'local' | 'unknown';
  pr_url: string | null;
  detail: string;
}

/**
 * Request a one-shot 5-min confirm-token bound to `runId`. The UI confirm modal
 * (Phase 2c-ii.2) issues this immediately before calling `pipelineMergerRun` so
 * no IPC caller can merge without going through the modal.
 */
export async function pipelineMergerRequestToken(runId: string): Promise<string> {
  return invoke<string>('pipeline_merger_request_token', { runId });
}

/**
 * Run the merger step: opens a PR via `gh pr create` when a GitHub remote is
 * detected, otherwise performs a local `git switch <base> && git merge --no-ff
 * <branch>`. `confirmToken` MUST be a token previously returned by
 * `pipelineMergerRequestToken(runId)`; tokens are one-shot and expire after 5
 * minutes. Runtime failures fold into `{ status: 'failure'|'invalid_token' }`
 * rather than rejecting.
 */
export async function pipelineMergerRun(opts: {
  runId: string;
  projectDir: string;
  branch: string;
  baseBranch: string;
  confirmToken: string;
}): Promise<MergerResult> {
  return invoke<MergerResult>('pipeline_merger_run', {
    input: {
      run_id: opts.runId,
      project_dir: opts.projectDir,
      branch: opts.branch,
      base_branch: opts.baseBranch,
      confirm_token: opts.confirmToken,
    },
  });
}

export interface OneshotResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
}

export async function agentRunOneshot(opts: {
  agent: 'claude' | 'codex' | 'gemini';
  args: string[];
  stdin?: string;
  timeoutSecs?: number;
  cwd?: string;
}): Promise<OneshotResult> {
  return invoke<OneshotResult>('agent_run_oneshot', {
    input: {
      agent: opts.agent,
      args: opts.args,
      stdin: opts.stdin ?? null,
      timeout_secs: opts.timeoutSecs ?? 600,
      cwd: opts.cwd ?? null,
    },
  });
}
