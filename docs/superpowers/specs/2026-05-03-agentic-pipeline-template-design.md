# Agentic Pipeline Template — Design Spec

**Date:** 2026-05-03
**Owner:** TerminalX
**Status:** Drafted via brainstorming, ready for plan generation
**Slug:** `agentic-pipeline-template`

---

## 1. Goal

Add a first-class **multi-tile, wired, auto-driven workflow template** to TerminalX. Inserting one template lays down a pre-wired set of agent + helper tiles on the canvas, spins up an isolated git worktree, and runs a structured pipeline that takes a user request from idea to merge-ready commit with minimal human intervention — while keeping destructive operations behind explicit human approval and physical (hook-level) enforcement.

The default template is the **Plan → Build → Review** trio, modelled on how Anthropic-style engineering uses Claude Code: skill-driven, worktree-isolated, with hooks for ambient automation rather than baroque CI/CD-as-agents architectures.

## 2. Non-goals

- Not building a generic workflow engine. The architecture supports future templates, but we ship one.
- Not implementing an in-app PR diff viewer beyond what the existing `DiffTile` already provides.
- Not creating a new MCP server. Stage handoff uses a JSON sentinel line on agent stdout; no in-process MCP.
- Not solving cross-machine / distributed pipelines. Single-machine only.
- Not requiring CI to pass through a third-party service. Local CI is a hook on commit; GitHub Actions et al. remain out-of-band.

## 3. Glossary

- **Pipeline run** — one execution of a pipeline template, tied to one git worktree and one feature branch.
- **Stage** — one node in the pipeline DAG. Three LLM stages (`planner`, `builder`, `reviewer`) plus two non-LLM helpers (`ci`, `merger`).
- **Stage tile** — the canvas tile that represents a stage. For LLM stages this is an `AgentTile` configured with a role; for the controller it's a new `PipelineControllerTile`.
- **Sentinel line** — `<<<TX_STAGE_DONE>>>{json}` printed on a single line by an agent to signal completion and emit its structured artifact.
- **Artifact** — typed JSON payload produced by a stage and consumed by the next. Schemas in §8.
- **Pipeline Controller** — frontend Zustand store + reducer that owns the state machine of an active run, the artifact bus, retry budgets, and escalation logic.
- **Worktree-per-run** — every run creates a fresh git worktree (`.tx-worktrees/<run-id>/`) on a fresh feature branch (`feat/<slug>`), branched from the project's main branch. Removed on completion or user discard.
- **Guardrails hook** — the `git-guardrails-claude-code` `PreToolUse` hook installed into the worktree's `.claude/settings.json`. Blocks `git push`, `reset --hard`, `clean -f`, `branch -D`, `checkout .`, `restore .` from any agent in the run.

## 4. Architecture

Three layered additions; each independently testable.

### 4.1 Multi-tile template format (`stores/templateStore.ts` extension)

Today `TileTemplate` describes one tile's config. We add a sibling shape:

```ts
export type AnyTemplate = TileTemplate | PipelineTemplate;

export interface PipelineTemplate {
  kind: 'pipeline';
  id: string;
  name: string;
  description?: string;
  isBuiltin: boolean;

  tiles: PipelineTileSpec[];
  wires: PipelineWireSpec[];
  pipeline: PipelineConfig;
}

export interface PipelineTileSpec {
  role: PipelineRole;                              // planner | builder | reviewer | reviewer-codex | controller
  type: TileType;                                  // 'agent' | 'pipeline-controller'
  position: { x: number; y: number; w: number; h: number };  // canvas-relative; offset added at instantiation
  config: Record<string, unknown>;                 // agent model/effort/role-prompt etc.
}

export interface PipelineWireSpec {
  fromRole: PipelineRole;
  toRole: PipelineRole;
  wireType: WireType;                              // existing canvasStore wire types
}

export interface PipelineConfig {
  retryBudget: { reviewerReject: number; ciFail: number };  // default 3 / 3
  dualReviewer: boolean;                                    // default false
  requireMergeGate: boolean;                                // default true; UI-only override
  skillBindings: Record<PipelineRole, string[]>;            // role → ordered skill names injected into role prompt
  testCommand?: string;                                     // override CI test command resolution
}

export type PipelineRole =
  | 'planner' | 'builder' | 'reviewer' | 'reviewer-codex' | 'controller';
```

