# AGENTS.md — TerminalX

TerminalX is a Tauri desktop app for arranging terminals, CLI agents, editors and other tools on an infinite canvas and wiring their data flows together.

This is the canonical agent guide. Code and configuration own current facts: read `package.json` and `src-tauri/Cargo.toml` for dependencies and scripts, `src/types/index.ts` for tile and wire types, and `.github/workflows/ci.yml` for CI. Do not copy dated component, store or test counts into instructions.

## Read for the task

| Work | Read |
| --- | --- |
| Development, contribution or release | `CONTRIBUTING.md`; platform setup in `README.md` |
| Architecture, PTY, agent lifecycle, canvas or pipeline changes | Relevant section of `docs/agents/architecture-reference.md`, then the named implementation |
| Feature behaviour | `docs/features/README.md` and the matching feature page |
| UI or theme changes | `DESIGN.md`, `src/design/tokens.ts`, `src/stores/themeStore.ts` |
| Wiring | `WIRING.md`, `src/hooks/useWiringEngine.ts` |
| IPC, filesystem, HTTP or plugin boundaries | `CONTRIBUTING.md` Security posture and the affected Rust validator |
| Pipeline review, merge, permissions or cleanup | Architecture reference's pipeline and pass-through contracts; affected code in `src/pipeline/` and `src-tauri/src/commands/pipeline/` |

The pipeline defaults in this application's source describe the product. Worker and reviewer assignments for this task follow the owner's `~/Claude/model-routing-policy.md`; do not infer task authority from app defaults.

## Repository shape

- `src/` holds React components, Zustand stores, hooks, types and utilities. `src/main.tsx` starts the frontend; `src/App.tsx` composes it.
- `src/utils/ipc.ts` wraps frontend IPC. `src-tauri/src/lib.rs` registers commands and handles shutdown; `src-tauri/src/commands/` implements them.
- `src-tauri/src/state/` owns PTY and other shared runtime state.
- `src/pipeline/` and the Rust pipeline submodules implement the application’s orchestration flow.

## Development and verification

Use the current manifests and contribution guide for exact commands and required checks. Common entry points are `pnpm tauri dev` (native app), `pnpm dev` (frontend), `pnpm tauri build` (native build) and `pnpm test` (Vitest). CI’s frontend job runs type checks, unit tests and a build; Rust jobs check and test across Linux, Windows and macOS. Report the actual tested platform and distinguish browser mocks from native PTY/IPC proof.

## Invariants

- Keep Zustand selector fallback objects and arrays stable. A newly allocated fallback on every call can trigger repeated renders. Use a module-level constant:

  ```ts
  const EMPTY: Tile[] = [];
  useCanvasStore(s => s.tiles[s.activeProject] ?? EMPTY)
  ```

- Wrap frontend Tauri calls in `src/utils/ipc.ts`; do not call `invoke()` directly from components. New commands validate every user-reachable argument at the Rust boundary and keep the validator tests required by `CONTRIBUTING.md`.
- Use `readFileText` / `writeFileText` IPC for user project files. The filesystem plugin has a deliberately narrower capability scope. Preserve `is_path_allowed`, null-byte and symlink-write protections and size limits.
- MCP requests go through `httpFetch` and the Rust HTTP proxy. Preserve its SSRF, URL, header, redirect and DNS-pinning controls and the security guide's intentional CSP allowances.
- Keep PTY writes on the existing `PtyManager` path, including its Windows chunking and retry behaviour. Agent spawning uses `pty_spawn_internal`; renderer shell spawning keeps `SHELL_ALLOWLIST`. Preserve process cleanup on window destruction and manager drop.
- Tauri event subscriptions resolve asynchronously. Clean them up even if their `UnlistenFn` arrives after a component unmounts.
- Use design tokens and theme variables for colours, spacing and typography. The current frontend uses inline styles; the presence of a Tailwind dependency is not an instruction to restyle it. Preserve light-theme surface handling.
- Use `screenToCanvas()` for coordinate conversion. Scrollable overlays need `data-canvas-overlay` so canvas wheel/pan/selection handlers do not steal their events.
- If the removed plugin tile is restored, retain the iframe sandbox and exact-origin messaging rules in the security guide.
- Preserve pipeline review, permission, confirmation-token, secret-masking and recovery boundaries when changing orchestration. A description of its cleanup implementation is not authority to remove a dirty, live or unknown-owner checkout.

## Conventions

Use domain-specific Zustand stores, discriminated unions and strict TypeScript. Do not add `any` without an explanation. Components use PascalCase filenames; utilities, hooks and stores use camelCase. Rust uses the existing error, serialization and locking conventions. Use Conventional Commits. Attribute assistance truthfully to the actual author; do not copy an old model trailer from an example.
