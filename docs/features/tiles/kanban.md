# Kanban Tile

> Multi-column task board on the canvas.

## What it is

A lightweight Kanban board with user-defined columns and cards. No fancy dependencies — just persistent DOM, saved with your workspace.

## How to use

- Add a Kanban tile from the dock or a template.
- Click `+ Column` to add columns.
- Click `+` in a column to add a card.
- Delete cards with `×`. Delete columns via the column menu.
- Optional: set a card color for priority indicators.

## Use cases

**Project board.** Track tasks at the tile level — To Do / Doing / Done.

**Sprint planning.** Keep the canvas open during planning, push cards between columns as you discuss.

**Agent output triage.** After an agent-chain completes, manually distribute the suggested tasks into your own columns.

## Tech notes

- Columns and items stored in `tile.columns: KanbanColumn[]`. Columns contain `items: KanbanItem[]` with optional colors.
- No drag-between-columns in v1 — items stay in their column. Cross-column move is a future enhancement.
- Workspace-import validator caps columns at 32 per tile and items at 2000 per column.
- Lazy-loaded chunk — doesn't inflate the main bundle unless you actually use a Kanban.

**Key files:** `src/components/tiles/KanbanTile.tsx`.

## Related

- [Todo tile](./todo.md) · [Note tile](./note.md)
