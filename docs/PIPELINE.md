# Pipeline runs

A user-facing guide to TerminalX's multi-agent pipeline. For the architectural
spec see [`docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md`](./superpowers/specs/2026-05-03-agentic-pipeline-template-design.md).

---

## What it is

A pipeline is a multi-agent automation that takes a goal in plain English and
turns it into a reviewed, optionally merged change on a fresh branch. Three
roles run in sequence:

- **Planner (Opus)** — reads your goal, produces a spec and a step-by-step plan.
- **Builder (Sonnet)** — executes the plan, edits files, runs tests, commits.
- **Reviewer (Opus, one-shot)** — reads the diff, returns an approve / reject
  verdict with reasoning.

Every run lives in an **isolated git worktree** under `.tx-worktrees/`, on a
generated branch (default `pipeline/run-<date>-<shortId>`). Your working tree
is never touched. If anything goes wrong the worktree can be deleted and
nothing else has to be undone.

---

## Quick start

1. Pick a project in the sidebar (the Pipeline button is disabled without one).
2. Click **Pipeline** in the top bar — or press **Cmd+Shift+P** (macOS) /
   **Ctrl+Shift+P** (Windows/Linux).
3. In the launch modal: pick a template (default: **Anthropic Trio**), type
   a goal in the textarea, click **Start**.
4. Three agent tiles + a **Pipeline Controller** tile spawn on the canvas,
   pre-wired. Watch the controller for state advances.
5. When the controller hits **Awaiting plan approval**, a modal opens with the
   spec and plan. Click **Approve** to start the Builder, **Reject** to abort.
6. After review, if a verdict is **approved**, the **Merge** modal appears
   showing the head SHA, commit list, reviewer verdicts, and the exact shell
   command that will run. Click **Confirm merge** to ship, or **Cancel** to
   leave the branch in place.

---

## What you'll see

**Four tiles** spawn together when you Start:

- `agent` × 3 — Planner, Builder, Reviewer. Live PTY output streams in.
- `pipeline-controller` — the run dashboard. Shows current state, branch, and
  any pending gate.

**State progression** (visible in the controller):

```
idle → planning → awaiting_plan_approval → building →
reviewing → awaiting_merge_approval → merging → done
```

Detours: `awaiting_clarification` (an agent asked a question),
`awaiting_dual_reviewer` / `awaiting_tiebreaker` (complex runs),
`awaiting_red_team` (complex runs), `escalated` (retry budget exhausted —
recoverable via re-plan), `failed` (terminal).

**Awaiting gates** — only three need your input under normal flow:

- **Plan approval** — the Plan Preview modal opens automatically.
- **Clarification** — a modal asks a single question; pick a suggested option
  or type a free-text answer. Counts against a budget of 3 per run. Synthetic
  questions from the builder-scratchpad watcher (see Troubleshooting) draw
  from the same budget, so an undisciplined Builder can exhaust it on its own.
- **Merge approval** — the Merger Confirm modal previews the exact command.

---

## Customization

Open **Settings** (gear icon in the top bar) → **Pipeline**:

- **Default template** — preselects in the launch modal.
- **Branch pattern** — supports `{date}` and `{shortId}` tokens. Default
  `pipeline/run-{date}-{shortId}`.
- **Auto-approve trivial** — when the Planner emits `complexity: "trivial"`,
  skip the plan-approval gate.
- **Webhook URL** (optional, https-only) — POST a JSON event when the run
  reaches an `awaiting_*` state.

Two project-root files steer the run:

- `INVARIANTS.md` — hard rules read by every role at spawn time. The Reviewer
  treats invariant violations as `blocker` severity. Edits land on the next
  spawned role; current roles keep their snapshot.
- `PIPELINE_GOAL.md` — written into the worktree by the launcher. The Planner
  reads it as its first action. You don't normally hand-edit this.

---

## Recovering when things go wrong

- **Run failed?** Open the **Run history** panel from the controller, click
  the failed row → **Run Logs** modal. Three tabs: **Telemetry** (event
  JSONL), **Plan/Spec** (the planner's artifacts), **Bundle** (path to the
  on-disk failure tarball — see below).
- **App reloaded mid-run?** The run is restored from disk and the controller
  shows an **Agents disconnected** banner. The PTYs aren't recoverable; click
  **Re-run** in the run-history row to launch a fresh run with the same goal
  on a fresh branch.
- **Worktree leftover?** TerminalX doesn't delete worktrees automatically.
  Clean up manually:
  ```bash
  git worktree remove .tx-worktrees/<branch>
  git branch -D <branch>
  ```
- **Reviewer keeps rejecting?** Default retry budget is 3. Once exhausted the
  run goes to `escalated`. From there you can **Re-plan** (the run re-enters
  planning, preserving lineage) or **Abort**.

---

## What's behind the curtain

- Pipeline-spawned agents run with **`--dangerously-skip-permissions`**. The
  worktree, the per-role capability allowlists, and the git guardrails hook
  (`.claude/settings.json` → `PreToolUse`) are the safety boundary — not
  Claude's interactive permission prompts.
- **Telemetry**: `<projectDir>/.terminalx/pipeline-telemetry/<runId>.jsonl`
  (append-only, secret-masked).
- **Run records**: `<projectDir>/.terminalx/pipeline-runs/<runId>.json` —
  enables restore-after-reload.
- **Failure bundles**: `<projectDir>/.terminalx/failure-bundles/<runId>.tar.gz`
  — telemetry, plan, preflight, `git status`, `git diff` (5MB cap), versions.
- **Worktrees**: `<projectDir>/.tx-worktrees/<branch>/`.

---

## Troubleshooting

- **Pipeline button disabled** — no active project. Pick or add one in the
  sidebar.
- **Sensitive paths gate** — preflight detected files like `.env`, `*.pem`,
  `id_rsa`, `secrets.*`. Review the list in the modal; click **Acknowledge**
  to proceed or **Cancel** to abort.
- **Stuck in `planning` indefinitely** — open the Planner agent tile and
  scroll its output. If you don't see a `<<<TX_STAGE_DONE>>>` or
  `<<<TX_STAGE_FAILED>>>` sentinel near the end, the agent likely never
  emitted one. Use the controller's **Abort** to stop the run, then re-launch.
- **Run aborts itself with `stage_unresponsive`** — the stuck detector
  watches for PTY silence. At 5 minutes of no output it pings the role with
  "Are you stuck?"; at 8 minutes total silence it aborts the run. Open the
  agent tile to see whether the role hung mid-thought or never spawned, then
  re-run.
- **Builder makes commits but the controller looks idle** — the builder
  scratchpad watcher requires Builder to write `.tx-builder-notes.md` while
  it works. 10 minutes of activity without a scratchpad write injects a
  synthetic `<<<TX_STAGE_QUESTION>>>` ("you're working but not documenting —
  pause and update notes") which spends one clarification budget slot. If
  this fires repeatedly the run will hit the budget cap and escalate.
- **An agent prompts "Do you want to proceed?"** — the skip-permissions flag
  isn't being applied. This is a bug; capture `ps aux | grep claude` and file
  an issue.
- **Webhook silently not firing** — must be `https://`. http URLs are
  rejected at the deps boundary in `App.tsx`.
- **"Already have a pipeline run in X"** — abort or finish the existing
  run first. Two concurrent runs on the same project would fight over
  `.claude/settings.json` and telemetry; the launch flow refuses by design.
