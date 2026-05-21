# Changelog

All notable changes to TerminalX are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

## [0.2.0] — 2026-05-09

### Added
- **Agentic Pipelines** — end-to-end Planner → Builder → Reviewer runs in isolated git worktrees. Launch from the TopBar Pipeline button or `Cmd/Ctrl+Shift+P`; pick a template (Anthropic Trio default), describe a goal, and approve the plan before the Builder runs. Full guide in [docs/PIPELINE.md](docs/PIPELINE.md).
- **Plan preview modal** — review the Planner's plan with task count, files-touched, complexity badge, and confidence before approving, rejecting (with feedback to loop back), or replanning.
- **Run history panel** — every run (active, completed, failed, escalated) is listed per project with status, stage, branch, and quick actions (open logs, re-run with original goal, delete worktree).
- **In-app Run Logs modal** — telemetry JSONL stream, plan/spec preview, and an inline failure-bundle summary so post-mortems don't require leaving the app.
- **Pipeline settings panel** — per-user preferences (auto-approve trivial complexity, etc.) plus per-project webhook URL and re-cadence (entry-only / 15min / 1hr / 4hr / daily) for `awaiting_*` notifications.
- **Stage progress indicator** on the Pipeline Controller tile — live state machine view with retry counters, current role, and elapsed time.
- **Pipeline button badge** — pulses with a count when one or more runs are waiting on user input (plan approval, clarification, merge confirmation, etc.).
- **Two-step confirm guard** for Abort and Clear actions on a running pipeline.
- **Plan complexity gate** — Planner emits `trivial` / `standard` / `complex`; trivial runs auto-approve (when enabled in settings) and halve retry budgets, complex runs enable dual-reviewer and red-team passes.
- **Dual-reviewer + tiebreaker** for complex runs — Opus + Codex one-shots reconcile by verdict; disagreement spawns a Gemini tiebreaker with decisive vote.
- **Red-team role** for complex runs — adversarial pass for supply-chain, prompt-injection, secret-exposure, race-condition, and edge-case findings before the merger gate.
- **INVARIANTS.md grounding** — drop an `INVARIANTS.md` at the project root and all three role prompts pick it up at spawn; the Reviewer treats invariant violations as blockers.
- **Builder scratchpad + compaction checkpoints** — Builder maintains `.tx-builder-notes.md`; controller injects a compaction prompt past 200KB of output to keep context fresh.
- **Sub-agent delegation** — Builder may delegate self-contained tasks to one-shot sub-agents via `agent_run_oneshot` (one level deep, file-globs only, telemetry-tracked).
- **Bundled pipeline skills** — five SKILL.md files (`tx-pipeline-stage-handoff`, `tx-pipeline-reviewer`, `tx-pipeline-red-team`, `tx-pipeline-builder-scratchpad`, `tx-pipeline-subagent`) ship inside the app via Tauri resources and copy into `~/.claude/skills/` on first boot. Provenance-verified via build-time SHA-256.
- **Stuck detector** — pipeline runs that go silent for 5 min get probed with "Are you stuck?"; 8 min of total silence aborts the run with `failureClass: 'stage_unresponsive'`.
- **Sensitive-paths preflight gate** — before a run starts, project tree is scanned for `.env*`, `*.pem`, `*.key`, SSH keys, etc.; user must acknowledge before the run is created.
- **Trust telemetry** — five new event variants (`complexity_routed`, `confidence_uncertain_escalated`, `dual_reviewer_disagreement`, `tiebreaker_invoked`, `red_team_finding`) for run-quality dashboards.
- **Welcome banner + CLI health check** at boot — surfaces missing `claude` / `codex` / `gemini` CLIs before the first run.
- **Drag-to-connect wiring UI** — hover a tile, drag from the right-edge port onto another tile's left port. Wire type is inferred from source/target tile types.
- **Pipe button on Agent tiles** — glows with a live byte count when upstream terminals/agents have fresh context waiting. Click to pipe the last 50 lines (ANSI-stripped) as a prompt; right-click to pipe the full history with a custom prompt.
- **Inline Auto toggle** next to the Pipe button (same UX pattern as the TodoTile auto-dispatch). When ON, fresh upstream output is piped automatically — fully hands-free Terminal → Agent loops.
- **Command-gated auto-pipe** — auto-pipe now only fires after you press Enter in the source terminal, not on raw idle. Kills spurious fires from `tail -f`, dev servers, and other chatty processes.
- **Agent auto-complete** — agent-chain wires now fire without needing the agent process to exit. Detects completion via idle (8s of no output after a warmup) or an explicit `DONE` sentinel (`✅ DONE`, `[DONE]`, `## DONE`, etc.).
- **WIRING.md** — comprehensive drag-to-connect tutorial with per-OS interaction table, 5 wire-type walkthroughs, Auto-Pipe playbooks, and troubleshooting. Linked from README.
- Vitest 4 test suite (63 tests, happy-dom) covering wire inference, engine dispatch, DONE-sentinel regex, and agent auto-complete.
- Comprehensive README, CONTRIBUTING guide, LICENSE (MIT).

