# Starter Layouts

> Detect a project's language/framework and apply a matching tile layout.

## What it is

Scans the active project's `cwd` for familiar marker files (`Cargo.toml`, `package.json`, `next.config.js`, `pyproject.toml`, etc.), guesses the project kind, and offers a curated tile set tuned for that workflow. One click turns a bare canvas into a working dev environment.

## How to use

- Command Palette (`Ctrl/⌘+K`) → **Suggest Starter Layout for This Project**.
- Detection runs on the active project's `cwd`. A confirm dialog shows the detected kind + tile count.
- Confirm → tiles spawn in the column-major grid (same pattern as the dock).
- Conservative: if no confident match, you get a polite "couldn't detect a known kind" toast. Spawn manually.

## What it detects

| Kind | Marker | Starter tiles |
|---|---|---|
| **Tauri app** | `package.json` + `src-tauri/` dir | Terminal · Claude · FileTree · Runner(`pnpm tauri dev`) · Git |
| **Next.js** | `next.config.{js,mjs,ts}` | Terminal · Runner(`pnpm dev`) · Browser(localhost:3000) · FileTree · Git |
| **Vite** | `vite.config.{js,ts,mjs}` | Terminal · Runner(`pnpm dev`) · Browser(localhost:5173) · FileTree · Git |
| **Cargo workspace** | `Cargo.toml` + `crates/` dir | Terminal · Runner(`cargo test --workspace`) · FileTree · Git |
| **Rust** | `Cargo.toml` | Terminal · Claude · Runner(`cargo test`) · FileTree · Git |
| **Node.js** | `package.json` | Terminal · Claude · Runner(`pnpm test`) · FileTree · Git |
| **Python** | `pyproject.toml` / `requirements.txt` / `setup.py` | Terminal · Claude · Runner(`pytest`) · FileTree · Git |
| **Go** | `go.mod` | Terminal · Claude · Runner(`go test ./...`) · FileTree · Git |
| **Git repo** (fallback) | `.git/` dir | Terminal · FileTree · Git |

Match order matters — Tauri is checked before generic Node since it's a strict superset. The first confident match wins.

## Power moves

- **First thing you run on a new project.** Clone a repo, add it as a project, hit `Ctrl/⌘+K → Suggest Starter Layout` → working canvas in 5 seconds.
- **Combine with blueprints.** Apply a starter layout, then apply a [blueprint](./blueprints.md) with an auto-fix loop on top. Two clicks, whole flow ready.
- **Re-run safely.** Starter layouts don't clear the existing canvas — they add. If you already have tiles, the new ones spawn in empty grid slots. No data loss.

## Tech notes

- Detection: `src/utils/projectTypeDetect.ts`. Calls `read_file_tree` with depth 1 (just the top-level entries), pattern-matches against marker files.
- Each kind returns `{ kind, label, confidence, starterTiles }`. `confidence` is `'high'` or `'medium'` — currently informational; a future version could gate the confirm dialog on it.
- Spawn anchor: `screenToCanvas(24, 24, transform)` — top-left of the current viewport, same as the dock.
- Grid pitch: 700 × 500 CSS with 8 px gap, column-major, 3 tiles per column. Predictable layout regardless of viewport size.
- Stripped fields: `ptyId`, `status`, `elapsed`, etc. aren't set — spawned tiles start fresh.

**Key files:** `src/utils/projectTypeDetect.ts`, `src/components/palette/CommandPalette.tsx` (starter-layout block).

## Related

- [Projects sidebar](../canvas/tile-dock.md) · [Templates](../ux/templates.md) · [Blueprints](./blueprints.md) · [Command palette](../ux/command-palette.md)
