# TerminalX Repository Audit

Date: 2026-04-15  
Auditor: Codex  
Scope: full repository inventory, React/Tauri frontend and Rust backend hardening, dependency/security scans, build/test verification.

## Executive Summary

TerminalX has a coherent React + Zustand + Tauri 2 architecture and a strong product model, but the pre-hardening codebase had several production blockers at the renderer/native boundary: filesystem write symlink traversal, unrestricted directory watches, incomplete SSRF protection in the HTTP proxy, an editor autosave data-loss race, runner commands that did not actually exit, and unsafe URL construction for MCP integrations. Those CRITICAL and HIGH items were implemented in this pass.

The remaining risk is concentrated in moderate follow-up work: stale docs, a large main bundle, placeholder/dead modules, broad CSP allowances required by the current frontend stack, shallow workspace import validation, and limited Rust/CI coverage.

## Audit Metrics

| Metric | Value | Notes |
|---|---:|---|
| Tracked files inventoried | 185 | Includes generated Tauri schemas and binary icons/assets |
| Source/config/doc files reviewed | 97 | TypeScript, TSX, Rust, JS, CSS, HTML, config, docs |
| Test files after pass | 4 | Added MCP URL builder tests |
| Frontend tests after pass | 67 passing | `pnpm test` |
| Rust tests after pass | 0 unit tests, smoke pass | `cargo test` executes lib/main/doc test harnesses |
| Frontend build | Passing | `pnpm build`, with chunk warnings |
| Rust build check | Passing | `cargo check`, warning-free after cleanup |
| npm vulnerability scan | Passing | `pnpm audit --audit-level moderate`: no known vulnerabilities |
| Cargo vulnerability scan | Not run | `cargo audit` is not installed in this environment |
| Secret scan | No committed credentials found | Hits were placeholders/docs/config field names |

Generated Tauri schema JSON and binary image/icon assets were inventoried by path and role; hand-authored source, configuration, and documentation files were read for behavior and risk.

## Scorecard

Weights: Security 20%, Code Quality 20%, Error Handling 15%, Architecture 10%, Performance 10%, Testing 10%, DevEx 8%, Dependency Health 7%.

| Section | Before | After | One-line justification |
|---|---:|---:|---|
| Architecture & Structure | 7.0 | 7.5 | Clear React/Tauri split, but several large modules and placeholders remain |
| Code Quality & Correctness | 6.0 | 8.0 | Fixed data-loss, runner, piping, navigation, and validation bugs |
| Error Handling & Resilience | 6.0 | 7.5 | Added global async error logging and hardened persistence/error boundaries |
| Security | 5.0 | 7.5 | Fixed SSRF, symlink write, watcher, SSH, MCP URL, and tracked-local-state risks |
| Performance | 7.0 | 7.0 | Existing cleanup is mostly good, but the main bundle remains large |
| Testing & Reliability | 5.0 | 6.0 | 67 frontend tests now cover new URL validation; Rust unit coverage still absent |
| DevEx & Maintainability | 6.0 | 7.5 | Added `.env.example`, git hooks, cleaner ignore rules, and warning-free Rust checks |
| Dependency Health | 6.0 | 6.5 | npm audit is clean; outdated packages and missing cargo-audit remain |

Overall weighted score: 5.9/10 before, 7.3/10 after.

## 1. Architecture & Structure

### Project Structure

| Area | Role | Notes |
|---|---|---|
| `src/` | React 19 + TypeScript app | Canvas, tiles, stores, hooks, design tokens, tests |
| `src/components/tiles/` | Tile implementations | Terminal, Agent, Runner, Editor, Diff, Browser, Todo, Kanban, SSH, Docker, Usage, Group |
| `src/stores/` | Zustand state | Project, canvas, wiring, timeline, MCP, usage, theme, templates, plugins |
| `src/utils/ipc.ts` | IPC wrapper layer | Correctly centralizes Tauri `invoke` calls |
| `src-tauri/src/commands/` | Native command boundary | PTY, agent lifecycle, filesystem, workspace, projects, git, proxy, docker |
| `src-tauri/src/state/` | Native shared state | PTY manager, agent registry, timeline, filesystem watchers |
| `website/` | Independent marketing site | Static Vite site, separate package config |
| `.github/` | GitHub issue templates/workflow | Only website deployment CI is present |
| `src-tauri/gen/schemas/` | Generated Tauri schemas | Generated artifacts; not application logic |

### Dependency Graph

