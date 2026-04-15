# Pipe Context Button

> Manual one-shot pipe — fire when you want, not when the engine decides.

## What it is

A button on the Agent tile's title bar, visible when the agent has incoming wires. Click to immediately push unread upstream output (and optional prompt template) into the agent's PTY.

## How to use

- Wire a source (Terminal / Runner / Agent) into the Agent tile.
- Run something in the source.
- The button glows accent color + shows the unread byte count (e.g. `Pipe Context · 2.4 KB`).
- Click to pipe. Button dims until more output arrives.

## Power moves

- **Use instead of Auto for selective pipes.** Leave Auto off, use the button only when you've reviewed what the source produced and want the agent to see it.
- **Review + pipe.** Read the terminal output, scroll back, think about it, then hit the button — unlike auto-pipe, you control timing.
- **Multi-source dashboard.** Wire three terminals into one agent; the button pipes all of them at once, labelled by source.
- **Compliance use.** For regulated environments where automated AI routing is restricted, manual pipes create an auditable "I saw this and sent it" moment.

## Tech notes

- The button's glow state is driven by `unreadBytes` — computed as `sources.reduce((total, src) => total + src.fresh.length, 0)` where `fresh` = output since last pipe.
- Click handler: for each wired source, extract fresh bytes, scrub ANSI, chunk into 128-byte PTY writes, commit offsets via `pipedOffsets[srcPtyId] = nextOffset`.
- Button hidden when no incoming wires or when the agent has no PTY (not yet spawned).
- Byte counter capped at 500 KB per source — matches the wireData buffer cap.

**Key files:** `src/components/tiles/AgentTile.tsx` (PipeContextButton).

## Related

- [Auto-pipe](./auto-pipe.md) · [Context-pipe wire](../wiring/context-pipe.md) · [Agent tile](../tiles/agent.md)
