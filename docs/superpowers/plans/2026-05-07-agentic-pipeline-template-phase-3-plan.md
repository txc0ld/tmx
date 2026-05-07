# Agentic Pipeline Template — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the production-hardened pipeline that landed in Phase 2c (CI hook, plan immutability, full fingerprint, merger, guardrails, capabilities, skill provenance, clarification, heartbeats, notifications, secrets handling, failure bundle, role prompts) and ship the layers that make it **work well on real workloads**, not just survive them.

Phase 2c shipped *correctness and safety*; Phase 3 ships *fitness for the job*. After Phase 3, the pipeline:

- Has a UX surface for the things only plumbed in 2c (webhook URL, sensitive-paths acknowledge, settings panels)
- Doesn't silently degrade on 40+ task feature work via Builder scratchpads, sub-agent delegation, and compaction checkpoints
- Knows what it doesn't know — confidence scores, dual-reviewer reconciliation, INVARIANTS.md grounding, plan-complexity gating
- Reports honestly: budgets (tokens / dollars / wallclock), failure taxonomy, cost attribution, rollback path
- Improves itself: lessons-learned, eval harness against historical runs

**Reference:**
- Spec: `docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md`
- Addendum (roadmap source): `docs/superpowers/specs/2026-05-04-agentic-pipeline-template-addendum.md` — sections A1, A3, A4, A6, A7, A9, A11, A13, A15, A16, A17, A18, A19, A20, A25 are this phase's build targets.
- Phase 2c plan (proven cadence): `docs/superpowers/plans/2026-05-06-agentic-pipeline-template-phase-2c-plan.md`

**Critical TerminalX patterns (CLAUDE.md):** Zustand selector trap, all IPC through `src/utils/ipc.ts`, inline styles + CSS vars, Tauri event listener cleanup, mod-private overlay via `data-canvas-overlay`, multi-listener emitters (Phase 2c-iii post-script).

## Sub-phase split (one PR each)

Three sub-phases, each ships its own PR, each branches from the prior's merge commit.

| Sub-phase | Theme | Tasks | Ship gate |
|---|---|---|---|
| **3a** | UX completion — deferred UI work + ergonomics | ~8 | Settings panel for `Project.webhookUrl`; sensitive-paths Acknowledge/Cancel toast on run-start; `Pipeline Skills` settings sub-panel; CLAUDE.md updates |
| **3b** | Context engineering — production runs that don't degrade silently | ~10 | Builder scratchpad (A1.1) + sub-agent delegation skill (A1.1) + compaction checkpoints (A1) + INVARIANTS.md grounding (A11) |
| **3c** | Trust & calibration — confidence, complexity gating, dual reviewer reconciliation | ~9 | Plan complexity gate (A4); confidence scores + uncertainty-driven escalation (A7); dual-reviewer tiebreaker (A19); diff-aware reviewer chunking (A9); red-team pass (A6) |

**Phase 3d (operations: budgets / failure taxonomy / checkpointing / cost / rollback / concurrent runs)** and **Phase 3e (self-improvement: lessons-learned / eval harness)** are scoped after 3a–3c land. They depend on 3b–3c primitives (e.g., budgets without confidence scores produce false stops) and the user signal we get from dogfooding.

Each ships its own PR; each has its own ship gate; the next branches from the prior's merge commit.

---

## Sub-phase 3a: UX completion + ergonomics

**Branch:** `feat/agentic-pipeline-phase-3a` from `origin/main` (post-merge of Phase 2c).

The 2c work plumbed several features end-to-end at the data layer but deferred the UI. 3a is the smallest sub-phase by surface area but it's what makes 2c's plumbing reachable.

### Task 3a.1: Settings panel host

**Files:**
- Create: `src/components/settings/SettingsModal.tsx`
- Modify: `src/components/topbar/TopBar.tsx` (gear icon → opens panel)

Modal-style settings panel with a sidebar of categories (project / agents / pipeline / plugins / about). Renders inline-styles per project convention; gets `data-canvas-overlay` so canvas wheel/pan handlers don't hijack scroll. Persists open/closed state in localStorage so re-opens land on the last-viewed category.

3-4 vitest cases (renders categories, switches between them, Escape closes, click outside does nothing — destructive-op pattern).

### Task 3a.2: Project settings — webhook URL

**Files:**
- Create: `src/components/settings/ProjectSettings.tsx`
- Modify: `src/components/settings/SettingsModal.tsx` (mount in sidebar)