`templateStore.addTemplate` and `removeTemplate` accept `AnyTemplate`. The discriminator is the presence of `kind === 'pipeline'`. Existing single-tile templates remain untouched; no migration.

### 4.2 Pipeline Controller (`stores/pipelineStore.ts`, new)

A Zustand store that owns:

```ts
export interface PipelineRun {
  id: string;                          // ULID
  templateId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  state: PipelineState;
  artifacts: {
    plan?: PlanArtifact;
    builds: BuildArtifact[];           // one per Builder cycle
    reviews: ReviewVerdict[];          // one per Review pass; in dual mode, both verdicts merged into one entry
    ciResults: CIResult[];
  };
  retryCounters: { reviewerReject: number; ciFail: number };
  startedAt: number;
  endedAt?: number;
  failureReason?: string;
  escalationLog: EscalationEntry[];
  // Tile bindings
  tiles: Record<PipelineRole, string>;  // role → tileId on the canvas
}

export type PipelineState =
  | 'idle'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'building'
  | 'reviewing'
  | 'awaiting_merge_approval'
  | 'merging'
  | 'done'
  | 'failed'
  | 'escalated';

interface PipelineStoreShape {
  runs: Record<string, PipelineRun>;
  activeRunId?: string;
  // …actions
  startRun(template: PipelineTemplate, userRequest: string): Promise<string>;
  abort(runId: string): Promise<void>;
  approvePlan(runId: string): void;
  approveMerge(runId: string): Promise<void>;
  rejectMerge(runId: string): void;
  ingestSentinel(runId: string, role: PipelineRole, payload: unknown): void;
}
```

The controller is the **only** module that knows about stages and ordering. Tiles do not import `pipelineStore`. The state machine is in §6.

### 4.3 Stage adapters (frontend + Rust)

Two completion-detection paths:

- **Live PTY agents (Planner, Builder).** Existing `agent_spawn` IPC. The role prompt instructs the agent to print a single line `<<<TX_STAGE_DONE>>>{...json...}` when done. A new sentinel scanner in `usePty` (or wherever wire data is sliced) watches each terminal's output buffer for that line, parses the JSON, and dispatches `ingestSentinel()` to the controller.
- **Headless one-shot agents (Reviewer).** New Rust command `agent_run_oneshot` in `commands/agents.rs`. Wraps `claude --print --output-format json` and `codex exec --json` (whichever the role config selects), returns stdout when the process exits, no PTY allocated. The result tile (`AgentTile` with a `oneshot: true` flag) renders the transcript read-only.

### 4.4 CI hook (Rust + filesystem watcher)

The controller wires the existing fs-watcher (`commands/filesystem.rs::watch_directory`) to the worktree's `.git/refs/heads/<branch>` file. On every commit (refs file change), the controller resolves the project's test command:

1. `pipeline.testCommand` from template config (override) →
2. `package.json` → `test` script → `npm test` →
3. `Cargo.toml` → `cargo test` →
4. `pyproject.toml` with `pytest` configured → `pytest` →
5. Otherwise empty → CI passes vacuously (with a one-time warning toast).

Test runs spawn through the existing `RunnerTile`-style command runner (no new IPC needed). Result is stored as a `CIResult` in the active run's artifacts and pushed to a wire that feeds the Builder. Builder's role prompt directs it to **wait for green** before emitting its sentinel.

### 4.5 Merger (Rust command, no LLM)

New Rust command `pipeline_merger_run` in `commands/pipeline.rs` (new file). Two modes auto-detected:

