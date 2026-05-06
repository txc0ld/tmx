# Agentic Pipeline Template — Phase 2c Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **production-readiness hardening** layer of the agentic pipeline. After Phase 2c, the pipeline can be trusted to run unattended overnight on real projects: it can't push to main without explicit user approval, can't escape the worktree, can't ship secrets in failure bundles, won't hang silently on a stuck agent, and will notify the user when human input is required.

Phase 2b ships the *engine* (live agent execution + sentinel scanner + telemetry); Phase 2c ships the *brakes, seatbelts, and dashboard*.

## Sub-phase split (one PR each)

Phase 2c is too big for a single PR. Splitting into three independently-mergeable slices:

| Sub-phase | Theme | Tasks | Ship gate |
|---|---|---|---|
| **2c-i** | CI hook + plan immutability + full fingerprint | ~7 | Builder commits trigger the verification chain; `CIResult` flows through `pipelineStore`; re-plans land as `-v2.md` files; `RunFingerprint` covers skills + prompts + capabilities |
| **2c-ii** | Destructive-op safety: Rust merger + guardrails install + capability scoping + skill provenance signing | ~10 | Pipeline can complete a full run end-to-end on a fixture project, including merge with user-confirm modal. Misbehaving agents are *physically* unable to push, force, reset, or write outside their role's allowlist. |
| **2c-iii** | Operability: clarification UX + heartbeats + stuck detection + notifications + secrets handling | ~9 | `awaiting_clarification` has a real UI; agent silence > 8min force-kills; OS notification fires on every gate state; failure bundles ship with secrets masked |

Each ships its own PR; each has its own ship gate; the next branches from the prior's merge commit.

**Reference spec sections:**
- 2c-i: §4.4 (CI hook), §13.1 (plan immutability), §17.4 (full fingerprint)
- 2c-ii: §4.5 (Merger), §12 (security layering), §17.1 (capability scoping), §17.7 (skill signing)
- 2c-iii: §17.2 (clarification), §17.3 (heartbeats), §17.5 (notifications), §17.6 (secrets handling)

**Critical TerminalX patterns (from CLAUDE.md):** Zustand selector trap (`|| []` / `?? {}` inside selectors), all IPC through `src/utils/ipc.ts`, inline styles + CSS vars, Tauri event listener cleanup with `mounted` ref guard.

---

## Sub-phase 2c-i: CI Hook + Plan Immutability + Full Fingerprint

**Branch:** `feat/agentic-pipeline-phase-2c-i` from current `origin/main`.

### Task 2c-i.1: Project verification-chain resolver (TS, TDD)

**Files:**
- Create: `src/pipeline/verification-chain.ts`
- Test: `src/pipeline/verification-chain.test.ts`

Pure function `resolveVerificationChain(projectDir, manifests) → Step[]` where `Step = { kind: 'format'|'lint'|'typecheck'|'test', command: string }`. Inspects `package.json` (`scripts.lint`, `scripts.typecheck`, `scripts.test`), `Cargo.toml`, `pyproject.toml`. Returns ordered list per spec §4.4.

10+ vitest cases covering: pure JS (npm), pure Rust (cargo), pure Python (pyproject + pytest), mixed (TS + Rust monorepo), missing manifest (empty chain → vacuous pass), template-override beats auto-detect.

Pure function so no IPC; test fixtures are inline JSON strings.

