// ─── Global window augmentation ──────────────────────────────────────

declare global {
  interface Window {
    __txQuotaWarned?: boolean;
    __txSaveErrorShown?: boolean;
  }
}

// ─── Tile Types ───────────────────────────────────────────────────────

export type TileType = 'agent' | 'terminal' | 'browser' | 'todo' | 'diff' | 'editor' | 'note' | 'kanban' | 'filetree' | 'group' | 'runner' | 'ssh' | 'docker' | 'git' | 'usage' | 'pipeline-controller';
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
  // Auto-completion detection — fires wires without requiring the agent process to exit
  autoComplete?: boolean;         // default true
  idleThresholdMs?: number;       // default 8000
  doneSentinel?: string;          // regex source — default matches DONE / ✅ DONE / [DONE] / ## Done

  // Auto-pipe: when a wired source produces output and goes idle, automatically
  // pipe + optionally send a default prompt so the agent responds hands-free.
  autoPipe?: boolean;             // default false
  autoPipeIdleMs?: number;        // silence required before auto-pipe fires — default 2000
  autoPromptTemplate?: string;    // prompt appended after the piped context (empty = pipe only)
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
  // User-friendly diff modes (added v1.1, all optional for back-compat)
  mode?: 'git' | 'compare' | 'paste';
  repoPath?: string;        // git mode — defaults to active project cwd
  gitTarget?: string;       // git mode — file path within the repo (relative)
  compareLeft?: string;     // compare mode — original file absolute path
  compareRight?: string;    // compare mode — modified file absolute path
  pasteOriginal?: string;   // paste mode
  pasteModified?: string;   // paste mode
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

// ─── Pipeline (Phase 1 foundation) ─────────────────────────────────

export type PipelineRole =
  | 'planner' | 'builder' | 'reviewer' | 'reviewer-codex' | 'controller';

export type PipelineState =
  | 'idle'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'building'
  | 'reviewing'
  | 'awaiting_clarification'
  | 'awaiting_merge_approval'
  | 'merging'
  | 'done'
  | 'failed'
  | 'escalated';

export type FailureClass =
  | 'preflight_env'
  | 'planner_refused'
  | 'builder_loop'
  | 'reviewer_irreconcilable'
  | 'reviewer_disagreement_unresolved'
  | 'budget_exceeded'
  | 'stage_unresponsive'
  | 'subagent_failed'
  | 'external_dep'
  | 'secrets_violation'
  | 'unknown';

export interface RunFingerprint {
  templateId: string;
  templateHash: string;
  skillHashes: Record<string, string>;
  rolePromptHashes: Partial<Record<PipelineRole, string>>;
  invariantsHash?: string;
  models: Partial<Record<PipelineRole, string>>;
  capabilityManifests: Partial<Record<PipelineRole, string>>;
  terminalxVersion: string;
  claudeVersion?: string;
  codexVersion?: string;
  runStartCommit?: string;
}

export interface RoleCapabilities {
  fileWrites: { allow: string[]; deny: string[] };
  shell: { allowPatterns: string[]; denyPatterns: string[] };
  network: 'none' | 'package-managers' | 'unrestricted';
  mcpTools: string[];
  maxFileSize: number;
}

export interface PlanTask {
  id: string;
  summary: string;
  files: string[];
  tests: string[];
  acceptance: string;
}

export interface PlanArtifact {
  stage: 'planner';
  branch: string;
  specPath: string;
  planPath: string;
  tasks: PlanTask[];
  summary: string;
  complexity?: 'trivial' | 'standard' | 'complex';
  /**
   * Commit SHA of the planner's commit that wrote `specPath` + `planPath`.
   * Required: the planner role-prompt commits before emitting the sentinel.
   * Captured into `PipelineRun.planLineage` on `planner_done`.
   */
  planCommitSha: string;
}

export interface BuildCommit {
  sha: string;
  subject: string;
  files: string[];
}

export interface BuildArtifact {
  stage: 'builder';
  branch: string;
  headSha: string;
  round: number;
  commits: BuildCommit[];
  filesChanged: string[];
  testsAdded: string[];
  ciStatus: 'green' | 'red' | 'unknown';
  notes?: string;
}

export interface ReviewComment {
  severity: 'blocker' | 'concern' | 'nit';
  file: string;
  line: number;
  issue: string;
  suggestion?: string;
  seenBy?: Array<'opus' | 'codex'>;
}

export interface ReviewVerdict {
  stage: 'reviewer';
  reviewer: 'opus' | 'codex' | 'merged';
  verdict: 'approve' | 'reject';
  round: number;
  comments: ReviewComment[];
  summary: string;
  confidence?: 'verified' | 'likely' | 'uncertain';
  uncertaintyDrivers?: string[];
  diffChunksReviewed?: number;
}