- **GitHub remote present** → `gh pr create --base <main> --head <branch> --title <synthesised> --body <synthesised>`. The synthesised PR body is **assembled from artifacts**, not LLM-generated: it concatenates plan summary + build commit subjects + reviewer verdicts. Deterministic, auditable.
- **No GitHub remote** → `git switch <main> && git merge --no-ff <branch> -m <message>`.

Always preceded by a UI confirm modal showing diff stat, commits, CI status, verdicts, and the exact command to be run. User clicks **Merge**, **Open PR (no merge)**, or **Cancel**. Cancel keeps the worktree intact for retry; success calls a `pipeline_merger_cleanup` that removes the worktree and the feature branch (after merge).

## 5. Stage role specs

Each role has: skills bound, model default, completion mode, input/output schema, and (later) a role prompt. Prompts are not in this spec — they're authored as part of the implementation plan after the controller works end-to-end.

### 5.1 Planner — `claude --model claude-opus-4-7`, live PTY

- **Skills bound (in order):** `superpowers:brainstorming` → `superpowers:writing-plans` → `tx-pipeline-stage-handoff` (new, see §10).
- **Job:** Turn user request into design spec (`docs/superpowers/specs/<date>-<slug>-design.md`) + executable plan (`docs/superpowers/plans/<date>-<slug>-plan.md`). Asks clarifying questions per the brainstorming skill. User approves design *and* plan before stage exits.
- **Output:** `PlanArtifact` (§8).
- **Completion:** Agent prints `<<<TX_STAGE_DONE>>>{...PlanArtifact...}` when both files are committed and self-review has passed.

### 5.2 Builder — `claude --model claude-sonnet-4-6` (configurable; Codex valid alternative), live PTY

- **Skills bound:** `superpowers:executing-plans` → `superpowers:test-driven-development` → `tdd` (Pocock; complementary anti-pattern emphasis) → `superpowers:verification-before-completion` → `tx-pipeline-stage-handoff`.
- **Job:** Walk the plan task-by-task. Per task: failing test → minimal code to pass → refactor → commit. Reads CI hook output between commits; on failure, fixes and recommits. On Reviewer reject (controller re-enters this stage with `reviewFeedback` injected), addresses feedback in new commits without re-running the whole plan. The "Polisher stage" of the original 6-stage design is absorbed here as a loop.
- **Output:** `BuildArtifact` (§8).
- **Completion:** When CI is green for `HEAD` *and* the Reviewer has approved (or the controller is in pre-Reviewer first round), agent emits sentinel.

### 5.3 Reviewer — `claude --model claude-opus-4-7` (and optionally `codex` in dual mode), headless one-shot

