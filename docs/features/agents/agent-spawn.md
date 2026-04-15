# Agent Spawn

> How Claude / Codex / Gemini actually start.

## What it is

The pipeline that takes a click on "Spawn Agent" and ends with a live `claude` / `codex` / `gemini` process running inside a PTY on the canvas, with your project's memory injected and auto-completion detection armed.

## How to spawn

- Add an Agent tile from the dock.
- Gear icon → pick **Claude / Codex / Gemini** and optionally set a custom command (e.g. `claude --model opus-4 --dangerously-skip-permissions`).
- Click **Spawn**. Terminal view appears immediately; agent initializes.
- Once the agent's startup output settles (1.2 s of silence), your [agent memory](./agent-memory.md) is injected.

## Power moves

- **Custom command.** Use the gear to override the binary invocation — e.g. `claude -p "<task>"` to spawn with a pre-loaded prompt, or specify an alternate model flag.
- **Effort selector.** Claude's `--effort` flag is passed through; set `minimal` for speed or `high` for deep thinking.
- **Multiple agents of same type.** Spawn three Claude tiles with different prompts/memory to run parallel takes on a problem.
- **Environment hacks.** Your system `$SHELL` env / PATH is inherited — ensure `claude` / `codex` / `gemini` binaries are accessible.

## Tech notes

- Spawn goes through `agent_spawn` IPC → resolves the binary in PATH → validates args (null bytes, 16 KB cap) → on Windows wraps in `cmd.exe /C` for `.cmd` scripts → calls `pty_spawn_internal` (bypasses the renderer's shell allowlist because agents aren't shells).
- Binary not found returns a friendly error with install hint. Shows in the tile terminal.
- Agent registers in `state.agent_registry` after PTY spawn succeeds; emits `agent-status` event. Registry entry includes id, type, status, cwd.
- Spawn is Windows-aware: agent CLIs are typically npm `.cmd` scripts that must go through `cmd.exe` — the pipeline handles this automatically.
- `MAX_CONCURRENT_PTYS = 64` applies (shared with terminals). An agent spawn is a PTY spawn.

**Key files:** `src-tauri/src/commands/agents.rs`, `src-tauri/src/commands/terminal.rs` (pty_spawn_internal), `src/components/tiles/AgentTile.tsx`.

## Related

- [Agent tile](../tiles/agent.md) · [Agent memory](./agent-memory.md) · [Auto-complete](./auto-complete.md) · [PTY management](../platform/pty-management.md)