Form for editing the active project's `webhookUrl` (the field already exists on `Project` per Phase 2c-iii.4; UI was deferred). Inline validation: must start with `https://`; reject `http://` and other schemes (matches the App.tsx deps boundary). Save/Cancel buttons; save calls `useProjectStore.getState().updateProject({...})`.

3 vitest cases (renders existing URL, https-only validation, save persists).

### Task 3a.3: Sensitive-paths Acknowledge/Cancel toast

**Files:**
- Modify: `src/pipeline/run-factory.ts` (preflight call returns `sensitive_paths_found` already)
- Create: `src/components/pipeline/SensitivePathsToast.tsx`

When `createRunFromTemplate` resolves preflight with `sensitive_paths_found.length > 0`, render a toast (or modal — toast preferred per spec) with the paths listed and Acknowledge / Cancel buttons. Acknowledge proceeds with run creation; Cancel halts and tears down the worktree. Until the user acknowledges (or cancels), the run isn't actually created.

5 vitest cases (renders paths, Acknowledge proceeds, Cancel tears down, multiple paths truncated, Escape acts as Cancel).

### Task 3a.4: Pipeline skills settings sub-panel

**Files:**
- Create: `src/components/settings/PipelineSkillsSettings.tsx`

Lists installed `~/.claude/skills/` entries that match the bundled skill names. Per-skill: shows installed status, hash match status (uses Phase 2c-iii.7 preflight `signed_skills_ok`), an "Update from bundle" button that calls `pipelineInstallSkills` after deleting the local copy. Phase 3 explicit requirement: this is the settings UI deferred from Phase 2c-i (per CLAUDE.md "What's deferred to Phase 3 / 4").

4 vitest cases.

### Task 3a.5: Webhook delivery — re-cadence configurability

**Files:**
- Modify: `src/pipeline/webhook-notifier.ts`
- Modify: `Project` type (add `webhookCadence?: 'entry-only' | '15min' | '1hr' | '4hr' | 'daily'`)

Default stays `entry-only` (matches Phase 2c-iii.4 ship default). Project setting widens to opt-in to OS-notification-style cumulative cadence. Settings UI in 3a.2 includes the radio.

3 vitest cases.

### Task 3a.6: Marker convention unification

**Files:**
- Modify: `src-tauri/src/commands/pipeline/guardrails.rs`
- Modify: `src-tauri/src/commands/pipeline/capabilities.rs`
- Migration: detect old markers (`tx-pipeline-managed`, `_tx_pipeline_capabilities`) and rewrite to `_tx_pipeline_managed: { hooks: bool, capabilities: { <role>: {...} } }`.

The 2c-ii.4 review flagged that guardrails uses `tx-pipeline-managed` (kebab-case, embedded in `hooks` array entries) while capabilities uses `_tx_pipeline_capabilities` (snake-case, top-level sibling). Unify both under one `_tx_pipeline_managed` namespace. Migrate existing settings.json files on install (idempotent — old + new both readable during a transition window).

5 cargo tests (migrate-from-old, both-old-markers, mixed, idempotent re-run, fresh install).

### Task 3a.7: Sensitive-path scan — case-insensitive + symlink awareness

**Files:**
- Modify: `src-tauri/src/commands/pipeline/preflight.rs::scan_sensitive_paths`

The 2c-iii.6 review noted the scan is case-sensitive (`.ENV`, `ID_RSA` not flagged) and skips symlinks entirely. Make filename matching case-insensitive; for symlinks, follow them once (no recursion through symlink loops) and flag the matched target paths.

3 cargo tests.

### Task 3a.8: 3a smoke + CLAUDE.md update

**Files:**
- Create: `src/pipeline/phase3a-smoke.test.tsx` — settings panel renders, webhook config persists, sensitive-paths toast acknowledges, marker migration runs.
- Modify: `CLAUDE.md` Pipeline Templates section.

**Ship gate:** all CI green; manual: open settings panel via gear; add a project with a sensitive file, observe toast on run; configure a webhook URL and confirm it fires on a fixture run.

---

## Sub-phase 3b: Context engineering

**Branch:** `feat/agentic-pipeline-phase-3b` from `origin/main` after 3a merges.

This is the sub-phase that decides whether the pipeline can run on real 40+ task features without silent degradation. Maps to addendum §A1 + §A11.

### Task 3b.1: Builder scratchpad skill (`tx-pipeline-builder-scratchpad`)

