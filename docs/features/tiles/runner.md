# Runner Tile

> Run a command once, detect pass/fail, drive auto-recovery.

## What it is

A single-shot command runner. Unlike a Terminal tile (which is interactive), Runner is designed for "execute this and tell me if it worked" — tests, builds, linters, deploys.

## How to use

- Add a Runner tile. Fill in the command (e.g. `npm test`, `cargo build`, `pytest`).
- Click **Run**. Status badge cycles: `idle → running → pass/fail`.
- Output streams into the embedded xterm. Exit code detected automatically via a `__TX_EXIT:<code>` marker.
- Wire the Runner to an Agent: on fail, the error output auto-dispatches to the agent to fix.

## Use cases

**Test gate before commit.** Run the test suite, see green/red in the title bar without reading the output.

**Build dashboard.** Three Runner tiles side-by-side for `build`, `typecheck`, `test` — all green = ship.

**Auto-fix loop.** Wire a failing Runner → an Agent. Each failure hands the last N lines of output to the agent with "fix this error". See [context-pipe](../wiring/context-pipe.md) + Runner behavior.

## Tech notes

- Exit detection uses a shell wrapper that prints `__TX_EXIT:<code>` after the command — PowerShell on Windows, POSIX `$?` on Unix. The frontend parses the marker to set `pass` / `fail`.
- Writes go through the same 256-byte chunked `ptyWrite` + retry-on-pipe-full as regular terminals.
- When the Runner transitions to `fail` and a wire leads to an Agent, the auto-recovery hook in `useWiringEngine` dispatches the last 30 lines of output to the agent's PTY with a `Build/test failed. Fix this error:` prefix.
- Runner PTYs count against the 64 global PTY cap.

**Key files:** `src/components/tiles/RunnerTile.tsx`, `src/hooks/useWiringEngine.ts` (auto-recovery block).

## Related

- [Terminal tile](./terminal.md) · [Agent tile](./agent.md) · [context-pipe wire](../wiring/context-pipe.md) · [PTY management](../platform/pty-management.md)
