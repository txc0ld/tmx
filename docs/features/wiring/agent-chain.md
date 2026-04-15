# Wire: agent-chain

> Agent → Agent. When one agent completes, its output becomes the next agent's prompt.

## What it does

Connects two agent tiles. When the source agent hits `done` (DONE sentinel or idle), the last 50 lines of its output are piped into the target agent's PTY as a labelled context block, and Enter is sent to submit.

## How to wire

- Drag from an Agent's right-edge port to another Agent's left-edge port.
- The source agent is marked `done` by the [auto-complete](../agents/auto-complete.md) detector without needing to exit.
- The target agent receives the piped context and responds to whatever prompt you pre-loaded it with (or to the context itself if blank).

## Power moves

- **Designer → Builder → Reviewer.** Classic 3-agent chain for code work: Claude drafts a plan, Codex implements, Gemini reviews.
- **Mixed-model pipelines.** Use an expensive Opus agent upfront for planning, cheap Haiku agents for execution, then another Opus for final review.
- **Fan-out debates.** Wire one Claude to three different agents with different prompts, compare their critiques.
- **Pair with memory.** The chain's upstream agent sees the project's [agent memory](../agents/agent-memory.md); downstream agents inherit context through the pipe without needing memory set themselves.

## Does agent-chain need Auto?

**No.** Agent-chain fires on `done` automatically — it's not a manual-pipe wire. The **Auto** toggle on an agent is only for [context-pipe](./context-pipe.md) from non-agent sources (Terminal, Runner). An incoming agent-chain is always hands-free.

## Tech notes

- Engine triggers on the agent's status transition `working → done`. Previous status is tracked in `prevAgentStatusRef` and committed **before** handlers run to prevent re-entry.
- Piped payload: `--- Context from previous agent (<title>) ---\n<last 50 lines>\n--- End context ---\n` followed by `\r` to submit.
- If the source has no `ptyId` (agent not yet spawned), the wire skips silently.
- Wire pulses for 3 s after firing (longer than data-flow wires) to make chain transitions visually obvious.

**Key files:** `src/hooks/useWiringEngine.ts` (agent-chain handler).

## Related

- [Agent tile](../tiles/agent.md) · [Auto-complete](../agents/auto-complete.md) · [context-pipe](./context-pipe.md)
