# Wire: context-pipe

> Terminal output → Agent context.

## What it does

Pushes the tail of a source tile's output into an Agent as context. Most common use: Terminal → Agent, so the agent can "see" what just happened in your shell.

## How to wire

- Drag from a Terminal / Runner / Agent's right-edge port to an Agent's left-edge port.
- Click the glowing **Pipe Context** button on the Agent to push unread bytes, or flip **Auto** on the agent to fire automatically when the source goes idle.
- See [Pipe Context button](../agents/pipe-button.md) and [Auto-pipe](../agents/auto-pipe.md).

## Power moves

- **Split work between a terminal and an agent.** Run a failing test in a Terminal tile, wire it to a Codex tile, flip Auto — the next test run auto-feeds the error to the agent.
- **Summarize a long session.** `Terminal → Claude` with `autoPromptTemplate: "Summarize the above in 3 bullets"`.
- **Multi-source context.** Two wires into one agent — terminal output + runner output both get piped as labelled context blocks when piping.
- **Skip the template.** Leave `autoPromptTemplate` empty and the pipe sends context only — the agent responds based on whatever's already in its chat state.

## Tech notes

- The wire handler tracks byte offsets per source PTY in `pipedOffsets` — only **new** bytes since the last pipe are included. Reduces duplicate context on repeat pipes.
- The pipe runs ANSI / control-char scrubbing (`cleanPtyOutput`) before writing to the agent. Strips CSI escape sequences, OSC title sequences, backspaces.
- Auto-pipe requires the source to have had a command **submitted** since the last pipe (tracked via `commandSubmittedAt`). Prevents firing on idle after app load.
- 500 KB wireData cap per source — if a single burst exceeds it, older output is dropped and a one-shot toast warns the user (see [workspace](../persistence/workspace.md) → wireData cap).

**Key files:** `src/components/tiles/AgentTile.tsx` (PipeContextButton), `src/hooks/useWiringEngine.ts`.

## Related

- [Pipe Context button](../agents/pipe-button.md) · [Auto-pipe](../agents/auto-pipe.md) · [Terminal tile](../tiles/terminal.md) · [Agent tile](../tiles/agent.md)
