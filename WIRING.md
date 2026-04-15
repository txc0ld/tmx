# Wiring Tiles Together

> Connect tiles on the canvas so data flows between them automatically. This is the feature that makes TerminalX different from a regular terminal — you build agent pipelines once, then let them run.

**Total time to learn:** 2 minutes.

---

## Quick start (60 seconds)

1. Open TerminalX and click **Layout** in the top bar — this spawns a default workspace with Terminal, Agent, Files, Tasks, and Git tiles.
2. **Hover** over the Terminal tile — a small glowing circle appears on its **right edge**.
3. **Click and drag** from that circle — a dashed line follows your cursor.
4. **Drop** on the Agent tile's **left edge** — the line snaps in place.
5. Done. The Terminal is now wired to the Agent. Anything that happens in the Terminal will be piped to the Agent as context when the Agent completes its next task.

![wiring diagram](https://txc0ld.github.io/tmx/wiring-demo.png)

---

## The interaction — step by step

### On macOS and Windows (identical)

| Step | What to do | What you'll see |
|------|-----------|-----------------|
| 1 | Hover any tile | A small accent-colored circle appears on the **right edge** (output) and **left edge** (input) |
| 2 | Press mouse down on the **right edge circle** | A dashed line starts following your cursor |
| 3 | Drag your cursor to another tile | The line stretches with you as you move |
| 4 | Release over the other tile's **left edge circle** | The other tile's circle lights up, then the wire locks in place |
| 5 | Release anywhere else | Wire is cancelled, nothing happens |

### Keyboard

- **Esc** — cancel an in-progress drag at any time (either platform)

### Removing a wire

**Right-click** on any wire (the 12px hit area around the line is invisible but clickable). A confirmation dialog appears → click OK.

- **macOS trackpad:** two-finger tap on the wire
- **Windows:** right-click
- **Linux:** right-click

---

## The 5 wire types

TerminalX picks the right wire type automatically based on what you connect. You don't configure it — just drag.

### 1. context-pipe

**What you wire:** Terminal → Agent (or Runner → Agent)

**What it does:** Everything printed in the terminal gets piped into the agent as context when the agent finishes its next task. Think of it as giving your agent a live view of your shell.

**Example prompt to use in the agent:**
> "Review what I just ran in the terminal and suggest improvements."

---

### 2. agent-chain

**What you wire:** Agent A → Agent B

**What it does:** When Agent A completes, its entire output gets fed into Agent B as context. Agent B sees `--- Context from previous agent (A's name) ---` followed by A's final 50 lines.

**Example — design → build pipeline:**

1. Wire **Claude (opus-4)** → **Codex**
2. Prompt Claude: *"Design a REST API for a todo app. When complete, output DONE on a new line."*
3. Claude responds with the schema → outputs DONE → wire fires.
4. Codex receives Claude's full response → you tell Codex *"Implement the API above in TypeScript/Express."*

---

### 3. refresh-trigger

**What you wire:** Agent → Browser

**What it does:** When the agent completes, the browser tile gets a "refresh" signal (shown as a toast). Useful if you're coding a local web app and want to see changes after the agent makes them.

**Example:** Wire Claude → Browser tile pointing at `localhost:3000`. Agent edits a React file → finishes → browser tile knows to refresh (either manually click refresh or set HMR up in your dev server).

---

### 4. task-assign

**What you wire:** Agent → Tasks (Todo tile)

**What it does:** The agent's last output line becomes a new task in the todo list, tagged with the agent's name.

**Example prompt:**
> "Audit this codebase and list follow-up work. Every bullet you output will become a task — keep them concise and action-oriented."

---

### 5. diff-feed

**What you wire:** Agent → Diff

**What it does:** When the agent completes, the diff tile receives a refresh signal. Pair this with a diff tile pointed at a specific file you care about.

---

## Bonus: Auto-recovery (Runner → Agent)

This is the most underrated pattern.

1. Spawn a **Runner** tile with command `npm test` (or `cargo test`, `pytest`, whatever)
2. Spawn a **Claude** agent
3. Wire Runner → Agent
4. Hit **Run** on the runner

If the tests **pass**, nothing happens. If they **fail**, the error output is auto-dispatched to Claude with a prompt asking to fix it. Claude reads the error, patches the code, you re-run. No manual copy-paste.

---

## The DONE signal — making agent-chain reliable

Agent CLIs (Claude, Codex, Gemini) stay running after each response. They don't exit. TerminalX needs some way to know "this agent is done with the current task" so the wire can fire.

Two ways to signal done:

### 1. Explicit DONE sentinel (recommended)

End every agent prompt with an instruction like:

> "When complete, output DONE on a new line."

The word `DONE` on its own line (case-insensitive) flips the agent's status to done → fires the wire → next agent picks up.

**Accepted forms:**
- `DONE`
- `done`
- `Done`
- `✅ DONE`
- `✓ DONE`
- `[DONE]`
- `## DONE`
- `DONE.`
- `DONE!`

**Won't false-trigger on:**
- `DONEness`
- `DONE-STATE`
- `"DONE" mentioned mid-sentence`

### 2. Idle timeout (automatic fallback)

If you forget to ask for DONE, the agent still auto-completes after **8 seconds of silence** (configurable). Safeguards prevent this from firing on welcome banners or short status lines.

**To change the idle timeout:**

Press **Ctrl+K** (or **⌘K** on macOS) → type `idle` → select **"Set Agent Idle Threshold"** → enter the number of seconds.

**To disable auto-complete entirely for an agent:**

Ctrl+K / ⌘K → search **"Toggle Agent Auto-Complete"** with the agent tile focused.

### Visual confirmation

When the wire fires, you'll see a grey marker in the terminal:

```
[auto-complete: DONE sentinel detected]
```

or

```
[auto-complete: idle > 8s]
```

This tells you exactly why the wire triggered.

---

## Real-world workflows

### Multi-agent code review

```
┌──────────┐       ┌──────────┐       ┌──────────┐
│ Codex    │──────▶│ Claude   │──────▶│ Diff     │
│ (writer) │       │ (review) │       │ (output) │
└──────────┘       └──────────┘       └──────────┘
```

1. Give Codex a coding task → outputs code + DONE.
2. Wire fires → Claude gets Codex's code + your prompt "Review this for bugs, security, and style. Output DONE when finished."
3. Wire fires → Diff tile refreshes with whatever file the agents touched.

### Slack-driven autopilot

```
Slack #tasks  →  Todo tile  →  Claude agent  →  Git tile
                  (auto-dispatch)   (auto-complete)
```

1. Connect Slack MCP in Tasks tile (click MCP tab).
2. Toggle **Auto** dispatch on.
3. Wire Claude → Git tile.
4. Drop a task in Slack: *"Add dark mode toggle. Output DONE when complete."*
5. Tasks tile syncs every 5 min → picks up your message → auto-dispatches to Claude.
6. Claude implements → outputs DONE → Git tile refreshes showing the staged changes.
7. You review the diff → commit → done.

### Self-healing CI

```
┌──────────┐       ┌──────────┐
│ Runner   │──────▶│ Claude   │
│ (tests)  │       │ (fixer)  │
└──────────┘       └──────────┘
```

1. Runner tile: `npm test -- --watch`.
2. Wire Runner → Claude agent.
3. Leave it running. Tests fail → error auto-dispatches to Claude → Claude fixes the code → tests re-run → you wake up to a fixed test suite.

---

## Troubleshooting

### The ports don't appear when I hover

- Make sure you're hovering over a **tile**, not an empty canvas area.
- The ports only show on tiles that have finished loading. If a tile shows "Loading...", wait a second.
- Focus mode hides ports on dimmed tiles. Press **Esc** to exit focus mode first.

### My wire snaps to a different tile than I intended

- The drop target is the tile whose **left edge** you released over. If two tiles are close together, zoom in (scroll up) to give yourself more space, or drag the tiles apart first.

### The agent finishes but the wire doesn't fire

- Did the agent output `DONE` on its own line? Check the terminal output.
- Has the agent been silent for more than the idle threshold? Try waiting 10 seconds.
- Is the agent tile focused and spawned properly? A tile in `error` state won't fire chain wires.

### The wire fires twice

- If the agent writes `DONE` then keeps writing more output, the idle timer could fire later too. Add a line break after DONE and stop writing:
  > "When complete, output DONE on a new line and then stop."

### "Path is outside the allowed roots" error

- If the Files tile says this, restart the app. The latest release handles Windows UNC paths correctly.

### Wires work in dev mode but not after `pnpm tauri build`

- The file watcher might have missed a Rust change. Force a rebuild: `cd src-tauri && cargo clean && cd .. && pnpm tauri build`.

---

## Tips

- **Give wires a test run before committing** — drop a simple Terminal → Agent wire, run `ls` in the terminal, ask the agent "what did I just run?" — you'll see the full output piped in.
- **Wire multiple tiles into the same agent** — multiple inputs feed the same input port. They get merged into one context block.
- **Keep prompts short** — the last 50 lines of PTY output go into the next agent. If your agent produces too much output, only the tail reaches the next tile.
- **Save your wired layouts** — click **Save** in the top bar after arranging and wiring. Next time you hit **Layout**, your saved arrangement (including wires) restores automatically.
- **Rubber-band select tiles** — hold Shift + drag on empty canvas to select multiple tiles, then move them together. Wires stay attached.

---

## Summary

| I want to... | Wire this |
|---|---|
| See my terminal output from an agent | Terminal → Agent |
| Chain two agents (designer → builder) | Agent → Agent |
| Refresh a browser preview when agent finishes | Agent → Browser |
| Turn agent output into a todo list | Agent → Tasks |
| Refresh a diff view when code changes | Agent → Diff |
| Auto-fix failing tests/builds | Runner → Agent |

**Remember:** just drag from the right edge of one tile to the left edge of another. TerminalX figures out the wire type.

---

*Questions? File an issue at [github.com/txc0ld/tmx/issues](https://github.com/txc0ld/tmx/issues).*