### Task 2c-i.2: Rust `pipeline_run_verification_step` IPC (TDD)

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/utils/ipc.ts`

Single Rust command runs one step (format/lint/typecheck/test) via `tokio::process::Command` in the worktree dir. Returns `{ status: 'pass'|'fail', durationMs, exitCode, output (truncated to 8KB) }`. Caller (frontend controller hook) loops over the chain. 4 cargo tests (mock command via /bin/sh).

### Task 2c-i.3: Worktree commit watcher → CI hook trigger

**Files:**
- Modify: `src/pipeline/controller-runtime.ts`
- Modify: `src/stores/pipelineStore.ts`

When pipeline state is `building`, watch the worktree's `.git/refs/heads/<branch>` via existing `watchDirectory` IPC. On change, fetch the new HEAD SHA, run the verification chain via 2c-i.2, dispatch `ci_pass` or `ci_fail` to the controller. Builder's role prompt instructs it to wait for `ciStatus: 'green'` before emitting its DONE sentinel.

3 vitest cases with mocked file events.

### Task 2c-i.4: Plan immutability + versioning

**Files:**
- Modify: `src/types/index.ts` (add `planLineage: string[]` to PipelineRun)
- Modify: `src/pipeline/state-machine.ts` (escalation re-plan path captures lineage)
- Modify: `src/stores/pipelineStore.ts`
- Modify: `src/pipeline/controller-runtime.ts`

When the controller writes a re-plan during escalation, the new spec/plan files land at `-v2.md` / `-v3.md` etc. (suffix derived from `planLineage.length + 1`). Original v1 files stay on disk and on the branch. `planLineage` array of commit SHAs (one per plan version) lives on `PipelineRun`. 5 vitest cases.

### Task 2c-i.5: Full fingerprint (skill + prompt + capability hashes)

**Files:**
- Modify: `src/pipeline/fingerprint.ts`
- Test: extend `src/pipeline/fingerprint.test.ts`

Phase 1 shipped `computeMinimalFingerprint`. Add `computeFullFingerprint(input)` that ALSO hashes:
- Each bundled SKILL.md content (`skillHashes[skillName] → sha256`)
- Each role's resolved prompt text (`rolePromptHashes[role] → sha256`)
- Each role's `RoleCapabilities` JSON (`capabilityManifests[role] → sha256`)
- INVARIANTS.md if present in project root (`invariantsHash`)

`computeMinimalFingerprint` stays for Phase 1 callers; `computeFullFingerprint` is what Phase 2c+ uses. 6 new vitest cases.

### Task 2c-i.6: Wire fingerprint into `pipelineStore.createRun`

**Files:**
- Modify: `src/stores/pipelineStore.ts`
- Modify: `src/App.tsx` (or wherever runs are created in production)

Production run-creation now computes the full fingerprint, not the minimal. Tests stay on `computeMinimalFingerprint` (faster).

### Task 2c-i.7: 2c-i smoke test + CLAUDE.md update + ship-gate

**Files:**
- Create: `src/pipeline/phase2c-i-smoke.test.ts`
- Modify: `CLAUDE.md`

End-to-end smoke: instantiate template, drive through Builder, fixture commit triggers verification chain, controller sees CI pass/fail, planLineage extends on escalation. CLAUDE.md gains "CI hook" + "Plan immutability" + "Full fingerprint" paragraphs.

**Ship gate:** all CI green; manual: pnpm tauri dev, drive a fixture pipeline, observe `.terminalx/pipeline-telemetry/<run>.jsonl` shows `ci_pass`/`ci_fail` events, observe `docs/superpowers/plans/<slug>-v2.md` lands on escalation.

---

## Sub-phase 2c-ii: Destructive-op Safety (Merger + Guardrails + Capabilities + Signing)

**Branch:** `feat/agentic-pipeline-phase-2c-ii` from `origin/main` after 2c-i merges.

### Task 2c-ii.1: `pipeline_merger_run` Rust command (TDD)

**Files:**
- Create: `src-tauri/src/commands/pipeline_merger.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Modify: `src/utils/ipc.ts`

Auto-detects GitHub remote (via `gh repo view --json owner,name`); if present, opens a PR via `gh pr create`. If absent, performs `git switch <main> && git merge --no-ff <branch>`. Always preceded by a `confirmToken: string` that the frontend must pass — Rust validates the token matches a recently-issued one (one-shot, 5-min TTL) so no IPC caller can merge without going through the UI confirm modal. 6 cargo tests including the confirm-token gate.

### Task 2c-ii.2: Merger UI confirm modal (TS)

**Files:**
- Create: `src/components/pipeline/MergerConfirmModal.tsx`
- Modify: `src/components/tiles/PipelineControllerTile.tsx`

Renders when state = `awaiting_merge_approval`. Shows: branch, headSha, diff stat, every commit subject, every reviewer verdict, the exact shell command to be run (PR vs local merge auto-detected). Two buttons: **Merge** (issues confirm token, calls `pipeline_merger_run`), **Cancel** (dispatches `reject_merge`). Inline styles, CSS vars, no new component library.

