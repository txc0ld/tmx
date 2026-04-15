# Note Tile

> Freeform markdown textarea. Auto-saved.

## What it is

A plain markdown editor. Not rendered preview — just text in, text out. The point is speed and durability, not fanciness.

## How to use

- Add from the dock.
- Type markdown. Auto-saves 500 ms after you stop.
- Clone via the title bar chrome (`⎘`) to duplicate the note.
- Pin terminal output as a note via the Terminal tile's 📌 button — the captured output lands here as a code fence.

## Use cases

**Session scratchpad.** Jot notes as you debug, without alt-tabbing to Obsidian or Apple Notes.

**Captured output.** Pinned terminal output lives as a Note tile so you can compare before/after, or keep a failing error visible while you fix it.

**Quick todos.** Sometimes you don't want MCP syncing or Kanban — just a bullet list. Note tiles beat Todo tiles for this.

## Tech notes

- 500 ms debounce on every keystroke; the timer is captured in a ref and cleared on unmount.
- Content stored at `tile.content` — persisted with the workspace like any other tile state.
- No markdown rendering in v1 — intentional. Adding a preview toggle would complicate the save path and add a heavy markdown parser to the bundle.
- Content length is capped at 2 MB in the workspace-import validator.

**Key files:** `src/components/tiles/NoteTile.tsx`, `src/utils/workspaceImport.ts` (validation).

## Related

- [Terminal tile](./terminal.md) · [Kanban tile](./kanban.md)
