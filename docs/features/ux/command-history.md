# Command History

> Per-terminal recall of commands you've typed.

## What it is

Tracks commands submitted (`Enter` pressed) in each Terminal / Runner / Agent tile. Surfaces a history dropdown in the terminal's title bar for quick re-run.

## How to use

- The history button (≡ icon) appears in the top-right of a Terminal tile when history entries exist.
- Click to drop the list — most recent at the top.
- Click an entry → re-submits that command to the terminal.
- History is per-PTY, not per-tile — new PTYs start fresh.

## Power moves

- **Repeat recent builds.** After running `npm test`, the next `npm test` is a click instead of a retype.
- **Across panes.** Split-pane terminals each have their own history — switching panes shows that pane's commands.
- **Session reconstruction.** Combined with [session recording](../persistence/session-recording.md), you can replay the exact command order.

## Tech notes

- Stored in-memory in `commandHistoryStore`, keyed by PTY id: `history: Record<ptyId, string[]>`.
- `commitCommand(ptyId)` fires on `\r` or `\n` in the write path. `appendBuffer(ptyId, data)` tracks in-progress edits.
- Memory-only (not persisted). Intentional — shell history already belongs to `~/.bash_history` etc. We just mirror the current session for click-to-rerun.
- Cleared when the PTY dies (kill + exit event).

**Key files:** `src/stores/commandHistoryStore.ts`, `src/components/tiles/TerminalTile.tsx` (history UI).

## Related

- [Terminal tile](../tiles/terminal.md) · [Session recording](../persistence/session-recording.md)