- **Skills bound:** `superpowers:requesting-code-review` (orchestrates the `code-reviewer` agent's checklist) → `karpathy-guidelines` (already-installed; sharpens "don't overcomplicate" emphasis) → `tx-pipeline-reviewer` (new, see §10).
- **Job:** Read `git diff <main>..<branch>`, review against plan + project conventions + correctness/security/perf checklist. Does not modify code.
- **Output:** `ReviewVerdict` (§8).
- **Dual-reviewer mode:** Two parallel one-shot calls (Opus + Codex). Verdicts merged by the controller (§7.3).
- **Completion:** Process exits; controller reads stdout JSON.

### 5.4 CI helper — not an agent

See §4.4. Triggered by fs-watcher on commit; runs project test command; produces `CIResult`.

### 5.5 Merger helper — not an agent

See §4.5. Rust command; user-confirmed; deterministic PR/merge.

## 6. State machine

```
                   ┌─────┐
                   │idle │
                   └──┬──┘
                      │ startRun(template, userRequest)
                      ▼
                  ┌────────┐
                  │planning│  (Planner live PTY; user dialogue)
                  └───┬────┘
                      │ sentinel: PlanArtifact
                      ▼
            ┌──────────────────────┐
            │awaiting_plan_approval│  (UI: review spec/plan files; cancel or proceed)
            └──────────┬───────────┘
                       │ approvePlan
                       ▼
                  ┌────────┐  ◄────────────── reviewer.reject (within budget)
                  │building│                  ci_fail (within budget)
                  └───┬────┘
                      │ sentinel: BuildArtifact (CI green)
                      ▼
                 ┌─────────┐
                 │reviewing│  (1 or 2 one-shot Reviewers in parallel)
                 └────┬────┘
                      │ ReviewVerdict(s) merged
              ┌───────┴────────┬────────────────┬────────────────┐
        approve              reject              disagree         budget exhausted
              │                │                    │                  │
              ▼                ▼                    ▼                  ▼
   ┌──────────────────┐    building            escalated           escalated
   │awaiting_merge…   │
   └────────┬─────────┘
            │ approveMerge / rejectMerge
            ▼
        ┌───────┐
        │merging│   (Rust merger; user-confirmed before this transition)
        └───┬───┘
            │ ok
            ▼
         ┌────┐
         │done│  (worktree + branch cleaned)
         └────┘
```

Two terminal failure states:
- **`failed`** — unrecoverable (worktree creation failed, CLI not on PATH, etc.). Run halted; worktree retained for forensics.
- **`escalated`** — retry budget exhausted or reviewer disagreement. Orchestrator (re-spawn of Planner with full history injected) is invoked with a re-plan prompt; if it outputs a new plan, controller re-enters `building` with reset budgets; if it outputs `give_up`, transitions to `failed`. User can also click "Resolve manually" from the controller UI to take over.

## 7. Failure handling

### 7.1 Retry budgets

Two independent counters, both reset only on Planner re-plan (escalation):

| Counter | Increment trigger | Default cap |
|---|---|---|
| `reviewerReject` | Reviewer emits `verdict: 'reject'` (or merged-reject in dual mode) | 3 |
| `ciFail` | CI hook emits `status: 'fail'` for a Builder commit | 3 |

When either counter exceeds its cap, controller transitions to `escalated`.

### 7.2 Escalation to Planner

When `escalated`, the controller spawns a **new** Planner one-shot (NOT the live PTY) with input:

```
{
  "originalPlan": <PlanArtifact>,
  "buildHistory": <BuildArtifact[]>,
  "reviewHistory": <ReviewVerdict[]>,
  "ciHistory": <CIResult[]>,
  "exhaustedCounter": "reviewerReject" | "ciFail",
  "request": "Re-plan or escalate to user. Output: { decision: 'replan' | 'escalate', plan?: PlanArtifact, reason: string }"
}
```

Planner returns either a new plan (controller resets budgets, re-enters `building`) or an escalation reason (controller transitions to `failed` with reason surfaced to user).

### 7.3 Dual-reviewer reconciliation

| Opus verdict | Codex verdict | Controller action |
|---|---|---|
| approve | approve | merged verdict = approve, comments concatenated and de-duplicated |
| reject | reject | merged verdict = reject, comments concatenated and de-duplicated, count as one rejection toward budget |
| approve | reject | **disagree** → controller surfaces both verdicts to user; user picks which to honour OR clicks "send both back to Builder as feedback." Counts as 0.5 toward `reviewerReject` budget. |
| reject | approve | same as above |

Comment de-duplication: same-file + same-line + same-issue-text (after lowercase + whitespace trim) collapses to one entry, with `seenBy: ['opus', 'codex']`.

## 8. Inter-stage data schemas

All artifacts are TypeScript-typed and JSON-serializable. Same shapes are used in (a) sentinel lines from agents, (b) the controller's artifact bus, and (c) the wire payloads delivered to consuming tiles.

```ts
// 8.1
export interface PlanArtifact {
  stage: 'planner';
  branch: string;                               // e.g. 'feat/agentic-pipeline'
  specPath: string;                             // committed in worktree
  planPath: string;                             // committed in worktree
  tasks: PlanTask[];
  summary: string;                              // 1-paragraph executive summary
}
export interface PlanTask {
  id: string;                                   // 'T1', 'T2', …
  summary: string;
  files: string[];                              // expected files touched
  tests: string[];                              // test names to write
  acceptance: string;                           // what 'done' looks like
}

// 8.2
export interface BuildArtifact {
  stage: 'builder';
  branch: string;
  headSha: string;
  round: number;                                // 1 = first try, 2+ = retry
  commits: BuildCommit[];
  filesChanged: string[];
  testsAdded: string[];
  ciStatus: 'green' | 'red' | 'unknown';
  notes?: string;                               // free-text from Builder
}
export interface BuildCommit {
  sha: string;
  subject: string;
  files: string[];
}

// 8.3
export interface ReviewVerdict {
  stage: 'reviewer';
  reviewer: 'opus' | 'codex' | 'merged';
  verdict: 'approve' | 'reject';
  round: number;
  comments: ReviewComment[];
  summary: string;
}
export interface ReviewComment {
  severity: 'blocker' | 'concern' | 'nit';
  file: string;
  line: number;
  issue: string;
  suggestion?: string;
  seenBy?: Array<'opus' | 'codex'>;             // dual-reviewer dedup metadata
}

// 8.4
export interface CIResult {
  sha: string;
  status: 'pass' | 'fail';
  command: string;                              // resolved test command
  durationMs: number;
  failures: CIFailure[];
}
export interface CIFailure {
  test: string;
  output: string;                               // truncated to 4 KB per failure
}

// 8.5  Escalation log entry
export interface EscalationEntry {
  at: number;
  reason: string;
  exhaustedCounter?: 'reviewerReject' | 'ciFail';
  decision: 'replan' | 'escalate' | 'manual_resolve';
  newPlanRef?: string;
}
```

## 9. Canvas layout & UX

**Default tile placement** (relative coordinates; absolute computed by adding the canvas insertion point):

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Planner     │──│   Builder    │──│  Reviewer    │
│  (agent)     │  │   (agent)    │  │  (agent)     │
│              │  │              │  │              │
└──────┬───────┘  └──────┬───────┘  └──────────────┘
       │                 │                  │
       │            ┌────▼────┐              │
       │            │  CI    ◄──── (commits) │
       │            │ Runner │                │
       │            └────────┘                │
       │                                      │
       └───────►  Pipeline Controller  ◄──────┘
                  (status, retry counts,
                   approve/cancel buttons)
```

Wires installed by the template:

| From | To | Wire type |
|---|---|---|
| `planner` | `builder` | `agent-chain` (passes `PlanArtifact` on completion) |
| `builder` | `reviewer` | `agent-chain` (passes `BuildArtifact` on completion) |
| `reviewer` | `builder` | `task-assign` (passes `ReviewVerdict` on reject; controller filters to only fire on reject) |
| `builder` | `ci` | `refresh-trigger` (controller-synthesised; fires on commit watcher event) |
| `ci` | `builder` | `task-assign` (passes `CIResult` on fail) |

Dual-reviewer adds a second `reviewer-codex` tile to the right of `reviewer` with both Build→Reviewer wires fanned out. The controller merges verdicts before deciding next state.

**Pipeline Controller tile** is a new tile type (`pipeline-controller`) — the 16th in the discriminated union. Render shows:

- Run name + branch + worktree path
- Current state badge (planning / building / …)
- Retry counters with caps
- Latest artifact summary (collapsible)
- Plan-approval button when state = `awaiting_plan_approval`
- Merge-approval button when state = `awaiting_merge_approval`
- "Abort run" with confirm
- Escalation log, latest-first

Controller tile is **created when a pipeline run starts**, not by the template. It anchors to the bottom-left of the template's tile cluster. On run completion (`done` or `failed`), the tile remains for inspection; user closes it manually.

## 10. New skills authored

Two new skills, written using `superpowers:writing-skills`:

### 10.1 `tx-pipeline-stage-handoff`

- **Audience:** any agent acting as a stage in a pipeline run.
- **Contract:** when the stage's job is complete, print exactly one line: `<<<TX_STAGE_DONE>>>{json}` where `json` matches the stage's artifact schema. Print nothing after that line. If the stage fails, print `<<<TX_STAGE_FAILED>>>{ "reason": "..." }` instead.
- **Anti-patterns:** printing the sentinel mid-thought, printing it more than once, embedding markdown around it, hallucinating fields.
- **Verification:** the controller's sentinel scanner is the truth — agents are told to assume their output is being parsed by a strict JSON consumer.

### 10.2 `tx-pipeline-reviewer`

- **Audience:** the Reviewer stage.
- **Wraps:** `superpowers:requesting-code-review` + the `code-reviewer` agent's checklist.
- **Contract:** produce a `ReviewVerdict`. Comments are required to cite `file:line` from the actual diff (no phantom citations). `severity: 'blocker'` requires a one-sentence justification. `severity: 'nit'` does not block approval. Approve when no `blocker` and at most 3 `concern` items.
- **Anti-patterns:** approving without reading the diff; rejecting on style nits alone; leaving free-text outside the JSON.

Skills live at `~/.claude/skills/tx-pipeline-stage-handoff/` and `~/.claude/skills/tx-pipeline-reviewer/` so they're available to all Claude Code sessions on this machine. Authored as part of the implementation plan, not in this spec.

## 11. Pre-flight checks

Before transitioning out of `idle`, the controller runs:

1. **Project is a git repo** — `git rev-parse --git-dir` in project cwd.
2. **Working tree is clean OR user has clicked "stash my changes"** — `git status --porcelain` empty, or stash created.
3. **Main branch resolvable** — `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`/`master` detection.
4. **Required CLIs present** — `claude --version` for any role bound to Claude; `codex --version` if dual-reviewer or Builder set to Codex.
5. **`gh` CLI present and authenticated** — only if a GitHub remote is detected and the Merger will need it.
6. **Worktree dir creatable** — `.tx-worktrees/` parent exists and is writable.

Any failure halts pre-flight and surfaces a per-check error with a "fix" hint (install command, login command, etc.). No silent fallbacks.

## 12. Security & destructive-op enforcement

Three layers, defence in depth:

1. **Norms (skill prompts)** — agents told they don't push, force, reset, or close PRs.
2. **Physical (`git-guardrails-claude-code` PreToolUse hook)** — installed at run-start into the worktree's `.claude/settings.json`. Even a misbehaving agent cannot execute the blocked git commands. Removed at run-end.
3. **Audit (Rust merger)** — the only code path with push/merge authority is `pipeline_merger_run`, gated by a UI confirm modal showing the exact shell command before execution. No LLM in this path.

The new IPCs (`pipeline_merger_run`, `pipeline_worktree_create`, `pipeline_worktree_destroy`, `agent_run_oneshot`) are registered in `lib.rs` like every other custom Rust command — no plugin-style capability scope is required since these aren't Tauri plugins. Sensitive arguments (target paths, branch names) are validated against the same control-char + shell-metachar checks already used by `agent_spawn`.

## 13. Persistence

Pipeline run state lives in `pipelineStore` and is persisted alongside canvas state via the existing 3-layer pattern (localStorage 500 ms cache → IPC disk 2 s debounce → `beforeunload` flush). On reload:

- Runs in `building` or `reviewing` are auto-resumed: relevant tiles re-spawn, sentinel scanners re-attach, fs-watcher rebinds.
- Runs in `planning` are **not** auto-resumed — that stage requires live user dialogue. The Planner tile is recreated in a paused state and the user must explicitly click "Resume planning" before its agent re-spawns.
- Runs in `awaiting_plan_approval` or `awaiting_merge_approval` resume in their gate; user must re-click to proceed.
- Runs in `merging` re-run the merger from the start of the merge (idempotent if the merge already succeeded — Rust command checks `git log` for the expected merge commit before acting).

Abandoned worktrees (no `pipelineStore` entry referencing them) are surfaced in a "Pipeline > Stale worktrees" UI on next launch, with one-click cleanup.

## 14. Testing strategy

- **Vitest unit tests for the controller state machine.** Pure-function reducer over `(state, event) → state`, no IPC. Aim 100% branch coverage on the state-machine table including all escalation paths and dual-reviewer reconciliation truth-table.
- **Vitest tests for sentinel parsing.** Bad JSON, missing sentinel, multiple sentinels, partial output, embedded markdown.
- **Vitest tests for `PipelineTemplate` instantiation.** Fixture template → expected tiles + wires on the canvas.
- **Rust unit tests for the merger command.** Mocked git/gh subprocesses; assert exact argv produced for each branch (PR mode vs local-merge mode), and that destructive flags are *only* used after a confirm token is presented.
- **End-to-end smoke test (manual at first, automated later)** — fixture project with one trivial change request; run the template top-to-bottom; assert the worktree exists, branch has commits, PR was created (or merge happened), and worktree was cleaned up. Used as the "ship gate" for this feature.

## 15. Implementation phasing

A single-PR ship is too big. Three slices, each independently mergeable and useful:

### Phase 1 — Foundation (multi-tile templates + controller skeleton)

- `PipelineTemplate` shape in `templateStore`, no built-in pipeline templates yet.
- `pipelineStore` with the state machine, no actual stage execution — `startRun` spawns the tiles and immediately transitions to `done` (smoke).
- `pipeline-controller` tile type (the 16th).
- Worktree creation/teardown commands in Rust (`pipeline_worktree_create`, `pipeline_worktree_destroy`).
- Pre-flight check IPC.
- **Ship gate:** can insert a "Hello World" pipeline template that lays down 3 tiles + a controller, creates a worktree, transitions through the state machine to `done` (without spawning any agents), and the worktree-destroy IPC successfully removes it. No agent processes run in this phase.

### Phase 2 — Live execution (the trio works end to end)

- `agent_run_oneshot` IPC (Reviewer).
- Sentinel scanner integrated into PTY output stream.
- CI hook integration (commit watcher → resolved test command → `CIResult`).
- The two new skills authored (`tx-pipeline-stage-handoff`, `tx-pipeline-reviewer`).
- Default `Anthropic Trio` built-in template wired correctly.
- Merger Rust command + UI confirm modal.
- Guardrails hook installation at run-start.
- **Ship gate:** smoke test in §14 passes on a real fixture project with a trivial test-failing-then-passing scenario.

### Phase 3 — Polish & power features

- Dual-reviewer toggle + reconciliation.
- Escalation-to-Planner re-plan loop.
- Stale-worktree cleanup UI.
- Run history / replay (read-only review of completed runs).
- Per-template overrides exposed in tile settings.
- **Ship gate:** full §14 testing passes; a second built-in template (e.g. `Bug Fix Pipeline`) ships to validate the multi-template story.

## 16. Open decisions deferred to plan

- Exact role prompt wording (authored during phase 2, after the controller works).
- Visual styling of the pipeline-controller tile (deferred to UX iteration).
- Whether to surface the artifact JSON to the user in a tile (e.g., a `JsonViewerTile`) or only in the controller's collapsible panel — leaning latter for v1 to avoid scope creep.
- Whether to preserve `agentMemoryStore` injection on top of role prompts in the worktree (probably yes; out of v1 scope to validate).

## 17. Companion edits

When this lands, update:

- `CLAUDE.md` — new `Pipeline Templates` section under Architecture; bump store count (15); add `pipeline-controller` to the tile type list (16th).
- `FEATURES.md` — top-level entry for the workflow.
- New `docs/superpowers/plans/2026-05-03-agentic-pipeline-template-plan.md` produced by writing-plans skill.
