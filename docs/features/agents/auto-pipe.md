# Auto-Pipe

> Hands-free: upstream source goes idle → context auto-pipes to agent.

## What it is

A per-tile toggle on Agent tiles. When enabled and the agent has an incoming wire from a Terminal / Runner / Agent, the upstream source going idle auto-triggers a pipe of its output plus an optional prompt template.

## How to enable

- Agent tile gear → **Auto-pipe** toggle.
- Optional: set **Auto-prompt template** — a string appended after the piped context. Example: `"Summarize the above in one sentence."`
- Wire a source (Terminal, Runner, Agent) into this agent.
- Run a command in the source → wait for idle → pipe fires automatically.

## Power moves

- **Hands-free test-fix loop.** Runner (tests) → Claude (fixer), auto-pipe on, template = `"Fix this error"`. Every failing test auto-dispatches to Claude.
- **Auto-summarize.** Terminal → Claude with template `"Summarize the last 50 lines in 3 bullets"` — get a recap every time you run something.
- **Pipe with no template.** Leave the template blank and the pipe just sends context — useful when the agent's system prompt already knows what to do.
- **Multi-source pipes.** Two wires into one agent; auto-pipe fires per source. Each source contributes a labelled context block.

## When does it fire?

Auto-pipe only fires when **(a)** auto-pipe is enabled on the agent, **(b)** a command has been submitted in the source since the last pipe (tracked via `commandSubmittedAt`), **and (c)** the source has been silent for `autoPipeIdleMs` (default 2 s). The command-gated condition prevents spurious fires on idle-at-startup.

## Tech notes

- Byte-offset tracking per source PTY in `pipedOffsets` — only new output since the last pipe is included.
- ANSI/control-char scrubbing (`cleanPtyOutput`) runs before the write: strips CSI / OSC sequences, backspaces, carriage-return artifacts.
- 500 KB wireData cap per source is applied before auto-pipe reads; a truncation toast fires once if exceeded.
- Template is prepended after the piped context: `"${labelled context}\n\n${autoPromptTemplate}"` then `\r` to submit.

**Key files:** `src/components/tiles/AgentTile.tsx` (PipeContextButton auto-fire block).

## Related

- [Pipe Context button](./pipe-button.md) · [Context-pipe wire](../wiring/context-pipe.md) · [Agent tile](../tiles/agent.md)
