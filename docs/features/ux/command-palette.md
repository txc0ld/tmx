# Command Palette

> One shortcut to every action.

## What it is

A keyboard-first action launcher. `Ctrl/⌘ + K` opens it; type to fuzzy-search across projects, tiles, templates, snapshots, git commands, workspaces, and navigation actions.

## How to use

- **Open:** `Ctrl+K` (Linux/Windows) / `⌘+K` (macOS).
- **Navigate:** `↑↓` arrows, `Enter` to select, `Esc` to close.
- **Search:** Type — Fuse.js fuzzy-matches label + category.
- Each result shows its shortcut (if any) and category on the right.

## Categories

| Category | Examples |
|---|---|
| project | Switch project, create project, delete project |
| tile | Add Terminal, add Agent, duplicate tile, clone tile |
| command | Add bookmark, jump to bookmark, focus mode, sticky note |
| navigate | Zoom to 100%, reset transform, fit all tiles |
| workspace | Save snapshot, load snapshot, export / import workspace, time travel |
| template | Apply template, save current tile as template |
| git | Status, log, branches (quick open a Git tile) |

## Power moves

- **Palette-first workflow.** Almost every action has a palette entry — memorize fewer shortcuts.
- **Dynamic items.** Projects, templates, and snapshots load fresh every palette open — a template you saved 30 seconds ago shows up immediately.
- **No mouse needed.** Open palette → type "new terminal" → Enter → tile spawns at the dock spawn point. Entire workflow without a click.

## Tech notes

- Fuse.js fuzzy search over a flat `PaletteAction[]`. Each action has `{ id, label, category, icon?, shortcut?, action() }`.
- Results re-sorted by Fuse score; ties broken by alphabetical label.
- Dynamic actions: every palette render rebuilds the action list from the current stores (project list, template list, snapshot list, etc.) — no cache staleness.
- `Ctrl+K` key binding set via the global shortcut plugin; also captured in the main window's `keydown` handler for redundancy.

**Key files:** `src/components/palette/CommandPalette.tsx`, `src/stores/paletteStore.ts`.

## Related

- [Templates](./templates.md) · [Session timeline](./session-timeline.md) · [Snapshots](../persistence/snapshots.md)
