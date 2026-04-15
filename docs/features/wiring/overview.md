# Wiring Overview

> Drag tile → tile to automate what would otherwise be copy-paste.

## What wiring is

A wire is a persistent connection between two tiles. When the source produces interesting output (data, a status change, a file click), the engine fires a handler that acts on the target. Six wire types are auto-inferred from the source and target — you never pick the type manually.

## How to wire

- Hover a tile to reveal its round **output port** (right edge) and **input port** (left edge).
- Mouse-down on the source's output port. A preview line follows the cursor.
- Mouse-up on the target's input port to create the wire.
- Right-click a wire to delete it.
- `Esc` during drag cancels.

## Power moves

- **Multi-target fan-out.** Wire a File Tree to *two* Editor tiles — clicks go to both, or to whichever one matches your routing (useful for split-screen before/after).
- **Chain any length.** `Terminal → Agent-1 → Agent-2 → Agent-3`. Each completion pushes into the next. See [agent-chain](./agent-chain.md).
- **Auto-recovery pattern.** `Runner → Agent`. When the runner fails, the last 30 lines go to the agent with "fix this error" as a prefix.
- **Wire through Todo.** MCP → Todo → Agent. Inbox tasks land in Todo and auto-dispatch to the agent via [task-assign](./task-assign.md).
- **Pipe once, then disable.** Use the **Pipe Context** button for a one-shot push instead of wiring — useful when you don't want auto-firing.

## Tech notes

- Wires are plain data: `{ id, fromTile, toTile, fromPort, toPort, wireType, active }`. Stored in `canvasStore.wires[projectId]`.
- The type is inferred once at creation by `inferWireType(from, to)` in `stores/wiringStore.ts` — the UI never shows a type picker.
- The engine lives in `useWiringEngine` and is driven by Zustand subscriptions. It short-circuits on ref-equal state updates (focus, selection, bookmarks) and only runs a full pass on `wireData` / `tiles` / `wires` / `activeProject` changes.
- Wire firing is visualized: `wire.active` flips `true` for 1.5–3 s after a handler runs, drawing an animated dashed stroke over the wire path.

**Key files:** `src/stores/wiringStore.ts`, `src/hooks/useWiringEngine.ts`, `src/components/wiring/WiringLayer.tsx`.

## Related

- [context-pipe](./context-pipe.md) · [agent-chain](./agent-chain.md) · [refresh-trigger](./refresh-trigger.md) · [task-assign](./task-assign.md) · [diff-feed](./diff-feed.md) · [file-open](./file-open.md)
