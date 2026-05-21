# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TerminalX

Native desktop app (Tauri 2) — infinite canvas workspace for orchestrating multiple CLI agents (Claude Code, Codex, Gemini CLI) in parallel. Tiles (terminals, agents, editors, browsers, etc.) are arranged spatially and wired together for data flow.

**Stack:** Tauri 2 (Rust, `portable-pty`, `reqwest`) + React 19 + TypeScript 5 + Vite 6 + Zustand 5 + xterm.js 5.5 + Monaco Editor

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `txc0ld/tmx`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard five-label triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. Read repo-level docs plus relevant `docs/features/` pages before architectural, testing, or debugging work. See `docs/agents/domain.md`.

## Build & Dev Commands

```bash
pnpm tauri dev        # Full dev (Rust + Vite HMR). First run compiles ~500 crates (~3 min).
pnpm tauri build      # Production binary (MSI / DMG / AppImage / .deb)
pnpm dev              # Frontend only (Vite :5173, no Tauri)
npx tsc --noEmit      # Frontend type-check
cd src-tauri && cargo check    # Rust type-check
cd src-tauri && cargo test     # Rust tests
```

**Windows:** Cargo needs MSVC linker. If `cargo` isn't in PATH, add `%USERPROFILE%\.cargo\bin`. Git-bash's `link` command shadows MSVC's `link.exe` — build from PowerShell or `cmd.exe`. Agent CLIs (claude/codex/gemini) are npm `.cmd` scripts; the agent spawn auto-wraps them with `cmd.exe /C`.

**macOS:** `xcode-select --install` + `rustup`. Native traffic lights render via `titleBarStyle: "Overlay"` — the custom window buttons in `TopBar.tsx` are hidden on macOS.

**Linux:** Needs `libwebkit2gtk-4.1-dev` + `libayatana-appindicator3-dev` + `librsvg2-dev`.

**iOS/Android:** Not supported — `portable-pty` is target-gated out in `Cargo.toml` because mobile sandboxes forbid subprocess spawning. Terminal architecture is fundamentally incompatible.

## Architecture

### Frontend (`src/`)

Entry: `main.tsx` → `AppErrorBoundary` → `App.tsx`. All inline styles (except `xterm.css`). Colors via CSS custom properties set by `themeStore`. Monaco Editor/DiffEditor are lazy-loaded.

**Stores (`stores/`, Zustand 5, 19 total):**
- `canvasStore` — Central state: tiles, wires, transforms, z-stack, focus mode, multi-select, bookmarks, workspace tabs, snap guides, sticky notes, wire data bus (500KB cap per PTY)
- `projectStore` — Project CRUD, active-project persistence. Starts empty — users add projects via the + button in the sidebar.
- `themeStore` — 6 themes (5 dark + 1 light `Slate`). CSS var application via `applyThemeToDOM()`. Light themes get dark tile surfaces + dark chrome.
- `mcpStore` — Per-project MCP connections (Slack/GitHub/Linear/Jira/Notion). Subscribed to `projectStore` for project-switch reloads. Sync is sequential with 250ms jitter. Error toasts on failures (once per connection per session).
- `usageStore` — Agent session tracking + token/cost estimation. Auto-tracks via `canvasStore` subscription.
- `agentMemoryStore` — Per-project persistent context injected into every new agent spawn (after 2s delay, with ANSI escape stripping).
- `recordingStore` — Session replay. Events coalesced within 10ms window. Auto-stops at 50k events.
- `commandHistoryStore` — Per-terminal command buffer.
- `templateStore` — 16 built-in + user templates in localStorage.
- `pluginStore` — Custom tile types via sandboxed iframes.
- `pipelineStore` — Agentic pipeline run state machine. v0.2.0 ships end-to-end execution (Plan → Build → Review → Merge). See `docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md`.
- `blueprintStore` — Multi-tile blueprint capture (snapshot a wired set of tiles for re-instantiation).
- `promptLibraryStore` — User-managed library of agent prompts injectable at spawn time.
- `settingsStore` — Centralized Settings modal state (project + pipeline-skills sub-panels).
- `wiringStore` — Wire definitions kept separate from `canvasStore` to avoid render churn on wire-data updates.
- `toastStore`, `timelineStore`, `clipboardStore`, `paletteStore`.

