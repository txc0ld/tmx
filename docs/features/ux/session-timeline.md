# Session Timeline

> Chronological audit log of everything that happened.

## What it is

A persistent log of events — command executed, file modified, agent prompted, agent completed, build result, git operation, wire triggered, snapshot saved. Visible as a timeline panel; capped at 10 000 events.

## How to use

- Command Palette → "Toggle Session Timeline" opens the panel.
- Scroll to see recent events; type to filter.
- Each entry shows timestamp, event type, summary, and optional detail.
- Click an event to jump to the related tile (when applicable).

## Power moves

- **Daily review.** End of day — open the timeline, skim what you worked on, what agents completed, what broke.
- **Debug the debugger.** When a wire misfires or an agent behaves weirdly, the timeline shows the exact sequence of events leading up to it.
- **Post-incident trace.** Something went wrong? Scroll back in the timeline to retrace your steps. More reliable than memory.
- **Pair with session recording.** Timeline = metadata (what happened), recording = raw bytes (what the terminals produced).

## Tech notes

- Events stored in Rust on the `AppState.timeline` vector. Cap 10 000; overflow uses `rotate_left` + `truncate` (ring-buffer behavior — oldest drop first).
- Event shape: `{ id, timestamp (RFC3339), eventType, tileId?, agentId?, summary, detail? }`.
- Frontend fetches via `get_timeline(limit?)` IPC with an optional tail limit (default 200).
- Event types: `command-executed`, `file-modified`, `agent-prompt`, `agent-complete`, `build-result`, `git-operation`, `wire-triggered`, `snapshot-saved`.
- **Gotcha:** Timeline isn't persisted across app restarts in v1. A future release will add disk persistence.

**Key files:** `src-tauri/src/commands/timeline.rs`, `src/stores/timelineStore.ts`, `src/components/timeline/SessionTimeline.tsx`.

## Related

- [Session recording](../persistence/session-recording.md) · [Command palette](./command-palette.md)
