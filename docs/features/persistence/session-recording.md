# Session Recording

> Capture every PTY byte for replay.

## What it is

Records all PTY output across all tiles with timestamps. Export to JSON or play back at variable speed. Useful for agent-session debugging, demos, or just reviewing "what did I run today".

## How to use

- Command Palette → "Start Recording". Badge appears in status bar.
- Do whatever — terminals, agents, runners. Every byte is captured with a `ptyId` + `timestamp` (relative to recording start).
- Command Palette → "Stop Recording" → prompts to save.
- Command Palette → "Replay Recording" → picks a saved file → replays at chosen speed.
- Command Palette → "Export Recording" → JSON or plaintext log.

## Power moves

- **Debug an agent run.** Record before you start; if the agent goes sideways, replay at 0.5× to see what it emitted frame-by-frame.
- **Share sessions.** Export the JSON and send to a teammate; they can replay or grep the timeline.
- **Tutorial mode.** Record a perfect workflow once, replay during onboarding.
- **Coalesce bursts.** Events <10 ms apart on the same PTY merge automatically — keeps JSON small.

## Tech notes

- Stored in-memory in `recordingStore` while recording (not persisted until export). Structure: `RecordedEvent = { timestamp, ptyId, data }`.
- Event cap: **50 000**. At **40 000** a warning toast fires; at 50 000 recording stops with an error toast.
- Coalescing: same-ptyId events within 10 ms merge if the combined data stays under 8 KB.
- Replay scheduling: `timestamp / replaySpeed` gives the replay delay. 1.0× is real-time; 2.0× is double speed.
- Export JSON includes the full event list plus metadata (start time, total duration, ptyIds used).

**Key files:** `src/stores/recordingStore.ts`.

## Related

- [Session timeline](../ux/session-timeline.md) · [Command palette](../ux/command-palette.md)