### Changed
- Pipeline runs are now **persisted to disk** and rehydrated on project switch (not just at boot), so reloading mid-run or hopping projects no longer loses run state.
- Pipeline canvas **auto-fits** to the run's tiles on launch — no more hunting for the controller after spawn.
- Agent terminals tightened — 12px font, 720px tiles, PTY-size sync on canvas zoom, smoother xterm refit.
- Reviewer is now **truly one-shot** for STANDARD runs (no idle PTY allocation between iterations).
- Sentinel parser **anchored to column 0** with leading-whitespace tolerance — fewer false positives from agent prompt echoes.
- Telemetry JSONL files **cap at 5MB** with single-rotation so long-running projects don't accumulate unbounded logs.
- Plan rejection now **loops back to the Planner with feedback** instead of failing the run.
- Hidden launch modal **stacks under the project gate** (no more ghost-modal flicker on startup).
- `package.json` description updated to reflect pipeline automation as a first-class feature.

### Fixed
- **Preview wire now tracks the actual cursor** during drag-to-connect. Previously offset by the sidebar width because `screenToCanvas` didn't account for canvas container position; now uses the SVG's own bounding rect as the canvas-origin anchor.
- **Auto-pipe timer no longer killed by effect re-runs** — `pipe` callback stabilised via ref so useEffect cleanup doesn't cancel the pending fire.
- **Wiring engine infinite loop** caught by tests — `setWireActive` inside subscription handler recursively re-triggered the same subscription with stale `prevAgentStatusRef`. Guarded with a re-entry flag and commit-before-dispatch.
- First Pipe click no longer dumps the PowerShell welcome banner and session history. Initial offsets snapshot on mount; output is ANSI-stripped and tail-capped at 50 lines (right-click pipes everything if you want it).
- **Pipeline:** sentinel scanner anchored to column 0 + leading-whitespace tolerance fixes false-positives from agent prompt echoes inside fenced code blocks.
- **Pipeline:** treat sentinel parse errors as transient (retry with more buffered output) rather than fatal, so partial chunks no longer abort runs.
- **Pipeline:** bypass Claude's interactive tool-permission prompt when spawned inside a worktree (runs are sandboxed at the capabilities + guardrails layer; the prompt was double-jeopardy).
- **Pipeline:** pre-install Planner capabilities + scaffold-shell verbs so the Planner can run `mkdir`/`touch`/etc. without permission churn.
- **Pipeline:** modal cards now use opaque surface colors and the accent button has the right contrast in light theme.
- **Agent tile:** xterm refit + `pty_resize` on canvas zoom so terminals stay legible at any scale.
- **Pipeline:** Windows-flake in the merger token-expiry test (timing tolerance).