export interface CIFailure {
  test: string;
  output: string;
}

export interface CIResult {
  sha: string;
  status: 'pass' | 'fail';
  step: 'format' | 'lint' | 'typecheck' | 'test' | 'all';
  command: string;
  durationMs: number;
  failures: CIFailure[];
}

export interface QuestionArtifact {
  stage: PipelineRole;
  question: string;
  context: string;
  options?: string[];
  blocking: true;
}

export interface EscalationEntry {
  at: number;
  reason: string;
  exhaustedCounter?: 'reviewerReject' | 'ciFail';
  decision: 'replan' | 'escalate' | 'manual_resolve';
  newPlanRef?: string;
}

export interface PipelineRunArtifacts {
  plan?: PlanArtifact;
  builds: BuildArtifact[];
  reviews: ReviewVerdict[];
  ciResults: CIResult[];
  questions: QuestionArtifact[];
}

export interface PipelineRun {
  id: string;
  templateId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  /**
   * The fork point the run merges back into (typically `main` / `master` /
   * `develop`). Set at run creation from `git symbolic-ref refs/remotes/origin/HEAD`
   * (preflight already resolves this) or from a template override.
   * The merger modal renders the right `gh pr create --base` flag and the
   * failure bundle takes its `git diff <baseBranch>..HEAD` from this.
   */
  baseBranch: string;
  state: PipelineState;
  artifacts: PipelineRunArtifacts;
  retryCounters: { reviewerReject: number; ciFail: number };
  startedAt: number;
  endedAt?: number;
  failureReason?: string;
  failureClass?: FailureClass;
  escalationLog: EscalationEntry[];
  tiles: Partial<Record<PipelineRole, string>>;
  fingerprint: RunFingerprint;
  lastHeartbeatAt?: number;
  /**
   * Commit SHAs (one per plan version) — index 0 is v1 (initial plan), index N
   * is v(N+1). Empty until the first `planner_done` lands. Grows by one entry
   * per `planner_done` (including re-plans triggered via `replan_requested`).
   * Required (not optional) so missing-field bugs surface at compile time
   * rather than as silent empty arrays at runtime.
   */
  planLineage: string[];
  /**
   * The active stage we left when a `question_raised` event fires. Captured
   * on `question_raised`, consumed (and cleared) on `clarification_received`
   * so the run resumes to the same stage. Undefined except while in
   * `awaiting_clarification`.
   */
  priorActiveState?: PipelineState;
}

export interface PipelineControllerTile extends TileBase {
  type: 'pipeline-controller';
  runId: string;
}

export type Tile = AgentTile | TerminalTile | BrowserTile | TodoTile | DiffTile | EditorTile | NoteTile | KanbanTile | FileTreeTile | GroupTile | RunnerTile | SshTile | DockerTile | GitTile | UsageTile | PipelineControllerTile;

// ─── Project ──────────────────────────────────────────────────────────

/**
 * Webhook re-fire cadence — mirrors the cumulative pattern in
 * `src/pipeline/notifications.ts` but opt-in per project. Default
 * (when undefined) is `entry-only`, matching the Phase 2c-iii.4 ship
 * behavior — webhooks fire once on entry into an `awaiting_*` gate.
 *
 * Cumulative thresholds measured from `firstNoticeAt`:
 *   '15min'  → entry + 15min
 *   '1hr'    → entry + 15min + 1hr
 *   '4hr'    → entry + 15min + 1hr + 4hr
 *   'daily'  → entry + 15min + 1hr + 4hr + 24hr, then every 24hr.
 */
export type WebhookCadence = 'entry-only' | '15min' | '1hr' | '4hr' | 'daily';

export interface Project {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  cwd: string;
  gitUrl?: string;
  branch?: string;
  /**
   * Optional outbound webhook URL. When set, pipeline runs in this project
   * POST a notification on every transition into an `awaiting_*` gate.
   * Production wiring (App.tsx) only honors `https://` URLs — `http://`
   * and other schemes are rejected at the deps boundary. UI for editing
   * this lands in Phase 3; the field exists now so the delivery
   * infrastructure (see `src/pipeline/webhook-notifier.ts`) is wired.
   */
  webhookUrl?: string;
  /**
   * Optional re-fire cadence. Undefined means `entry-only` — fire once
   * on entry into `awaiting_*`, no reminders. Anything else widens to
   * cumulative reminders mirroring `notifications.ts`. Read fresh on
   * each notifier tick so changes apply at the next entry without
   * restart. See `src/pipeline/webhook-notifier.ts`.
   */
  webhookCadence?: WebhookCadence;
}

// ─── Wiring ───────────────────────────────────────────────────────────

export type WireType = 'context-pipe' | 'refresh-trigger' | 'task-assign' | 'diff-feed' | 'agent-chain' | 'file-open';

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
