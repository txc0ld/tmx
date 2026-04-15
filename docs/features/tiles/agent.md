# Agent Tile

> Claude Code, Codex, or Gemini CLI running inside a PTY on the canvas.

## What it is

Spawns a CLI coding agent (`claude`, `codex`, or `gemini`) with your project's context pre-loaded. Watches for completion signals so wires can fire without waiting for the process to exit.

## How to use

- Spawn from the dock (Agent) or Command Palette. Pick `claude` / `codex` / `gemini`.
- The gear icon opens config: model, effort, custom command, auto-complete + auto-pipe toggles.
- Memory injects automatically once the agent's startup output settles — see [agent memory](../agents/agent-memory.md).
- Press the glowing **Pipe Context** button (appears with incoming wires and unread bytes) to push upstream output manually, or flip **Auto** for hands-free.
- Click `✕` in the title bar to kill. PTY and registry entry both clean up.

## Use cases

**Agent chain.** `Designer (Claude) → Builder (Codex) → Reviewer (Gemini)`. Each completes, the next fires via [agent-chain](../wiring/agent-chain.md).

**Supervised terminal.** Terminal output pipes into an agent that summarizes, critiques, or auto-fixes via [context-pipe](../wiring/context-pipe.md).

**Todo → agent.** MCP tasks route into the agent as prompts via [task-assign](../wiring/task-assign.md). Inbox zero with muscle.

## Tech notes

- Agent spawn goes through `pty_spawn_internal` (bypasses the renderer shell allowlist) because agents are trusted programs, not shells. On Windows, `.cmd` wrappers are routed through `cmd.exe /C`.
- **Auto-complete** fires on either (a) a configurable DONE regex (`doneSentinel`, defaults cover `DONE`, `✅ DONE`, `[DONE]`, `## Done`) or (b) `idleThresholdMs` of silence (default 8 s). The agent doesn't need to exit — wires fire on logical completion.
- **Agent memory** injects 1.2 s after the first output arrives (or 15 s fallback). Prevents writing into a PTY that hasn't hit its prompt yet.
- **Auto-pipe** (off by default) pipes wired source output + an optional prompt template into the agent's PTY once the source has been idle for `autoPipeIdleMs` (default 2 s) after a command was submitted.

**Key files:** `src/components/tiles/AgentTile.tsx`, `src/stores/agentMemoryStore.ts`, `src-tauri/src/commands/agents.rs`.

## Related

- [Agent spawn](../agents/agent-spawn.md) · [Agent memory](../agents/agent-memory.md) · [Auto-complete](../agents/auto-complete.md) · [Auto-pipe](../agents/auto-pipe.md) · [Pipe Context button](../agents/pipe-button.md)