### Task 2c-ii.3: Guardrails hook install at run-start

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs`
- Modify: `src/pipeline/controller-runtime.ts`

When the worktree is created (`pipeline_worktree_create`), install `~/.claude/skills/git-guardrails-claude-code/scripts/block-dangerous-git.sh` reference into the worktree's `.claude/settings.json` `hooks.PreToolUse[]`. On run completion (`done` / `failed` / `escalated`), remove the hook entry. Idempotent: existing user `.claude/settings.json` content preserved. 4 cargo tests.

### Task 2c-ii.4: `RoleCapabilities` install per-role

**Files:**
- Modify: `src/types/index.ts` (already has `RoleCapabilities` from Phase 1)
- Modify: `src-tauri/src/commands/pipeline.rs` (new `pipeline_install_role_capabilities` command)
- Modify: `src/pipeline/controller-runtime.ts` (call on stage spawn)

When a stage is about to spawn, install the role's `RoleCapabilities` (per spec §17.1 defaults) into the worktree's `.claude/settings.json` so file-write/shell/network/MCP scopes are enforced *before* the agent process starts. Reviewer is read-only. Removed at stage completion. 5 cargo tests.

### Task 2c-ii.5: Skill provenance signing (Rust)

**Files:**
- Create: `src-tauri/src/commands/skill_signing.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/build.rs` (new — sign bundled SKILL.md files at build time)
- Modify: `src/utils/ipc.ts`

Reuses the existing updater public-key infra (per CLAUDE.md updater section). Build script signs each `src-tauri/resources/skills/<skill>/SKILL.md` with TerminalX's release key, emits `SKILL.md.sig`. `pipeline_install_skills` (Phase 2a) extended: verifies signature before install; refuses on mismatch. Pre-flight (`pipeline_preflight`) extended: verifies installed skills against bundled signatures. 4 cargo tests.

### Task 2c-ii.6: Pre-flight extended for capability + signing checks

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs::run_preflight_inner`

Add: required signed-skill verification, capability-manifest commands present (the deny-list shell binaries we use), worktree dir signed-skill cache writable. Update `PreflightResult` shape; update TS interface. 3 new cargo tests.

### Task 2c-ii.7: Frontend telemetry: capability/guardrails install/uninstall

**Files:**
- Modify: `src/stores/pipelineStore.ts` (new TelemetryEvent variants)

Telemetry JSONL gains `capability_install`, `capability_uninstall`, `guardrails_install`, `guardrails_uninstall`, `merger_invoked`, `merger_completed` events. Each stage transition that triggers one logs it. 3 vitest cases.

### Task 2c-ii.8: 2c-ii smoke test (e2e: agent runs, merger gates, guardrails block)

**Files:**
- Create: `src/pipeline/phase2c-ii-smoke.test.ts`

Drives a full pipeline run through to merge, including: capability scope verification (mocked), guardrails install + uninstall, merger confirm-token gate, signed-skill verification.

### Task 2c-ii.9: Documentation

**Files:**
- Modify: `CLAUDE.md` (Pipeline Templates section)
- Modify: `docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md` (mark §17.1, §17.7 as shipped)

### Task 2c-ii.10: 2c-ii ship gate