### Security
- **Pipeline runs use isolated git worktrees** — every run gets its own `.tx-worktrees/<run-id>` checkout, never touches the user's working tree.
- **PreToolUse guardrails hook** auto-installed into each worktree's `.claude/settings.json` on run start (from `git-guardrails-claude-code`); blocks dangerous git commands inside agent shells. Hook is uninstalled on terminal state — user-authored hooks are preserved via the `_tx_pipeline_managed` marker namespace.
- **Per-role capability sandboxing** — Planner / Builder / Reviewer get distinct `permissions.allow` / `permissions.deny` allowlists (Reviewer is read-only; Builder can write the tree but not `.git/`, `node_modules/`, `target/`, `.tx-worktrees/`, `.terminalx/`).
- **Skill provenance** — bundled SKILL.md files are SHA-256-hashed at compile time (via `build.rs`) and verified on copy into `~/.claude/skills/`; a tampered resource bundle fails to install.
- **Secrets masking** in telemetry, webhook payloads, and failure bundles — PEM blocks, known-prefix tokens (`sk-`, `ghp_`, `xoxb-`, `AKIA`, `AIza`, …), and high-entropy `KEY=VALUE` pairs are masked before disk/wire write.
- **Failure bundle** redaction — `<projectDir>/.terminalx/failure-bundles/<run>.tar.gz` (telemetry, git status/diff, preflight, versions) is masked again at archive time as defense-in-depth.
- **Merger confirm-token gate** — `pipeline_merger_run` requires a one-shot, run-bound, 5-min-TTL token issued by `pipeline_merger_request_token`; wrong run-id does not consume the token (probe-resistant).
- **Sensitive-paths preflight scan** — `.env*`, `*.pem`, `*.key`, `id_rsa*`, `gcp-key*`, `aws-credentials`, `*.kdbx`, `*.ovpn` etc. surface as a confirm gate before the run is created.
- **Webhook URLs** are HTTPS-validated at the deps boundary and routed through the existing SSRF-guarded `httpFetch` proxy.

---

## [1.0.0] — 2026-04-15

Initial public release.

### Tile System (15 types)
- **Terminal** — interactive shell with split panes, command history
- **Agent** — Claude Code, Codex, Gemini CLI with xterm rendering
- **Editor** — Monaco with syntax highlighting, auto-save
- **Diff** — Monaco DiffEditor for code review
- **Note** — Markdown editor with debounced save
- **Todo / Tasks** — with MCP integrations and auto-dispatch
- **Kanban** — drag columns and cards
- **File Tree** — click files to open in Editor
- **Git** — status, log, branches, stage, commit, checkout
- **Browser** — embedded webview for localhost
- **Runner** — one-shot command executor
- **SSH** — remote terminal
- **Docker** — container list + attach
- **Usage** — LLM session + cost tracking
- **Group** — collapse multiple tiles

### Canvas
- Infinite pan/zoom with cursor-centered zoom
- Rubber-band selection (Shift+drag)
- Tile-to-tile snap alignment guides
- Minimap with click-to-navigate
- Rubber-band, multi-select, grouping
- Workspace tabs (named workspaces per project)
- 6 themes (Electric, Phantom, Ember, Ice, Snow, Slate — light)

### Wiring
- 5 wire types: context-pipe, agent-chain, refresh-trigger, task-assign, diff-feed
- Visual drag-to-connect ports
- Auto-pulse animation on data flow

### MCP Integrations
- Slack, GitHub, Linear, Jira, Notion, Google Calendar
- HTTP proxy through Rust (bypasses WebView CSP/CORS)
- Per-project connection storage
- 5-minute auto-sync + seen-task deduplication
- Auto-dispatch to connected agent

### Agent Intelligence
- Multi-Agent Debate (spawn Claude+Codex+Gemini side-by-side)
- Agent Memory (per-project persistent context)
- Auto-Recovery (Runner fails → error auto-dispatched to agent)
- Cost estimation (tokens + $ per agent, per session)

### Workspace
- 3-layer persistence (localStorage cache + disk save + beforeunload)
- Crash recovery from localStorage
- Auto-snapshots every 5 min for time-travel rollback
- Export/import workspaces as JSON
- Save custom layouts as project presets
- Session recording (replay all PTY I/O)

### Productivity
- Command Palette with fuzzy search (Ctrl+K)
- Global search across tiles (Ctrl+F)
- Focus Mode (Ctrl+Enter)
- 40+ keyboard shortcuts
- Clipboard history with paste-to-PTY
- Tile cloning, output pinning, sticky notes
- Image paste (saves to file, pastes path)
- Multi-monitor support (detach tiles to OS windows)

### Developer Experience
- Tauri 2 + React 19 + TypeScript 5.6
- portable-pty 0.8 with 256-byte Windows chunking
- reqwest 0.12 HTTP proxy for MCP
- xterm.js 5.5 with WebGL rendering
- Monaco Editor (lazy-loaded)
- Zustand 5 with 13 stores
- React.memo + lazy imports for performance

### Security
- CSP with minimal allow-list
- Path traversal sanitization
- Git URL / branch name injection prevention
- Custom command binary validation
- HTTPS-only HTTP proxy

---

[Unreleased]: https://github.com/txc0ld/tmx/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/txc0ld/tmx/releases/tag/v1.0.0