**Tile system:** 16 types via discriminated union in `types/index.ts` (agent, terminal, editor, diff, note, todo, kanban, filetree, git, browser, runner, ssh, docker, usage, group, pipeline-controller). Each has a component in `components/tiles/`. `TileShell.tsx` (memo'd) wraps every tile with drag + resize + snap + z-order + title-bar chrome (5 buttons: pin/clone/detach/template/close, shown on hover).

- **DiffTile** — three modes via tabs: **Git changes** (sidebar lists `git status --porcelain` files, click one → diff vs HEAD via `git_show_head_file`), **Compare files** (two native file pickers using `@tauri-apps/plugin-dialog`), **Paste** (two textareas → Monaco DiffEditor). Mode + per-mode state (`gitTarget`, `compareLeft/Right`, `pasteOriginal/Modified`) all live on the tile. Back-compat: `mode` optional, defaults to `'git'`.

**Canvas (`components/canvas/`):** `InfiniteCanvas.tsx` is the workhorse — transform layer, rubber-band (Shift+drag), snap guides, sticky notes, workspace tabs, minimap, tile dock, auto-save (2s disk + 500ms localStorage cache), auto-snapshot (every 5 min for time-travel).

- **TileDock** (`TileDock.tsx`) — user-customizable via the ⚙ panel (show/hide, drag-to-reorder; up/down arrow fallback). Stored per-device in `localStorage['tx-dock-items']` as a `DockEntry[]` discriminated union: `{kind:'type', type: TileType}` for generic tile buttons OR `{kind:'template', templateId: string}` for pinned templates. Pinning a template from the "+ Add Tile" menu (★ icon) creates a `template` entry — so e.g. a pinned "Codex" button spawns with Codex config, not a generic Agent default. Legacy `string[]` storage auto-migrates. Changes broadcast via `window` event `tx-dock-updated` so the Add Tile menu's ★/☆ state stays in sync.

- **Layout menu** (`TopBar.tsx → LayoutMenuButton`) — dropdown with the built-in Default workspace + 5 user save slots per project. Stored at `localStorage['tx-layouts-${pid}']` as `(LayoutSlot | null)[5]`. The legacy single-slot key `tx-saved-layout-${pid}` auto-migrates into slot 1 and is removed on first open. Empty slot click = save; filled slot click = load; ↻ = overwrite; ✕ = delete (confirm).

- **Clear Canvas** — next to Layout in TopBar. Confirms with tile count before calling `removeTile` for each.

- **Column-major spawn grid** — `spawnTileFromEntry` anchors at screen `(24, 24)` → canvas coords, lays tiles in 3-tall columns (slot pitch 700×500, 8px gap), skipping overlaps. This is deliberate UX — users expect predictable spawn positions, not "somewhere near the viewport center."

**IPC (`utils/ipc.ts`):** All `invoke()` calls wrapped here. Components never call `invoke()` directly. Includes: PTY, agents, 12 git commands (incl. `git_show_head_file`), docker, workspace, `read_file_tree` / `read_file_text` / `write_file_text`, projects, timeline, and `http_fetch` (HTTP proxy with SSRF guards).

### Backend (`src-tauri/`)

Entry: `main.rs` → `lib.rs` (Tauri builder, plugin registration, PTY cleanup on `WindowEvent::Destroyed`).

**Commands (`commands/`):**
- `terminal.rs` — PTY lifecycle. Writes chunked to 256 bytes (Windows pipe buffer safety). **Public `pty_spawn` uses `SHELL_ALLOWLIST`** (bash/zsh/sh/fish/powershell/cmd/ssh/docker). **Internal `pty_spawn_internal`** bypasses the allowlist for trusted callers (agent spawn).
- `agents.rs` — Claude/Codex/Gemini. Windows wraps through `cmd.exe /C` for `.cmd` scripts. Validates custom command args (null bytes + 16KB cap). Routes through `pty_spawn_internal`.
- `git.rs` — 11 commands. `validate_git_url()` rejects `ext::` / `transport::` remote helpers, loopback hosts, malformed URLs. Clone uses `git -c protocol.ext.allow=never -c protocol.file.allow=never` + `--` to block remote-helper RCE. Branch names validated against refname rules.
- `http_proxy.rs` — `http_fetch` for MCP API calls. **SSRF-hardened:** blocks RFC 1918 private IPs, CGNAT (100.64/10), link-local, loopback, multicast, IPv6 ULA (fc00::/7), URL credentials. HTTPS-only for non-loopback hosts. 10MB response / 5MB body caps.
- `filesystem.rs` — `read_file_tree`, `read_file_text`, `write_file_text` all share `is_path_allowed` (anything under `$HOME` / common project roots like `/Users`, `/Volumes`, `/workspace`, `/home`, `C:\Users`, etc.). Symlink skip prevents infinite recursion. 10MB read cap. Directory watchers validated (exists + is_dir) and deduplicated.
- `git.rs` (cont'd) — `git_show_head_file(repo_path, file_path)` runs `git show HEAD:path` for the DiffTile's "original" side; returns empty string (not error) when the file is new / unknown to HEAD.
- `docker.rs` — `tokio::process::Command` (not PTY). UTF-8-safe truncation + 500-container cap.
- `workspace.rs` — Atomic writes via temp-file + rename. `sanitize_name` rejects path separators, `..`, null bytes, colons, 255+ chars. Snapshot list capped at 10k.
- `projects.rs` — Persisted to `~/.config/terminalx/projects.json`.
- `timeline.rs` — Event recording capped at 10k with `rotate_left + truncate`.

**State (`state/`):** `AppState` owns `PtyManager`, `AgentRegistry`, `Timeline`, `Watchers` — all behind `parking_lot::Mutex`. `PtyManager` implements `Drop` for automatic cleanup. Session IDs are uniqueness-checked on insert.

**Security (`capabilities/default.json`):** `fs:default` has explicit allow (`$APPDATA/**`, `$APPCONFIG/**`, `$APPLOCALDATA/**`, `$DOCUMENT/**`, `$DESKTOP/**`, `$HOME/Projects/**`) and per-scope deny lists for `.env`, `.ssh/**`, `.aws/**`, `.config/gcloud/**` rooted under each allowed scope (not a top-level `**/.env`). CSP has no `'unsafe-inline'` in `script-src`.

## Critical Patterns

### #1 CRASH CAUSE: Zustand selectors creating new objects

NEVER create new objects/arrays inside a Zustand selector. This is THE source of infinite render loops.

```ts
// ❌ INFINITE LOOP — creates new array every render
useCanvasStore(s => s.tiles[s.activeProject] || [])

// ✅ CORRECT — stable reference via module-level constant
const EMPTY_TILES: Tile[] = [];
useCanvasStore(s => s.tiles[s.activeProject] ?? EMPTY_TILES)
```

Applies to `|| []`, `|| {}`, `?? []`, `?? {}` inside ANY `useXxxStore(s => ...)`.

### xterm keyboard capture

xterm's hidden `<textarea>` can't receive focus inside WebView2's CSS-transformed canvas. `xtermInput.ts` bypasses it entirely — captures `keydown` on the container div and translates keys to VT sequences. Also handles image paste (saves to file, pastes path). Applied in all 4 xterm consumers: TerminalTile, AgentTile, TerminalPane, RunnerTile.

### PTY write chunking

Large PTY writes get truncated on Windows. `PtyManager.write()` chunks ALL writes to 256 bytes with flush between each. Frontend auto-dispatch (TodoTile) additionally chunks at 128 bytes with 50ms delay before sending `\r`.

### Agent spawn pipeline

`agentSpawn` IPC → resolves binary (claude/codex/gemini or custom command) → validates args → on Windows wraps in `cmd.exe /C` → calls `pty_spawn_internal` (NOT `pty_spawn` — bypasses SHELL_ALLOWLIST because agents aren't shells) → injects agent memory context after 2s delay.

### Tauri event listener cleanup

`onPtyOutput`, `onPtyExit`, `onAgentStatus` return `Promise<UnlistenFn>`. Use a `mounted` flag pattern in useEffect cleanup to handle the async resolution race.

### Canvas coordinate conversion

`(screenX - transform.x) / transform.scale`. Use `screenToCanvas()` from `utils/layout.ts`.

### Platform detection

`utils/platform.ts` — synchronous `isMac()` / `isWindows()` / `modShortcut('K')` helpers. Used to hide custom window buttons on macOS (native traffic lights render via `titleBarStyle: "Overlay"`) and to show `⌘K` vs `Ctrl+K` labels.

### Light theme surface inversion

When `isLightBg()` is true, `applyThemeToDOM()` sets dark surface colors so tiles and chrome stay dark with white text while the canvas background is light. xterm terminals also flip via `isLightTheme()` in each terminal component.

## Pipeline Templates (v0.2.0 — end-to-end execution)

Multi-tile templates that lay down a wired set of agent + helper tiles + a `pipeline-controller` tile, owned by `pipelineStore`. v0.2.0 ships the whole pipeline end-to-end: state machine, worktree isolation, live PTY routing, sentinel parsing, single + dual reviewer, red-team, merger, failure bundles, persistence + reload survival. See `docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md` for the original design and `2026-05-04-...-addendum.md` for the post-v1 roadmap.

**State machine** lives in `src/pipeline/state-machine.ts` as a pure reducer; `src/stores/pipelineStore.ts` wraps it. Direct dispatch via `usePipelineStore.getState().dispatch(runId, event)`. The reducer guarantees identity preservation on no-op transitions, and `pipelineStore.dispatch` short-circuits to avoid re-render churn.

**Worktree IPCs** (`pipeline_worktree_create` / `pipeline_worktree_destroy`) and `pipeline_preflight` validate path/branch args against control-char + shell-metachar checks per the same pattern as `agent_spawn` (see `commands/agents.rs`). Cross-platform: cleanup uses `git worktree remove --force` plus a fallback `remove_dir_all` for cases where git's removal misses files.

**Skills installation** (`pipeline_install_skills`) bundles five SKILL.md files inside the app via Tauri `bundle.resources` (`src-tauri/resources/skills/**/*`): `tx-pipeline-stage-handoff` (sentinel emission contract), `tx-pipeline-reviewer` (reviewer rubric incl. invariant-violation = blocker), `tx-pipeline-red-team` (adversarial pass for complex runs), `tx-pipeline-builder-scratchpad` (`.tx-builder-notes.md` discipline), `tx-pipeline-subagent` (one-level Builder delegation contract). On first mount, `App.tsx` invokes the Rust command which resolves the bundle via `app.path().resource_dir()` and copies any missing skill into `~/.claude/skills/<name>/`. Existing skills are left alone (no auto-overwrite — Phase 3 ships an explicit upgrade UI). Per-skill copy errors are recorded in `errors: string[]` and surfaced as `console.warn` but never crash the app. Skill-provenance verification (SHA-256 hash baked at build time) runs before each copy and skips per-skill on mismatch.

**Sentinel scanner** (`src/pipeline/sentinel-scanner.ts`) — pure parser for the four sentinels (`<<<TX_STAGE_DONE>>>`, `<<<TX_STAGE_FAILED>>>`, `<<<TX_STAGE_QUESTION>>>`, `<<<TX_HEARTBEAT>>>`) emitted by agents per the `tx-pipeline-stage-handoff` skill. Strips ANSI codes, finds the first marker, extracts a balanced JSON object (string-aware so braces inside strings don't fool it), returns `null` on incomplete input so the caller can buffer more PTY chunks and retry.

**Controller runtime** (`src/pipeline/controller-runtime.ts`) glues the scanner to `pipelineStore`. `ingestPtyChunk` accumulates per-PTY-id buffers (64KB cap with runaway-discard) and dispatches `PipelineEvent`s on every complete sentinel found. `ingestOneshotResult` is the headless analog for the Reviewer's `agent_run_oneshot` invocation. `parse_error` from the scanner becomes a `planner_failed` (planner role) or `abort` (other roles) so a misbehaving agent can never hang the run.

**One-shot agent execution** (`agent_run_oneshot` Rust IPC) — wraps `tokio::process::Command` for the Reviewer stage. Spawns the agent CLI with `--print` / `exec`, pipes stdin, captures stdout/stderr/exit_code, honors a timeout (default 600s). No PTY allocation. Phase 2b uses this for the Reviewer; Phase 3 may extend to the custom-command escape hatch.

**Telemetry JSONL** (`pipeline_telemetry_log` Rust IPC) — `pipelineStore.dispatch` fire-and-forgets one JSONL line to `<projectDir>/.terminalx/pipeline-telemetry/<runId>.jsonl` on every state transition. Schema: `{at, event, runId, from, to, trigger}`. Append-only via `OpenOptions::append(true)`. Rejects payload newlines (would break JSONL framing) and run_ids outside `[a-zA-Z0-9_-]+`.

**Default template:** `Anthropic Trio` (`anthropicTrioTemplate()` in `src/pipeline/templates.ts`) — Opus Planner, Sonnet Builder, Opus Reviewer with the full skill-bindings list per spec §10. Phase 2b ships the template; Phase 2c authors the role prompts that consume it.

**CI hook** (`src/pipeline/ci-watcher.ts`, `src/pipeline/verification-chain.ts`, Rust `pipeline_run_verification_step` in `src-tauri/src/commands/pipeline.rs`) — while a run is in `building`, `startCommitWatcher` subscribes to `<worktree>/.git/refs/heads/<branch>` via the existing `watchDirectory` IPC. On each new HEAD it calls `resolveVerificationChain` (per-ecosystem auto-detect from package.json / Cargo.toml / pyproject.toml, or a template `templateOverride` that bypasses detection), then runs each step through the Rust IPC. One `ci_pass` is dispatched per passing step; the chain stops on the first failure and dispatches a single `ci_fail`. A 250ms debounce collapses git's lock-rename burst into one chain run. State-bounded: the chain bails before each step if the run has left `building`. Concurrency-safe via an `inFlight` + `pending` flag pair — overlapping fires coalesce into at most one queued re-run.

**Plan immutability** (`src/pipeline/plan-versioning.ts`, `state-machine.ts` `replan_requested` event) — every successful `planner_done` appends the plan commit SHA to `PipelineRun.planLineage`. The `escalated` state is terminal except for the narrow `replan_requested` carve-out: from `escalated` it re-enters `planning` and appends an `EscalationEntry { decision: 'replan' }` to `escalationLog`. The next `planner_done` writes its new plan file at `versionedPlanPath(originalPath, currentLineageLength)` — `docs/plan.md` → `docs/plan-v2.md`, `-v3.md`, etc. The original v1 stays on disk; nothing is mutated. The controller (Phase 2c-iii) is the writer of the v2/v3 file content; this phase ships the data structure + path helper only.

**Full fingerprint** (`src/pipeline/fingerprint.ts`, `src/pipeline/run-factory.ts`) — Phase 1's `computeMinimalFingerprint` only hashed the template object + version. Phase 2c-i adds `computeFullFingerprint`, which additionally hashes each bundled SKILL.md content, each role's resolved prompt, each role's `RoleCapabilities` (canonical-JSON-hashed so key order is irrelevant), and the optional project-root `INVARIANTS.md`. Production callers go through `createRunFromTemplate` (the factory entry point) which bundles content reads + fingerprint + `pipelineStore.createRun` in one call. Tests still use `computeMinimalFingerprint` for speed. `defaultRunFactoryDeps` reads files via the `readFileText` IPC; ENOENT-shaped errors are silently treated as "missing optional file", anything else (permission denied, IPC validation) is `console.warn`-logged so it doesn't silently corrupt fingerprint determinism.

**Rust submodule layout** — `src-tauri/src/commands/pipeline.rs` was split into `pipeline/{mod, preflight, worktree, skills, telemetry, verification, merger, guardrails, capabilities, skill_provenance}.rs` once the surface grew past 1000 lines. `mod.rs` re-exports the `pub`-marked commands and hosts the shared `validate_path_arg`. New work goes in the right submodule; cross-submodule helpers go via `pub(super)` from `mod.rs`.

**Merger** (`pipeline/merger.rs`, `src/components/pipeline/MergerConfirmModal.tsx`) — `pipeline_merger_run` auto-detects a GitHub remote (`gh repo view --json owner,name`); if present, opens a PR via `gh pr create --json url -q .url` (the `--json` form is the only reliable way to capture the PR URL — gh's plain stdout has historically had banner lines). If no remote, performs `git switch <main> && git merge --no-ff <branch>` locally. **Confirm-token gate**: every `pipeline_merger_run` call must include a `confirm_token` issued by `pipeline_merger_request_token(run_id)`. Tokens are one-shot, 5-min TTL, run-id-bound, stored in a process-local `OnceLock<Mutex<HashMap<...>>>` with cap-1024 oldest-first eviction (defense against rogue IPC callers issuing without consuming). Wrong run-id does NOT consume the token (probe-resistant). Branch-name validation runs AFTER token consumption so probing other inputs can't infer token validity. Runtime failures fold into `MergerResult { status: 'success' | 'failure' | 'invalid_token', mode, pr_url, detail }` — IPC never returns Err for runtime issues. The UI confirm modal renders on `awaiting_merge_approval`, shows headSha + commits + reviewer verdicts + both shell-command previews ("Will run one of these (auto-detected at merge time)"), dispatches `approve_merge` BEFORE `pipelineMergerRun` so telemetry captures the intermediate `merging` state.

**Guardrails hook** (`pipeline/guardrails.rs`, `src/pipeline/guardrails-lifecycle.ts`) — on transition out of `idle`, install a `PreToolUse` entry into the worktree's `.claude/settings.json` referencing `git-guardrails-claude-code`'s `block-dangerous-git.sh`. Marker `"tx-pipeline-managed": true` on each entry we add; uninstall removes only marked entries (user-added hooks survive). On terminal state, uninstall. Idempotent: install twice produces no duplicates. Atomic write via temp+rename with a Windows fallback for cross-device renames. The lifecycle handler dedupes per-run so one transition fires one IPC.

**Role capabilities** (`pipeline/capabilities.rs`, `src/pipeline/role-capabilities.ts`, `src/pipeline/capabilities-lifecycle.ts`) — `defaultRoleCapabilities(role)` produces per-role allow/deny lists per spec §17.1. Translated to Claude Code's `permissions.allow` / `permissions.deny`: shell→`Bash(<pattern>)`, fileWrites→`Write(<glob>)` + `Edit(<glob>)`, network→`WebFetch(domain:...)` for `package-managers` mode (npm/yarn/crates/pypi/golang/rubygems registries) or universal `WebFetch`/`WebSearch` deny for `none`, mcpTools→`mcp__<tool>__*`. Reviewer is read-only (`fileWrites.allow=[]`, `deny=['**']`). Builder is tree-wide allow with deny on `.git/`, `node_modules/`, `target/`, `dist/`, `.tx-worktrees/`, `.terminalx/`. The settings root carries a `_tx_pipeline_capabilities[<role>]` marker recording the exact strings we appended; uninstall reads the marker and removes only those literal strings (user-authored entries that happen to match are preserved one-occurrence-per-record). Lifecycle handler installs/uninstalls on state→role transitions: `planning→planner`, `building→builder`, `reviewing→reviewer`, anything else uninstalls.

**Skill provenance** (`pipeline/skill_provenance.rs`, `src-tauri/build.rs`) — `build.rs` SHA-256-hashes each bundled `resources/skills/<name>/SKILL.md` at compile time and emits a generated `SKILL_HASHES: &[(&str, &str)]` constant via `OUT_DIR/skill_hashes.rs`. `pipeline_install_skills` calls `verify_skill(name, &bytes)` before each copy; on hash mismatch the install records an error and skips that skill (per-skill skip, not whole-batch fail). Adapted from the spec's "ed25519-signing-with-release-key" pattern to a hash check — the Tauri binary itself is already codesigned at release (codesign on macOS, Authenticode on Windows), so this catches the only meaningful attack: post-extraction tampering with the resource bundle without re-signing.

**Preflight extension** (`pipeline/preflight.rs`) — `PreflightResult` gains three fields: `signed_skills_ok` (every installed bundled skill matches its build-time hash; vacuous true if no skills installed yet), `capability_binaries_ok` (`git` is on PATH; `gh` is reported separately via `gh_present` since the local-merge fallback works without it), `skill_cache_writable` (probe-write to `~/.claude/skills/` or its first existing parent). `run_preflight_inner` was refactored to take `home_dir: Option<&Path>` so tests inject a temp dir without process-global env mutation.

**Lifecycle telemetry** (`src/stores/pipelineStore.ts::TelemetryEvent`) — Phase 2c-ii widens `TelemetryEvent` to a discriminated union: `state_change` (Phase 2b), `capability_install`/`capability_uninstall`/`guardrails_install`/`guardrails_uninstall` (lifecycle, with `ok: bool` + optional truncated `error`), `merger_invoked`/`merger_completed` (merger, with `status`/`mode`/`detail`). `emitTelemetry(event)` is exported for consumers outside the reducer (lifecycle handlers, the merger modal). Lifecycle handlers wrap their IPC calls in try/catch and emit ok=false on failure rather than letting one failure hide subsequent events.

**App.tsx lifecycle composition** — the single `LifecycleEmitter` slot fans out to `handleGuardrailsLifecycle`, `handleCapabilitiesLifecycle`, and `handleFailureBundleLifecycle` via an inline closure, each wrapped in try/catch so a synchronous throw in one doesn't swallow the others. The first two operate on disjoint `.claude/settings.json` keys (`hooks.PreToolUse` vs `permissions.*` + `_tx_pipeline_capabilities`); the third writes a tarball to `<projectDir>/.terminalx/failure-bundles/` on terminal-failure transitions. Order doesn't affect correctness.

**Settings modal** (Phase 3a.1) — Zustand-backed at `src/stores/settingsStore.ts`; modal at `src/components/settings/SettingsModal.tsx`. Opens via the TopBar gear or programmatically `useSettingsStore.getState().openAt(category)`. Sub-panels under `src/components/settings/{ProjectSettings,PipelineSkillsSettings}.tsx`. Escape closes via a window-level keydown listener; click-outside does NOT (a half-typed webhook URL would silently lose work).

**Sensitive-paths gate** (Phase 3a.3) — `createRunFromTemplate` now runs `preflight` first when both `deps.preflight` and `input.projectDir` are wired. If `sensitive_paths_found.length > 0` AND a `confirmSensitivePaths` callback is provided, the factory awaits user confirmation BEFORE fingerprint compute / store insertion. Cancel returns `{ runId: '', aborted: true }` so the caller can tear down any worktree it created upstream — the factory does not own the worktree lifecycle. UI lives at `src/components/pipeline/SensitivePathsModal.tsx`. Both deps are dep-injected so the factory itself stays UI-framework-free; existing fixtures that pre-date the gate (no `preflight` dep) skip it.

**Webhook re-cadence** (Phase 3a.5) — `Project.webhookCadence: 'entry-only' | '15min' | '1hr' | '4hr' | 'daily'`. Default `entry-only` matches the Phase 2c-iii.4 ship behavior so existing integrations don't suddenly start receiving reminder pings. Wider cadences cumulate from `firstNoticeAt` (NOT from the previous reminder) — `15min` fires entry + 15min, `1hr` fires entry + 15min + 1hr, etc. The notifier reads cadence fresh per tick (via `getWebhookCadence(projectId)`) so Settings UI changes apply mid-run without restart.

**Settings.json marker namespace** (Phase 3a.6) — guardrails + capabilities markers are unified under the `_tx_pipeline_managed` namespace (`_tx_pipeline_managed_entry: true` on per-hook entries; `_tx_pipeline_managed.capabilities[<role>]` for capability blocks). `migrate_in_place` runs idempotently on every install/uninstall so legacy `tx-pipeline-managed` (kebab-case) and `_tx_pipeline_capabilities` (separate top-level key) markers are detected and rewritten in place — half-migrated files stay consistent. See `src-tauri/src/commands/pipeline/managed_marker.rs`.

**Clarification flow** (`src/components/pipeline/ClarificationModal.tsx`, `state-machine.ts` `priorActiveState` field) — agents emit `<<<TX_STAGE_QUESTION>>>` sentinels per the `tx-pipeline-stage-handoff` skill; `controller-runtime.ts` dispatches `question_raised` which transitions `<active> → awaiting_clarification` AND captures the exiting state on `run.priorActiveState`. The modal renders on `awaiting_clarification` + non-empty `questions[]`, shows the latest question's text + collapsible context + agent-suggested option buttons + free-text input. Submit calls a DI'd `injectAnswer` (writes to the role's PTY when live, no-op for one-shot agents — telemetry captures the answer regardless), then dispatches `clarification_received`. The reducer reads `priorActiveState`, validates it's still in `ACTIVE_STAGES`, resumes the run there, and clears the field. Missing/invalid `priorActiveState` is a defensive abort to `failed` (unreachable from normal flow). Cancel triggers `abort` with reason `clarification_cancelled`.

**Heartbeat + stuck detection** (`src/pipeline/stuck-detector.ts`, controller-runtime liveness map) — `<<<TX_HEARTBEAT>>>` sentinel now dispatches a `heartbeat` event that updates `PipelineRun.lastHeartbeatAt` (was a no-op). A module-level `Map<runId, lastStdoutAt>` is bumped on every non-empty `ingestPtyChunk`/`ingestOneshotResult`. `startStuckDetector` ticks every 250ms; for each non-terminal run, if `now - max(lastHeartbeatAt, lastStdoutAt, startedAt) > 5min` it probes the role's PTY with `"Are you stuck?\n"` (once per quiet window). At 8min total silence it dispatches `abort` with `failureClass: 'stage_unresponsive'`. Per-run probe-bookkeeping lives inside the detector (not on `PipelineRun`) so HMR reloads start clean and the reducer stays free of detector concerns. Wired in `App.tsx` via DI'd `getActiveRuns` / `probeAgent` / `abortRun` / `now` callbacks (mirrors run-factory pattern).

**OS notifications** (`src/pipeline/notifications.ts`) — `startNotifier` snapshots `pipelineStore` every 1s, fires `sendNotification({ title, body })` on every transition INTO an `awaiting_*` state. Title: `<projectName or 'TerminalX'> — <runId>`; body: state name + a one-liner (question text on clarification, branch name on merge, "Plan ready for review" on plan approval, etc., truncated to 80 chars). Re-cadence is **cumulative from `firstNoticeAt`** at 15min / 1hr / 4hr / 24hr / then daily. Bookkeeping cleared on state-exit; re-entering an `awaiting_*` state resets to idx=0. Send failures (sync throws + rejected promises) are swallowed so a misbehaving notification API can't crash the tick.

**Webhook delivery** (`src/pipeline/webhook-notifier.ts`) — `Project.webhookUrl` (https-only, validated at the App.tsx deps boundary) is the per-project opt-in. On every transition INTO an `awaiting_*` state the notifier POSTs `{ runId, state, project, branch, summary, terminalxDeepLink }` through the existing `httpFetch` Rust proxy, with the JSON body passed through `secretsMask` first so leaked tokens in question text never reach the wire. Entry-only re-cadence (no 15min reminders — webhooks pipe to systems that persist events; chat/issue trackers don't want Phase-2c-iii.3-style duplication). Errors swallowed via `console.warn`. UI for configuring `webhookUrl` is deferred to Phase 3; the delivery infra ships now so Phase 3 only adds settings UI.

**`secretsMask` + telemetry hygiene** (`src-tauri/src/commands/secrets_mask.rs`) — pure Rust function detects and masks secrets in arbitrary text. Three rule layers in order: PEM blocks (`-----BEGIN [TYPE]-----...-----END [TYPE]-----` → `<MASKED:PEM>`); known-prefix tokens (`sk-`, `ghp_`, `gho_`, `xoxb-`, `xoxp-`, `AKIA`, `ASIA`, `AIza`, `ya29.`, `glpat-` → `<MASKED:abc123>` with stable 6-char SHA-256 prefix); high-entropy `KEY=VALUE` / `"key": "VALUE"` / `key: VALUE` strings ≥24 chars with Shannon entropy ≥4.5 bits/char, with pure-hex (git SHAs, lock-file checksums) and `sha\d+-` (lock-file integrity hashes) excluded. Idempotent — `mask_secrets(mask_secrets(s)) == mask_secrets(s)`. Wired into `pipeline_telemetry_log` so every JSONL line goes through masking before disk write; exposed as `secretsMask` TS IPC for explicit callers (webhook delivery, failure bundle).

**Sensitive-path scan** (`pipeline/preflight.rs::scan_sensitive_paths`) — preflight walks the project tree (depth-bounded to 4, skipping `.git/`, `node_modules/`, `target/`, `dist/`, `build/`, `.tx-worktrees/`, `.terminalx/`, `.next/`, `.cache/`) for filenames matching the `.env`, `.env.*`, `secrets.*`, `*.pem`, `*.key`, `*.kdbx`, `id_rsa*`, `id_ed25519*`, `*.p12`, `*.pfx`, `gcp-key*`, `aws-credentials`, `*.ovpn` set. Matches surface as `PreflightResult.sensitive_paths_found: string[]` (capped at 50). Phase 3 wires the Acknowledge / Cancel toast UI; the data is plumbed now so the eventual UI doesn't need a second IPC call.

**Failure bundle** (`src-tauri/src/commands/failure_bundle.rs`, `src/pipeline/failure-bundle-lifecycle.ts`) — on transition into `failed`/`escalated`, the lifecycle handler calls `pipeline_failure_bundle_generate` which writes `<projectDir>/.terminalx/failure-bundles/<run-id>.tar.gz` containing: `telemetry.jsonl` (the existing `pipeline-telemetry/<run>.jsonl`), `artifacts.json`, `preflight.json`, `git_status.txt`, `git_diff.txt` (capped at 5MB), `versions.txt`. Every text artifact passes through `mask_secrets` again before tar-archiving (defense-in-depth — telemetry.jsonl is already masked, but a hostile artifact field could carry an unmasked secret if the frontend forgot). `run_id` is whitelisted `[A-Za-z0-9_-]+` ≤128 chars to block path traversal. Bookkeeping in the lifecycle handler dedupes per run so a multi-failure transition fires the bundle once. Failing to write a bundle never blocks run cleanup — errors are `console.warn`-logged and the lifecycle continues.

**Builder scratchpad** (`tx-pipeline-builder-scratchpad` skill, `src/pipeline/scratchpad-watcher.ts`) — Builder maintains `<worktree>/.tx-builder-notes.md` with a pinned format (open task, decisions, next step, blockers). Controller checks scratchpad mtime on every Builder sentinel/heartbeat; 10min of activity without a scratchpad write injects a synthetic `<<<TX_STAGE_QUESTION>>>` that counts against the 3-question budget — forcing Builder to either pause and document or invoke the refusal protocol. Sibling to `stuck-detector.ts`: that one fires on PTY *silence*, this fires on PTY activity that lacks scratchpad writes. Per-run `pendingProbe` debounce so each stagnation window fires exactly one probe.

**Sub-agent delegation** (`tx-pipeline-subagent` skill, `agent_run_oneshot` `system_prompt` + `working_files` extensions) — Builder may delegate self-contained tasks (acceptance criterion verifiable in one sentence) to one-shot sub-agents via `agent_run_oneshot`. Brief is structured: parent task, exact file globs, acceptance, branch, run id. Hard limits enforced behaviorally by the skill (no recursion — one-level delegation only, no CI, no push, file-globs-only). Builder verifies claimed commits/files post-hoc. Sentinels `<<<TX_SUBAGENT_DONE>>>` / `<<<TX_SUBAGENT_FAILED>>>` are telemetry-only (`subagent_completed` event) — no state-machine transition because invocation lives within a Builder task.

**Compaction checkpoints** (`src/pipeline/compaction-watcher.ts`) — Builder PTY output >200KB since last sentinel triggers a controller-written prompt: "Summarize progress so far in ≤500 tokens; identify next concrete action; resume." Builder responds with `<<<TX_COMPACTION_DONE>>>{summary}`; controller appends to the `## Compaction summaries` section of `.tx-builder-notes.md` (atomic write via `writeFileText`). Pending flag prevents re-fire while Builder is composing the summary. Distinct from the 64KB scanner-buffer cap in `controller-runtime` — that's a parser memory bound; this is the LLM-context trigger.

**INVARIANTS.md grounding** (`src/pipeline/role-prompt-injection.ts::substituteInvariants`) — All three role prompts include `{INVARIANTS_PLACEHOLDER}`; spawn-time injection reads `<projectDir>/INVARIANTS.md` (re-read per spawn so mid-run edits land on the next role) and substitutes the content. Missing/empty file → `(none specified — proceed with role defaults)` fallback. Reviewer treats invariant violations as `blocker` severity (codified in both the role prompt and `tx-pipeline-reviewer` skill). The factory still hashes the same file at run-creation for the run fingerprint (Phase 2c-i).

**Plan complexity gate** (`PipelineRun.runMode`, `state-machine.ts`) — Planner emits `complexity: 'trivial' | 'standard' | 'complex'` on its DONE sentinel. Reducer stamps derived flags: trivial auto-skips `awaiting_plan_approval` and halves retry budgets (floor + min 1); standard runs the normal flow; complex enables dual-reviewer + red-team and doubles budgets. Re-stamping uses the immutable `templateRetryBudget` / `templateDualReviewer` baselines captured at run creation, so a replan from complex→trivial halves the *standard* template baseline (not the prior complex-doubled value) — addendum §A4 "re-plans are full resets".

**Required confidence + uncertainty escalation** (`role-prompts/*.md`, `controller-runtime.ts::maybeEscalateUncertainty`) — All DONE sentinels carry a required `confidence: 'verified' | 'likely' | 'uncertain'` field. Missing/invalid → `planner_failed` (planner) or `abort` (other roles). When `uncertain` + non-trivial diff (Builder/Reviewer: ≥5 files OR ≥3 commits; Planner: ≥3 tasks), a synthetic `question_raised` fires AFTER the role's normal `*_done` transition — so e.g. Builder advances `building → reviewing` then the synthetic question moves `reviewing → awaiting_clarification`. Resume target is the post-transition state (forward progress, not the role we just left). Counts against the same 3-question budget as agent-emitted clarifications.

**Dual-reviewer + tiebreaker** (`dual-reviewer-dispatcher.ts`, `state-machine.ts`) — `useDualReviewer` (set by `complexity=complex` OR template flag) routes `building → awaiting_dual_reviewer`. The dispatcher (lifecycle-emitter-driven) fires both `reviewer` (Opus) and `reviewer-codex` one-shots; the reducer reconciles two verdicts by reviewer key: both approve → merger gate (or red-team for complex), both reject → loop+counter, disagree → `awaiting_tiebreaker` with no counter bump. Disagreement re-fires the dispatcher with `provider: 'gemini'` (third major provider — hardcoded today, future-proofed in the telemetry shape). Tiebreaker verdict is decisive: approve → merger gate, reject → loop+counter.

**Red-team role** (`role-prompts/red-team.md`, `tx-pipeline-red-team` skill) — Spawned on `runRedTeam` (set by complex complexity) AFTER reviewer approval, BEFORE merger. `postReviewerApprovalState` helper routes single/dual/tiebreaker approves through `awaiting_red_team` when the flag is set. Red-team reads diff + plan + spec for adversarial patterns across five categories (supply-chain, prompt-injection, secret-exposure, race-condition, edge-case) plus `other`. Sentinel: `<<<TX_REDTEAM_DONE>>>` / `<<<TX_REDTEAM_FAILED>>>`. ≥1 `blocker` finding → `failed` with `failureClass: 'red_team_blocker'` (non-recoverable; user can `replan_requested` from `escalated`, not `failed`). Concerns + nits surface in `artifacts.redTeamReports` for the merger modal — non-blocking by design.

**Trust telemetry** (`pipelineStore.ts::TelemetryEvent`) — Five new variants composed alongside `state_change` at every relevant transition: `complexity_routed` (fires on every `planner_done`, captures complexity + derived flags), `confidence_uncertain_escalated` (per-role with diff metrics + uncertaintyDrivers), `dual_reviewer_disagreement` (records both verdicts on the disagree → tiebreaker transition), `tiebreaker_invoked` (emitted by the dispatcher when it fires the third provider — distinct from the disagreement event so dashboards can count "noticed" vs "resolved"), `red_team_finding` (one event per finding, regardless of severity, emitted BEFORE the dispatch so blockers still surface their findings even when the reducer routes the run to `failed`).

## Pass-Through Contracts

### Reading project files: use the Rust IPC, not the fs plugin

**Use `readFileText` / `writeFileText` from `utils/ipc.ts`, never `@tauri-apps/plugin-fs`** for user project files.

The `@tauri-apps/plugin-fs` capability scope in `capabilities/default.json` is intentionally narrow (`$APPDATA/**`, `$HOME/Projects/**`, etc.) — it fails with `"forbidden path ... not allowed on the scope for allow-read-text-file"` on common project locations like `$HOME/.claude/projects/...`, `$HOME/code/...`, etc. `read_file_text` / `write_file_text` in `filesystem.rs` use the same broad `is_path_allowed` validator as the file tree (anything under `$HOME` or common project roots), so they "just work" for any file the user can reach through the tree. EditorTile, DiffTile, CommandPalette import/export all route through these.

### Canvas overlays and the wheel handler

Any overlay UI with its own scrollable content (TileDock customize panel, LayoutMenu, future popovers) must have `data-canvas-overlay` somewhere in its ancestor chain. The wheel handler in `useCanvas.ts` bails when `target.closest('[data-canvas-overlay]')` matches, so scrolling inside the overlay doesn't hijack canvas zoom. Same attribute is checked by `InfiniteCanvas` rubber-band and `useCanvas` pan handlers to avoid stealing pointer events.

### HTTP proxy for MCP

MCP API calls (Slack/GitHub/Linear/Jira/Notion) MUST go through `httpFetch` (Rust proxy) — direct `fetch()` is blocked by WebView CSP + CORS. The proxy also enforces SSRF guards.

### Plugin sandbox boundary

`PluginTile` iframe uses `sandbox="allow-scripts allow-forms"` — no `allow-same-origin`, no `allow-popups`. `postMessage` targets the plugin's origin specifically (not `*`). Received messages validate `e.origin` against `plugin.entryUrl`.

## Key Data Flows

**PTY:** TerminalTile → `usePty` → `ipc.ts (ptySpawn)` → `terminal.rs` → `portable-pty` → reader thread → `emit("pty-output")` → frontend `listen` → `xterm.write()` + `canvasStore.wireData` + `recordingStore`.

**Wiring:** `useWiringEngine` subscribes to canvasStore. 6 wire types — `context-pipe`, `agent-chain`, `refresh-trigger`, `task-assign`, `diff-feed`, `file-open`. Agent chains pipe last 50 lines on completion (triggered by DONE sentinel or 8s idle, not process exit). `file-open` (FileTree → Editor/Diff) is a click-routed wire, not data-driven — the click handler in `FileTreeTile` checks for outgoing `file-open` wires and updates the target's `filePath` / `gitTarget` / `compareLeft|Right` in place instead of spawning a new editor. Auto-recovery: Runner `status === 'fail'` + wire to Agent → error auto-dispatched to agent PTY.

**MCP tasks:** `syncConnection` → `httpFetch` IPC → JSON parse → filter by `seenTaskIds` → TodoTile "FROM INTEGRATIONS" panel. Auto-dispatch: if "Auto" toggle on, new tasks are chunk-written to agent PTY with `\r` after.

**Persistence:** 3 layers — (1) localStorage cache (500ms, quota-exceeded handler GCs old auto-snapshots), (2) IPC disk save (2s debounce, atomic via temp+rename), (3) `beforeunload` immediate save. Restore priority: disk → localStorage fallback. Auto-snapshots every 5 min for time-travel (`Ctrl+K → Time Travel`).

## Docs

- `README.md` — Install instructions (per-OS: macOS/Windows/Linux/Fedora/Arch) + AI-agent install prompts for Claude/Codex/Gemini
- `FEATURES.md` — Feature guide + X-post social copy
- `CHANGELOG.md` — Keep-a-Changelog format, semver
- `CONTRIBUTING.md` — Development workflow, architecture rules, PR checklist
