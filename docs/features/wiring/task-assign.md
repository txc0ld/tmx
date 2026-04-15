# Wire: task-assign

> Todo → Agent. New todo items become agent prompts.

## What it does

When the Todo tile has its **Auto** toggle on and is wired to an Agent, every new item (manual or MCP-imported) is chunk-written to the agent's PTY followed by `\r`, dispatching it as a prompt.

## How to wire

- Drag from Todo's right-edge port to an Agent's left-edge port.
- Flip **Auto** on the Todo tile.
- Add items (manually or via an MCP connection like GitHub / Linear / Slack).
- Each new item is dispatched to the agent within ~100 ms.

## Power moves

- **Inbox-to-agent.** Wire GitHub → Todo → Claude. Every assigned PR becomes a prompt. With [agent memory](../agents/agent-memory.md) set to your project's architecture, the agent can respond intelligently to each issue.
- **Selective dispatch.** Leave Auto off, manually click "send to agent" on specific items (feature landing soon).
- **Multi-stage triage.** Todo → Agent-1 (classifier) → Agent-2 (implementer). Tasks first classified, then implemented.
- **Scheduled kick-offs.** Wire Google Calendar → Todo → Agent. Calendar events become prompts as they approach — "prep for meeting X".

## Tech notes

- The dispatch writes tasks in **128-byte chunks with a 50 ms inter-chunk delay** before sending `\r`. Without chunking, long task descriptions drop bytes on Windows PTY pipes. See `TodoTile.tsx` for the chunking logic.
- `autoDispatch` is the tile-local state; persisted with the Todo tile's snapshot.
- Each task has a stable upstream source id (e.g. Linear issue id). `seenTaskIds` ensures a task isn't dispatched twice even across app restarts.
- If the target agent has no `ptyId` (not yet spawned / crashed), the dispatch silently skips.

**Key files:** `src/components/tiles/TodoTile.tsx`.

## Related

- [Todo tile](../tiles/todo.md) · [Agent tile](../tiles/agent.md) · [MCP overview](../integrations/overview.md)
