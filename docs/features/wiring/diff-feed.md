# Wire: diff-feed

> Agent done → Diff tile populate signal.

## What it does

Fires when an Agent transitions to `done`. Emits a toast cueing "Agent completed — diff tile should be refreshed". The Diff tile is typically in `git` mode; the user manually refreshes or re-picks a file to see new changes.

## How to wire

- Drag from an Agent's right-edge port to a Diff tile's left-edge port.
- Agent runs a code-changing task (edits files, commits, etc.).
- On `done`, the toast fires. Click a file in the Diff tile's git sidebar to see updated content.

## Power moves

- **Agent-code-review loop.** Agent modifies code → toast fires → you visually review in Diff → either accept or prompt the agent with feedback via [context-pipe](./context-pipe.md).
- **Pair with Git tile.** Keep a [Git tile](../tiles/git.md) next to the Diff — the Git tile's file list auto-refreshes every 30 s, showing modified files; the Diff shows individual diffs; the wire ties them to agent activity.
- **Codex autonomous.** Codex often produces a unified-diff block in its output. A future enhancement may parse that and auto-populate the Diff tile's paste mode. For now, copy-paste manually or use git mode.

## Tech notes

- Wire handler calls `toastStore.addToast(...)` with info-level severity.
- Wire is active for 2 s after firing.
- The wire doesn't currently parse the agent's output to auto-fill the diff — this is a documented limitation. Agents that produce clean `diff` blocks would benefit from a parser.

**Key files:** `src/hooks/useWiringEngine.ts` (diff-feed handler).

## Related

- [Diff tile](../tiles/diff.md) · [Agent tile](../tiles/agent.md) · [Git tile](../tiles/git.md)
