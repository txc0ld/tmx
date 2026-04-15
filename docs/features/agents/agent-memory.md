# Agent Memory

> Per-project context auto-injected into every agent you spawn.

## What it is

A markdown blob you write once per project. Every time an agent spawns in that project, the memory is written into the PTY as a "Project context" prompt once the agent's prompt is ready.

## How to set it

- Command Palette → "Edit Project Context" (or click the brain icon).
- Modal opens with a textarea. Write whatever the agent should know:
  ```markdown
  This is a Tauri 2 + React 19 codebase.
  - Stores live in src/stores (Zustand)
  - Rust commands in src-tauri/src/commands
  - Never use tauri-plugin-fs; use readFileText/writeFileText
  - Tests: pnpm test, cargo test --lib
  ```
- Save. Persists in `localStorage['tx-agent-memories']`.
- Next agent spawn picks it up automatically.

## Power moves

- **Architecture doc as memory.** Paste your `CLAUDE.md` or `ARCHITECTURE.md` directly in. The agent starts with full context.
- **Rules + preferences.** Include coding conventions, banned patterns, preferred libraries — agent output matches your style from turn 1.
- **Per-repo memory.** Memory is scoped per project id, so cross-project agent sessions stay isolated.
- **Disable for throwaways.** Leave memory empty for scratch-project spawn sessions where you don't want loaded context.

## Tech notes

- Control chars and ANSI escapes stripped via `replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')` before writing — prevents terminal injection from pasted content.
- Injected after a **silence-detection** signal: the agent tile listens for PTY output, then waits 1.2 s of quiet before writing the memory. Fallback hard cap: 15 s. This is why slow-starting agents don't miss their memory — the previous flat 2 s timer would fire before the prompt was ready on slow machines.
- Memory write: `ptyWrite(id, \`Project context: ${safeMem}\`)` followed 300 ms later by `\r` to submit.
- Persisted in `localStorage`, not disk — it's small and per-device.

**Key files:** `src/stores/agentMemoryStore.ts`, `src/components/tiles/AgentTile.tsx` (spawn + inject block).

## Related

- [Agent spawn](./agent-spawn.md) · [Agent tile](../tiles/agent.md)
