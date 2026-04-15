# Prompt Library

> One-click dispatch of curated prompts into any Agent tile.

## What it is

A personal library of reusable prompts. Eight curated built-ins ship with the app (code review, test writer, doc writer, refactor, explain, debug, security review, performance audit). You save your own on top. Every prompt is one click away in the Command Palette — select it, it fires into the focused Agent tile.

## How to use

- Open the Command Palette (`Ctrl/⌘+K`).
- Type a prompt name or browse — each one shows with an icon: `🔍 Code review`, `🧪 Write tests`, `📝 Document this`, etc.
- Select → the prompt body is chunk-written to the focused agent's PTY and submitted with a `\r`.
- Fall-back: if no agent is focused, the most recently spawned agent tile receives it. Toast confirms dispatch.
- **Save your own**: palette → `Save Prompt to Library…` → enter body + name + description.

## Power moves

- **Codebase context + a prompt = instant work.** Combine [agent memory](../agents/agent-memory.md) (project context) with a library prompt (task) — the agent has both on spawn.
- **Build a team library.** Copy `localStorage['tx-prompt-library']` from one machine to another, or commit its JSON to a dotfile. Whole team runs the same "our code review prompt".
- **Focus the right agent first.** The dispatch targets the *focused* agent. Click an agent tile before firing the palette action to target it precisely. Without focus, the last-spawned agent gets it.
- **Pair with blueprints.** A [blueprint](./blueprints.md) spawns an agent; a library prompt immediately hands it a task. Two palette actions = a full workflow.

## Built-in prompts

| Icon | Name | What it does |
|---|---|---|
| 🔍 | Code review | Review recently changed files for bugs, style, obvious issues |
| 🧪 | Write tests | Generate unit tests for the most recently touched module |
| 📝 | Document this | Add concise docstrings to a target file |
| 🔧 | Refactor | Small, safe refactor for readability without behavior change |
| 💡 | Explain this | Walk through what the target code does at a high level |
| 🐛 | Debug | Diagnose the bug from the current terminal error output |
| 🛡️ | Security review | Audit current diff for security issues |
| ⚡ | Performance audit | Find hot-path inefficiencies in a target module |

## Tech notes

- Store: `src/stores/promptLibraryStore.ts` — Zustand + localStorage. Built-ins hydrate from code on every load; user prompts load from `localStorage['tx-prompt-library']`.
- Built-ins can't be edited or deleted (same pattern as template built-ins). Clone into a user prompt if you want to modify.
- `dispatchPrompt(ptyId, prompt, writeFn)` chunks the body at 128 bytes with 50 ms inter-chunk delay before sending `\r` — mirrors the task-assign wire dispatch so long prompts don't drop bytes on Windows PTY pipes.
- Each built-in has a stable id (`builtin:code-review` etc.) so palette search keeps matching across app updates.

**Key files:** `src/stores/promptLibraryStore.ts`, `src/components/palette/CommandPalette.tsx` (prompt-library block).

## Related

- [Agent tile](../tiles/agent.md) · [Agent memory](../agents/agent-memory.md) · [Templates](../ux/templates.md) · [Blueprints](./blueprints.md)