**Files:**
- Create: `src-tauri/resources/skills/tx-pipeline-builder-scratchpad/SKILL.md`
- Modify: `src-tauri/src/commands/pipeline/skills.rs::BUNDLED_PIPELINE_SKILLS` (add to list)

Skill author per addendum §A1 + §A1.1: instructs Builder to maintain `<worktree>/.tx-builder-notes.md` continuously — open task / decisions / next step / blockers. Format pinned by skill (sections + bullet lists, no free-form). Re-read before continuing on any retry / sub-agent return / post-CI event. **Deleted on `done`** (the file is `.gitignore`d at run-creation by the controller).

The build script (Phase 2c-ii.5) auto-hashes the new SKILL.md; tests confirm the hash table grows.

### Task 3b.2: Builder scratchpad enforcement at controller

**Files:**
- Modify: `src/pipeline/controller-runtime.ts`

When a Builder emits a heartbeat OR a sentinel, the controller checks for `<worktree>/.tx-builder-notes.md` mtime advancement since the last sentinel/heartbeat. If the file hasn't been touched in ≥10 minutes of activity, the controller emits a synthetic clarification: "Builder hasn't updated `.tx-builder-notes.md` recently. Pause and document state, or refusal-protocol if blocked." Counts against the 3-question budget.

This makes the scratchpad load-bearing, not just suggested.

5 vitest cases.

### Task 3b.3: Sub-agent delegation skill (`tx-pipeline-subagent`)

**Files:**
- Create: `src-tauri/resources/skills/tx-pipeline-subagent/SKILL.md`
- Modify: `BUNDLED_PIPELINE_SKILLS`

Skill author per addendum §A1.1. Behavioral contract: self-containment test, bounded brief (file globs only, not full plan), forbidden delegations (no CI / push / file writes outside brief), one-level recursion (sub-agents cannot delegate), sentinel contract (`<<<TX_SUBAGENT_DONE>>>{filesEdited, commitsCreated, summary}`).

### Task 3b.4: `agent_run_oneshot` extensions for sub-agent invocation

**Files:**
- Modify: `src-tauri/src/commands/agents.rs::run_oneshot_inner` — extend `OneshotInvocation` with optional `system_prompt: Option<String>` (passed via `--system-prompt` for Claude / equivalent for Codex / Gemini) AND optional `working_files: Vec<String>` (paths exposed via `cd` + permission allowlist).
- Modify: `src/utils/ipc.ts::agentRunOneshot` (TS surface)