| Path | Dependency direction |
|---|---|
| `main.tsx -> App.tsx` | Root render, theme init, global error logging |
| `App.tsx -> stores + components` | Loads projects, routes sidebar/canvas/topbar/status/timeline |
| `components/* -> stores/hooks` | Components dispatch to Zustand stores and PTY/wiring hooks |
| `hooks/usePty.ts -> utils/ipc.ts` | Subscribes to PTY output/exit events and sends writes/resizes |
| `stores/* -> utils/ipc.ts` | Persistence, project, timeline, MCP, git, docker, OpenUsage |
| `utils/ipc.ts -> Tauri commands` | Typed renderer/native bridge |
| `src-tauri commands -> state` | Commands validate inputs, mutate `AppState`, spawn PTYs/processes |
| `website/*` | Separate static page, no runtime dependency on app source |

### Architecture Findings

| Finding | Evidence | Impact | Status |
|---|---|---|---|
| Large UI modules are doing too much | `InfiniteCanvas.tsx`, `CommandPalette.tsx`, `TopBar.tsx` combine persistence, UI, shortcuts, dialogs | Harder testing and future regression isolation | Moderate follow-up |
| Dead/placeholder frontend code | `src/components/tiles/PluginTile.tsx` is not included in `TileType` rendering; `src/hooks/useWiring.ts` appears superseded by `useWiringEngine.ts` | Confusing ownership and maintenance load | Moderate follow-up |
| Rust wiring module is placeholder-only | `src-tauri/src/commands/wiring.rs` contains data structs/comments and no commands | Compiled placeholder can mislead future backend work | Documented, warning suppressed |
| Documentation references missing file | `README.md` and `AGENTS.md` reference `DESIGN.md`, but no `DESIGN.md` exists | New contributors cannot follow the design-system source of truth | Moderate follow-up |
| Frontend/Rust boundaries are mostly clean | Components use `src/utils/ipc.ts`; direct `invoke` calls are confined there | Good separation of concerns | Keep |

## 2. Code Quality & Correctness

| Issue | Evidence | Risk | Fix |
|---|---|---|---|
| Editor autosave could write file A content into file B | `EditorTile.tsx` used `filePathRef.current` at timer fire | Data loss | Cleared pending saves on file switch and captured path per edit |
| Runner never terminated spawned shell | `RunnerTile.tsx` wrote command only, despite comment saying command plus exit | Status stuck, auto-recovery blocked | Added platform-specific runner script with `__TX_EXIT` marker and shell exit |
| Pipe context offset skipped future output | `AgentTile.tsx` added baseline + previous offset + fresh length | Lost context after repeated piping | Stored absolute next offsets |
| Command palette could set selected index to `NaN` | Arrow key modulo with `results.length === 0` | Keyboard navigation bug | Guarded empty result navigation |
| SSH destination could be interpreted as option-like input | SSH args ended with `${user}@${host}` without `--` or validation | Option injection into `ssh` | Added user/host validation and `--` separator |
| MCP URLs were assembled with raw user config | GitHub repo, Slack channel, Jira host, Notion database ID | Path/query injection and malformed proxy requests | Added URL builder validation/encoding and tests |
| Project persistence accepted unbounded malformed data | `projects.rs` wrote arbitrary project vectors | Corrupt config and resource abuse | Added project validation, duplicate checks, size caps, atomic writes |
| Workspace persistence had size and Windows rename gaps | `workspace.rs` wrote/read unbounded JSON and relied on rename-over-existing | Corrupt or failing saves | Added JSON caps and Windows rename fallback |

TODO/FIXME/HACK scan found only documentation/test fixture TODO strings, not blocking source TODOs.

## 3. Error Handling & Resilience

| Area | Assessment | Change |
|---|---|---|
| React render errors | App-level and tile-level error boundaries exist | Kept |
| Async/global errors | No global unhandled rejection or script error logging before this pass | Added `window.error` and `unhandledrejection` logging in `main.tsx` |
| Native command errors | Commands consistently return `Result<T, String>` but errors are unstructured | Improved boundary validation; typed error model remains moderate follow-up |
| Persistence failures | Some stores swallowed non-critical localStorage errors intentionally | Accepted for crash-cache paths |
| PTY/process cleanup | `PtyManager` kills children on drop; terminal components clean subscriptions | Kept; cargo warnings cleaned |
| External service failure | MCP sync statuses and toasts exist; OpenUsage now routes through proxy | Improved |

## 4. Security

