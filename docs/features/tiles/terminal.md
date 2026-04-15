# Terminal Tile

> Interactive shell on the canvas with optional split panes.

## What it is

A full xterm.js terminal bound to a native PTY running your shell (`$SHELL`, `powershell.exe`, `bash`, etc.). Supports up to 4 panes per tile for side-by-side views of the same working directory or different shells.

## How to use

- Click the **Terminal** button in the tile dock to spawn one.
- Type as you would in any terminal — keystrokes go straight to the PTY.
- `Ctrl+Shift+D` splits horizontally, `Ctrl+D` (with existing split) splits vertically.
- `Ctrl+Arrow` navigates between split panes.
- Drag the tile edges to resize — columns/rows auto-fit and PTY gets `SIGWINCH`.
- Click the 📌 button in the title bar to pin the current output as a Note tile.

## Use cases

**Standard dev shell.** Run tests, build, `git`, anything you'd type in a regular terminal.

**Side-by-side compare.** Split into two panes — one running `npm run dev`, the other watching logs with `tail -f`.

**Feed an agent.** Wire the terminal to an Agent tile so its output becomes the agent's context. See [context-pipe](../wiring/context-pipe.md).

## Tech notes

- Renders via **xterm.js 5** with the **WebGL addon** for fast drawing. Falls back to canvas renderer if WebGL unavailable.
- PTY lives on the Rust side via `portable-pty`. A **bounded mpsc channel (256 slots × 8 KB)** between the reader thread and the event emitter gives natural backpressure — when the frontend falls behind, the child process blocks at the OS pipe level instead of ballooning memory.
- Splits are persisted in `tile.splits: TerminalSplit[]` so layouts survive reload. Each split owns its own PTY id.
- Keyboard capture bypasses xterm's hidden `<textarea>` (it can't receive focus inside a CSS-transformed canvas) — see `xtermInput.ts` for the direct `keydown` → VT-sequence translator.

**Key files:** `src/components/tiles/TerminalTile.tsx`, `src/components/tiles/TerminalPane.tsx`, `src/components/tiles/xtermInput.ts`, `src-tauri/src/commands/terminal.rs`, `src-tauri/src/state/pty_manager.rs`.

## Related

- [PTY management](../platform/pty-management.md) · [Command history](../ux/command-history.md) · [Context-pipe wire](../wiring/context-pipe.md)