Manual: pnpm tauri dev, run a fixture pipeline end-to-end including merger UI flow. Confirm guardrails physically block a `git push` attempt from the Builder agent (via test that injects a `git push` command into the agent's PTY).

---

## Sub-phase 2c-iii: Operability (Clarification UX + Heartbeats + Notifications + Secrets)

**Branch:** `feat/agentic-pipeline-phase-2c-iii` from `origin/main` after 2c-ii merges.

### Task 2c-iii.1: Clarification sentinel UX

**Files:**
- Create: `src/components/pipeline/ClarificationModal.tsx`
- Modify: `src/components/tiles/PipelineControllerTile.tsx`

Renders when state = `awaiting_clarification` AND a `QuestionArtifact` is unanswered. Shows: question text, context (collapsible), agent-suggested options as preset buttons, free-text input. On submit: dispatches `clarification_received { resumeTo: <prior_active_state> }` and re-injects the answer into the agent (PTY for live, re-spawn arg for one-shot). Tracks `prior_active_state` in `PipelineRun` so the resume target is unambiguous. 5 vitest cases.

### Task 2c-iii.2: Heartbeat tracking + stuck detection

**Files:**
- Modify: `src/pipeline/controller-runtime.ts`
- Modify: `src/stores/pipelineStore.ts`

Heartbeat sentinel updates `run.lastHeartbeatAt`. New module-level interval (250ms tick) checks every active run: if `now - lastHeartbeatAt > 5min` AND no recent stdout, dispatch a probe (synthetic user-turn into the live PTY: "Are you stuck?"). After 8 minutes total silence, dispatch `abort` with `failureReason: 'stage_unresponsive'` + `failureClass: 'stage_unresponsive'`. 4 vitest cases (with `vi.useFakeTimers`).

### Task 2c-iii.3: OS notification + dock badge

**Files:**
- Modify: `src/components/tiles/PipelineControllerTile.tsx` (or a new `useNotifications` hook)
- Tauri `notification` plugin already capability-allowed per CLAUDE.md

On state entry to any `awaiting_*` state: fire OS notification (title = pipeline name + run id, body = state + 1-line summary). Re-fire on cadence: 15min, 1hr, 4hr, daily. Cleared on state-exit. 3 vitest cases (mocked notification API).

### Task 2c-iii.4: Webhook delivery (optional per-user setting)

**Files:**
- Modify: `src/stores/pipelineStore.ts` (optional `webhookUrl` per-project setting)
- Modify: `src/utils/ipc.ts` (use `httpFetch` Rust proxy)

If user has configured a webhook in TerminalX settings (UI deferred to Phase 3), POST `{ runId, state, project, branch, summary, terminalxDeepLink }` via the existing `httpFetch` proxy on `awaiting_*` entries. Body passed through `secretsMask` (Task 2c-iii.5) before send. 3 vitest cases (mocked httpFetch).

### Task 2c-iii.5: `secretsMask` Rust function (TDD)

**Files:**
- Create: `src-tauri/src/commands/secrets_mask.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/utils/ipc.ts`
- Modify: `src/stores/pipelineStore.ts` (apply to TelemetryEvent before emit)

Pure Rust function: takes a string, returns the same string with detected secrets replaced by `<MASKED:hash6>`. Heuristics per spec §17.6:
- Known-prefix tokens: `sk-…`, `ghp_…`, `gho_…`, `xoxb-…`, `xoxp-…`, `AKIA…`, `ASIA…`, `AIza…`, `ya29.…`, `glpat-…`
- High-entropy strings ≥24 chars Shannon entropy ≥4.5 bits/char in env-shaped contexts (`=value`, `: "value"`)
- PEM blocks: `-----BEGIN [A-Z ]+-----…-----END [A-Z ]+-----` → `<MASKED:PEM>`

Negative-test fixtures: package-lock SHAs, git SHAs, hex content hashes — must NOT match. 12 cargo tests.

### Task 2c-iii.6: Sensitive-path refusal in `pipeline_preflight`

**Files:**
- Modify: `src-tauri/src/commands/pipeline.rs::run_preflight_inner`

Pre-flight scans for: `.env`, `.env.*`, `secrets.*`, `*.pem`, `*.key`, `*.kdbx`, `id_rsa*`, `id_ed25519*`, `*.p12`, `*.pfx`, `gcp-key*.json`, `aws-credentials`, `*.ovpn`. If any present, returns `sensitivePathsFound: string[]` in `PreflightResult`. Frontend surfaces as a warning toast on run-start: "Project contains sensitive files. Pipeline will refuse to read them. [Acknowledge / Cancel]." Acknowledge proceeds; Cancel halts. 4 cargo tests.

### Task 2c-iii.7: Failure bundle generator + `secretsMask` integration

**Files:**
- Create: `src-tauri/src/commands/failure_bundle.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/pipeline/controller-runtime.ts` (auto-generate on terminal failure)

On `failed` / `escalated` terminal state, generate `<projectDir>/.terminalx/failure-bundles/<run-id>.tar.gz` containing: telemetry JSONL, artifacts JSON, `git status` + `git diff main..HEAD`, pre-flight result, terminalxVersion + claudeVersion + codexVersion. Every text artifact passes through `secretsMask` before tar-archiving. 5 cargo tests.

### Task 2c-iii.8: 2c-iii smoke test (clarification + stuck-kill + webhook)

**Files:**
- Create: `src/pipeline/phase2c-iii-smoke.test.ts`

Drives a pipeline through clarification gate (user types answer, agent resumes), stuck-detection force-kill, webhook firing on `awaiting_clarification` entry. 4 vitest cases.

### Task 2c-iii.9: Documentation + ship gate

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md` (mark §17.2, §17.3, §17.5, §17.6 as shipped)

**Manual ship-gate test:** Drive a real run with a fixture project. Trigger a clarification mid-run (modify Builder's role prompt to hit a clarification edge). Verify the modal renders, accepting an answer resumes. Kill an agent process externally; verify stuck-detection force-kills after 8 min (use `vi.useFakeTimers` + manual time advance). Confirm `secretsMask` masks a `.env`-looking value in a copied test telemetry line.

---

## Cross-cutting: tests in this plan that need new fixtures

- 2c-i.1 verification-chain: project-shape JSON fixtures (npm, cargo, mixed, empty)
- 2c-i.2 verification-step: `/bin/sh -c` mock commands
- 2c-i.3 commit watcher: vitest's `vi.useFakeTimers` + mocked `watchDirectory`
- 2c-ii.1 merger: mocked `gh` and `git` subprocesses
- 2c-ii.5 skill signing: vendored test signing key (build step generates ephemeral)
- 2c-iii.5 `secretsMask`: positive/negative fixture catalog (sk- / ghp_ / AKIA / PEM / package-lock SHA / git SHA)

## Phase 2c is done when

- All three sub-phases shipped to `origin/main`.
- A real fixture project can be driven from `Plan` request through `done` end-to-end without any manual intervention beyond the user-confirm-merge gate, the user-acknowledge-sensitive-paths gate, and the user-answer-clarification gate.
- All 7 production prereqs from spec §17 are checked off.
- `git log --grep="Tx-Pipeline-Run:"` shows pipeline-authored commits.
- Failure bundle generated on a forced failure has secrets masked.
- Stuck-detection force-killed an agent in test.
- Guardrails hook physically blocked a `git push` injection in test.

## What's deferred to Phase 3 / 4

- Dual-reviewer reconciliation
- Sub-agent delegation (`tx-pipeline-subagent`)
- Plan complexity gate (trivial/standard/complex routing)
- Red-team role
- Confidence-driven escalation
- Diff-aware reviewer chunking
- INVARIANTS.md integration
- Eval harness
- Stage-level checkpointing
- Concurrent runs
- Tiebreaker for dual-reviewer disagreement
- Lessons-learned with curation gate
- Settings → Pipeline Skills panel UI

(See `docs/superpowers/specs/2026-05-04-agentic-pipeline-template-addendum.md` for the full roadmap.)

## Self-review notes

- **Why split into three?** Phase 1 was 18 tasks in one PR — manageable but heavy review. Phase 2a was 7 tasks. Phase 2b was 7 tasks. Each Phase 2c sub-phase is ~7-10 tasks, matching the proven cadence.
- **2c-i is the natural lead** because CI hook + plan immutability + full fingerprint together unblock the next tier of trustworthy execution. They're also the smallest of the three.
- **2c-ii is the security-perimeter PR** — destructive-op safety. Ships the merger that makes the pipeline actually shippable to main.
- **2c-iii is the operability PR** — what makes the system not-suck for users when something goes wrong (notifications) or when an agent gets stuck (heartbeats).
- **Skill provenance signing (2c-ii.5)** depends on a build-script change. Worth triple-checking the build pipeline doesn't break on Windows where the build environment differs.
- **`secretsMask` (2c-iii.5)** is the highest-stakes pure function in the system. Test it ruthlessly — false negatives leak secrets, false positives mask legitimate content.

## Open decisions deferred to per-task implementation

- Whether the merger UI is a new full-screen modal or a tile-internal panel (lean: full-screen — destructive ops deserve a dedicated UI).
- Whether webhook delivery is a Phase 2c task or punted to Phase 3 alongside the Settings UI (lean: ship the Rust delivery in 2c-iii, defer the settings UI).
- Whether `secretsMask` signature filtering is configurable per-project (lean: ship a fixed heuristic pack in 2c, allow per-project overrides in Phase 3 via INVARIANTS.md).
- Whether the failure bundle includes the worktree's full `git diff main..HEAD` or just summaries (lean: full diff, masked, with a 5MB cap).