| Issue | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| HTTP proxy SSRF through DNS-resolved private IPs | Medium | High | DNS resolution validation added for HTTPS; HTTP restricted to loopback |
| HTTP proxy redirects bypassing validation | Medium | High | Redirect following disabled |
| HTTP method/header abuse in proxy | Medium | Medium | Explicit method allowlist and blocked hop-by-hop headers |
| Filesystem write through symlink | Medium | High | Existing symlinks are rejected before write |
| Directory watch outside allowed roots | Medium | High | Watch paths now canonicalize and enforce allowed roots |
| Local Claude state committed | Medium | Medium | Removed tracked `.claude` local files and ignored `.claude/` |
| SSH option injection | Low/Medium | Medium | Host/user validation and `--` separator |
| CSP allows `unsafe-eval` and `unsafe-inline` | Medium | Medium/High | Left as moderate follow-up because current Monaco/styles need compatibility review |
| Renderer can spawn PTY shells by design | Medium | High | Existing shell allowlist retained; this is a core terminal app trust boundary |
| XSS via raw HTML | Low | High | No `dangerouslySetInnerHTML`, `eval()`, `new Function`, or direct DOM HTML sinks found |

Residual security risk: DNS validation and request execution are still separate operations inside `reqwest`; a hardened future version should pin resolved addresses or use a custom resolver to remove DNS rebinding TOCTOU.

## 5. Performance

| Finding | Evidence | Impact | Recommendation |
|---|---|---|---|
| Main bundle remains large | Vite reports `index-*.js` around 972 kB minified, 271 kB gzip | Slower startup | Split `CommandPalette`, heavy tile families, and xterm/Monaco paths more aggressively |
| Dynamic imports cannot split some modules | Vite reports dynamic/static import overlap for `ipc`, stores, fs/path plugins | Chunking opportunities lost | Remove dynamic imports for already-static modules or isolate true lazy modules |
| Canvas/command modules are large | `InfiniteCanvas.tsx`, `CommandPalette.tsx`, `TopBar.tsx` | More re-render and test surface | Extract persistence/actions from UI modules |
| Event listener cleanup is mostly present | Hooks/components remove wheel/pointer/keyboard/listener handlers | Good | Keep cleanup pattern |
| No database/index concerns | No database layer | N/A | N/A |

## 6. Testing & Reliability

| Area | Status |
|---|---|
| Frontend unit tests | 67 passing after this pass |
| New tests | Added MCP URL builder tests for user-controlled API config |
| Rust tests | `cargo test` passes harnesses but there are no Rust unit tests |
| CI | `.github/workflows/deploy.yml` covers website deployment only; no main app CI |
| Critical gaps | Filesystem boundary tests, HTTP proxy SSRF tests, project/workspace validation tests, RunnerTile completion tests, EditorTile autosave race tests |
| Brittle tests | Existing wiring tests are store-driven and not obviously timing-dependent |

## 7. DevEx & Maintainability

| Finding | Impact | Status |
|---|---|---|
| `.env.example` missing | Setup ambiguity | Added |
| Git hooks missing | Regressions could land before checks | Added `.githooks/pre-commit` and `scripts/install-git-hooks.ps1` |
| `.gitignore` incomplete | Local state/build artifacts could be committed | Expanded ignore rules |
| README/features docs stale | Counts and roadmap references do not match code | Moderate follow-up |
| `DESIGN.md` missing | Design system source of truth absent | Moderate follow-up |
| Logging is mostly `console`/`eprintln!` | Harder production diagnostics | Moderate follow-up: structured logs with redaction |
| Cargo warnings | Previously had unused imports/dead helper warnings | Cleaned current `cargo check` warnings |

## 8. Dependency Health

| Check | Result |
|---|---|
| `pnpm audit --audit-level moderate` | No known vulnerabilities found |
| `cargo audit` | Not available in environment |
| `pnpm outdated` | Updates available: `postcss` 8.5.10, `autoprefixer` 10.5.0, `@vitejs/plugin-react` 6.0.1, `@xterm/xterm` 6.0.0, `typescript` 6.0.2, `vite` 8.0.8, `@xterm/addon-fit` 0.11.0, `@xterm/addon-webgl` 0.19.0 |
| Unused/possibly removable | `jsdom` appears unused because Vitest uses `happy-dom`; `notify-debouncer-mini` appears unused; `tauri-plugin-shell` should be rechecked against actual shell plugin usage |
| Heavy dependencies | Monaco/xterm are appropriate for the product but drive bundle weight |

## Phase 2: Prioritized Fix Plan

### CRITICAL - Implemented Immediately

| Item | Why | Status |
|---|---|---|
| Block filesystem symlink writes | Prevent native write escape through allowed parent | Fixed in `filesystem.rs` |
| Validate watched directories against allowed roots | Prevent renderer-triggered path/event exfiltration | Fixed in `filesystem.rs` |
| Harden HTTP proxy SSRF and redirect behavior | Proxy is the external network boundary | Fixed in `http_proxy.rs` |
| Fix editor autosave race | Prevent cross-file data loss | Fixed in `EditorTile.tsx` |
| Remove tracked local Claude state | Avoid committing local permission/session metadata | Fixed via deletion and `.gitignore` |

### HIGH - Implemented In This Pass