The Builder uses this to invoke sub-agents with the bounded brief (system prompt = the sub-agent skill content + the parent task's acceptance criterion + the working file globs).

5 cargo tests.

### Task 3b.5: Sub-agent sentinel + scanner

**Files:**
- Modify: `src/pipeline/sentinel-scanner.ts` (new sentinel kinds: `TX_SUBAGENT_DONE`, `TX_SUBAGENT_FAILED`)
- Modify: `src/pipeline/controller-runtime.ts`

Builder PTY emits these sentinels when its sub-agent invocation returns. Scanner parses them; controller logs to telemetry but does NOT advance the run state (sub-agents are within Builder's task, not stage transitions).

4 vitest cases.

### Task 3b.6: Compaction checkpoint mechanism

**Files:**
- Modify: `src/pipeline/controller-runtime.ts`
- Modify: `src/pipeline/sentinel-scanner.ts` (new sentinel: `TX_COMPACTION_REQUEST`)

When Builder's PTY output exceeds 200KB since last sentinel, the controller writes a compaction prompt to the PTY: *"Summarize progress so far in ≤500 tokens; identify next concrete action; resume."* Builder responds with `<<<TX_COMPACTION_DONE>>>{summary}` which is appended to `.tx-builder-notes.md`. Pre-summary transcript stays in telemetry but is dropped from active context (the agent reads only the latest compaction + open task).

5 vitest cases (size threshold trigger, summary captured, transcript drop).

### Task 3b.7: INVARIANTS.md grounding (addendum §A11)

**Files:**
- Modify: `src/pipeline/run-factory.ts::defaultRunFactoryDeps.readInvariants` (already wired Phase 2c-i — extend to inject content into role prompts)
- Modify: All three role prompts under `src-tauri/resources/role-prompts/` — add a "## Project invariants" section that the controller fills in at spawn time.

If `<projectDir>/INVARIANTS.md` exists, its content is injected into Planner / Builder / Reviewer prompts at the same `1.2s post-spawn` injection point. Each role's prompt section says "treat this as canonical project rules; never violate". The Reviewer specifically checks the diff for invariants violations and reports them as `blocker` severity.

3 vitest cases (loaded from disk, injected into prompt, missing file is no-op).

### Task 3b.8: Sub-agent telemetry events

**Files:**
- Modify: `src/stores/pipelineStore.ts` (new variants on `TelemetryEvent`)

`subagent_invoked`, `subagent_completed`, `compaction_triggered`. Same shape as existing `merger_invoked`/`completed`.

3 vitest cases.

### Task 3b.9: 3b smoke

**Files:**
- Create: `src/pipeline/phase3b-smoke.test.tsx`

Drives a fake Builder run that emits scratchpad-noted sentinels, triggers a sub-agent, hits a compaction checkpoint. Verifies all three skill paths and the telemetry record.

### Task 3b.10: Documentation

**Files:**
- Modify: `CLAUDE.md` Pipeline Templates section
- Modify: `docs/superpowers/specs/2026-05-04-agentic-pipeline-template-addendum.md` — mark §A1 / §A11 as shipped.

---

## Sub-phase 3c: Trust & calibration

**Branch:** `feat/agentic-pipeline-phase-3c` from `origin/main` after 3b merges.

The pipeline currently treats every Reviewer verdict equally and every plan as the same complexity. 3c makes the system honest about its uncertainty.

### Task 3c.1: Plan complexity gate (addendum §A4)

**Files:**
- Modify: `src/types/index.ts` (`PlanArtifact.complexity` — already present, unused)
- Modify: `src/pipeline/state-machine.ts` (route on complexity)
- Modify: Planner role prompt (require complexity assignment in DONE sentinel)

Planner emits `complexity: 'trivial' | 'standard' | 'complex'`. Routes:
- **trivial:** auto-approve plan, single Builder, single Reviewer, no red-team.
- **standard:** existing flow (current default).
- **complex:** dual-reviewer (Opus + Codex), red-team pass enabled, larger retry budgets.

The state machine reads `run.artifacts.plan.complexity` after `planner_done` to decide routing.

6 vitest cases (each complexity routed correctly, default if unspecified, downgrade-disallowed).

### Task 3c.2: Confidence scores in role prompts

**Files:**
- Modify: All three role prompts.

Each role's DONE sentinel already supports `confidence: 'verified' | 'likely' | 'uncertain'` (Phase 2c). Make role prompts require it (was optional). Planner: `confidence` reflects how grounded the plan is in spec / existing code. Builder: `confidence` reflects test coverage + verification chain status. Reviewer: as per existing convention.

3 vitest cases (assertion fixtures for required-field validation).

### Task 3c.3: Uncertainty-driven escalation (addendum §A7)

**Files:**
- Modify: `src/pipeline/state-machine.ts`

When any role emits `confidence: 'uncertain'` AND the diff is non-trivial (`filesChanged.length >= 5` OR `commits.length >= 3`), the controller adds a synthetic `<<<TX_STAGE_QUESTION>>>` to the run: "Stage emitted uncertain confidence with non-trivial diff. Confirm proceeding to next stage, or request a re-run." Counts against the 3-question budget.

5 vitest cases.

### Task 3c.4: Dual-reviewer reconciliation (addendum §A19)

**Files:**
- Modify: `src/pipeline/state-machine.ts`
- Modify: `src/pipeline/controller-runtime.ts`

When `template.pipeline.dualReviewer === true` (already supported per spec), the controller spawns BOTH `reviewer` and `reviewer-codex` after `builder_done`. Both produce verdicts; the controller reconciles:
- Both approve → `awaiting_merge_approval` immediately.
- Both reject → loop back to building.
- Disagree → spawn a third tiebreaker reviewer (the OTHER provider, e.g., if Opus + Codex disagree, spawn Gemini), tiebreaker decides.

7 vitest cases (each disagreement path, tiebreaker resolution, non-dual templates skip).

### Task 3c.5: Diff-aware reviewer chunking (addendum §A9)

**Files:**
- Modify: Reviewer role prompt
- Modify: `tx-pipeline-reviewer` skill

Reviewer is instructed to chunk large diffs (> 50 files OR > 5KB per file): emit a per-chunk verdict with `diffChunksReviewed: number` (already in ReviewVerdict shape per Phase 2c). The full verdict aggregates per-chunk findings. Prevents the "diff too large to read" failure mode where the Reviewer emits approve without actually reading.

4 vitest cases (in-skill behavioral assertions).

### Task 3c.6: Red-team role (addendum §A6)

**Files:**
- Create: `src-tauri/resources/role-prompts/red-team.md`
- Create: `src-tauri/resources/skills/tx-pipeline-red-team/SKILL.md`
- Modify: `src/types/index.ts` (`PipelineRole` adds `'red-team'`)
- Modify: `src/pipeline/state-machine.ts` (red-team fires on `complexity: 'complex'` after Reviewer approve, before merger)

The red-team role: read the diff + plan + spec, write a 1-page "what's the worst that could happen" report covering supply chain, prompt injection, secret exposure, race conditions, edge cases. Emits a `<<<TX_REDTEAM_DONE>>>` sentinel with `findings: RedTeamFinding[]`. Findings of severity `blocker` halt the run; `concern` are surfaced in the merger modal but don't block.

8+ vitest cases (sentinel parser, state-machine route, blocker halt, modal display).

### Task 3c.7: Telemetry for trust events

**Files:**
- Modify: `src/stores/pipelineStore.ts`

New variants: `complexity_routed`, `confidence_uncertain_escalated`, `dual_reviewer_disagreement`, `tiebreaker_invoked`, `red_team_finding`. Each carries the relevant fields.

3 vitest cases.

### Task 3c.8: 3c smoke

**Files:**
- Create: `src/pipeline/phase3c-smoke.test.tsx`

Drives a `complex` plan through dual reviewer + tiebreaker + red-team. Asserts each gate fires and the telemetry record is intact.

### Task 3c.9: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-05-04-agentic-pipeline-template-addendum.md` — mark §A4 / §A6 / §A7 / §A9 / §A19 as shipped.

---

## What's deferred to Phase 3d / 3e (out of scope for this plan)

Authored after 3a–3c land and we have user signal.

- **3d Operations:** A3 budgets (tokens/dollars/wallclock), A11 lessons-learned, A15 failure taxonomy, A17 stage-level checkpointing, A18 concurrent runs, A20 cost attribution, A25 rollback path.
- **3e Self-improvement:** A13 cross-run lessons-learned with curation gate, A16 eval harness against historical runs.

(See addendum sections; the addendum's framing is the design rationale, this plan splits implementation.)

## Phase 3 is done when

- All three sub-phases (3a / 3b / 3c) shipped to `origin/main`.
- A real fixture project can run a `complex` plan end-to-end with dual reviewer + red-team and produce a merged PR with tiebreaker telemetry.
- Sensitive paths warning appears on a real project with a `.env` file.
- Webhook delivery configured via the settings UI fires correctly on `awaiting_clarification`.
- Long-running Builder (40+ tasks) completes without context degradation due to scratchpad + compaction.
- INVARIANTS.md violations are caught by Reviewer as blocker comments.
- All telemetry events from 3a/3b/3c appear in JSONL with secrets masked.

## Self-review notes

- **Why this split?** Phase 2c's 3-sub-phase cadence (CI/safety/operability) worked. 3a is UX-cleanup (smallest, fastest), 3b is the make-it-work-on-real-loads layer (most novel work), 3c is the trust-the-output layer (highest leverage on output quality). 3d/3e are operations/self-improvement, deferred until we have signal.
- **What's NOT here.** No Settings UI for masking-rule overrides (Phase 4 — needs a richer config story than radios). No `agentMemoryStore`-style overrides per-project for capability scopes (same — Phase 4). No agent-CLI version pinning (Phase 4 — needs cross-platform binary management).
- **Risk.** Sub-agent delegation (3b.3-5) is the riskiest piece — it changes how Builder works. Mitigation: ship the skill as opt-in (Builder reads the skill, decides whether to delegate per task). Recursion explicitly forbidden by the skill.
- **Test cadence.** ~7-10 tasks per sub-phase, 3-7 vitest cases per task, 2-5 cargo tests per task. Same density as 2c.

## Open decisions deferred to per-task implementation

- Whether the settings panel uses Monaco or a plain textarea for multi-line fields like `INVARIANTS.md` editing (lean: textarea — Monaco is heavy and lazy-loaded).
- Whether the red-team role gets its own role-capability scope (lean: yes, read-only matching the Reviewer; the role isn't writing code).
- Whether `complex` plan routing accepts user override pre-approval (lean: yes — settings has a "force complexity" radio for testing).
- Whether the compaction checkpoint summary is structured (JSON) or freeform markdown (lean: freeform — Builder is the consumer, not the controller; over-structuring loses information).