| Item | Why | Status |
|---|---|---|
| Runner command completion and exit-code detection | Runner tiles were not reliable production workflows | Fixed in `RunnerTile.tsx` |
| Pipe context offset calculation | Agent orchestration could silently lose context | Fixed in `AgentTile.tsx` |
| SSH target validation | Prevent option-like destination arguments | Fixed in `SshTile.tsx` |
| MCP URL validation/encoding | User API config crosses proxy boundary | Fixed in `mcpStore.ts` and tested |
| Command palette empty-results guard | Avoid `NaN` keyboard state | Fixed in `CommandPalette.tsx` |
| Project/workspace persistence hardening | Prevent malformed/unbounded local state | Fixed in Rust commands |
| OpenUsage proxy routing | Align with CSP/proxy boundary and CORS bypass strategy | Fixed in `usageStore.ts` |
| Global async error logging | React error boundaries do not catch promises | Fixed in `main.tsx` |
| Rust warning cleanup | Keep native checks clean | Fixed in Rust modules |

### MODERATE - Follow-Up

| Item | Why | Recommended next step |
|---|---|---|
| Split large UI modules | Lower regression surface and improve bundle splitting | Extract command actions, persistence, and canvas interaction helpers |
| Add Rust unit tests | Native boundary code is now critical | Test filesystem, proxy, project, and workspace validators |
| Add app CI | Local checks are not enough | GitHub Actions: `pnpm test`, `pnpm build`, `cargo check`, `cargo test` |
| Tighten CSP | `unsafe-eval` and `unsafe-inline` remain | Audit Monaco/dev needs, move inline styles where feasible |
| Formalize error shape | `Result<T, String>` is simple but not structured | Introduce serializable error codes/categories |
| Deep workspace import validation | Import currently validates only a shallow shape | Add tile/wire discriminated-union validators |
| Remove/finish dead placeholders | Reduce ambiguity | Decide on `PluginTile`, `useWiring.ts`, and Rust wiring backend |
| Refresh docs | README/FEATURES/AGENTS mismatch current code | Create `DESIGN.md`, update tile/store counts and current commands |
| Dependency updates | Several majors/minors available | Update in a separate compatibility pass |

Key Principle: harden renderer-to-native and user-input boundaries first, because a Tauri renderer compromise turns unchecked IPC into native filesystem, process, and network access.

## Phase 4 Hardening Additions

| Addition | Status | Notes |
|---|---|---|
| `.env.example` | Added | Documents no required secrets and optional `GH_PAGES=true` |
| Input validation schemas on external endpoints | Partially added | IPC/native boundaries and MCP URL builders now validate; formal schemas remain follow-up |
| Rate limiting on auth/public endpoints | Not applicable | Desktop app has no public auth/server endpoints |
| Structured error response format | Partial | Native commands still return `String`; consistent typed errors remain follow-up |
| Health check endpoint | Not applicable | No server process |
| Graceful shutdown handler | Existing partial | PTY manager kills children on drop; explicit signal hooks not applicable to typical Tauri desktop lifecycle |
| Request/response logging middleware with PII redaction | Not applicable/Follow-up | No HTTP server; proxy logging should be added only with header/body redaction |
| Git hooks | Added | `.githooks/pre-commit` plus `pnpm hooks:install` |

## Verification

| Command | Result |
|---|---|
| `pnpm test` | Passed: 4 files, 67 tests |
| `pnpm build` | Passed with Vite chunk warnings |
| `cargo check` | Passed, warning-free |
| `cargo test` | Passed, 0 Rust unit tests |
| `pnpm audit --audit-level moderate` | Passed, no known vulnerabilities |
| `cargo audit` | Not available |
| `rg` for HTML/eval sinks | No `dangerouslySetInnerHTML`, `eval()`, `new Function`, or DOM HTML sinks found in app source |

## Residual Risk Register

| Risk | Likelihood | Mitigation |
|---|---:|---|
| DNS rebinding between proxy validation and request send | Low/Medium | Pin resolved IPs or use a custom resolver in `reqwest` |
| Large bundle affects startup on lower-end machines | Medium | Split heavy modules and resolve dynamic/static import overlap |
| CSP remains permissive for eval/inline style | Medium | Audit Monaco/Tauri requirements and remove allowances incrementally |
| Lack of Rust unit tests lets boundary regressions slip | Medium | Add validator tests before the next native-command expansion |
| Docs drift causes incorrect contributor assumptions | High | Update README/FEATURES and add missing `DESIGN.md` |
| Workspace import can load malformed tile shapes | Medium | Add discriminated-union validation at import boundary |
| Broad terminal process capabilities are inherent to product | Medium | Keep shell allowlists tight and require explicit user action for command-running features |
