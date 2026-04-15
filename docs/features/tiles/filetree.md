# File Tree Tile

> Recursive directory browser that routes clicks to wired editors.

## What it is

Expand/collapse directory view rooted at any path on disk. Click a file to open it — either in a wired [Editor](./editor.md) / [Diff](./diff.md), or as a new Editor tile if no wires exist.

## How to use

- Add a File Tree tile. Default root is project cwd; change via the tile's config.
- Click folders to expand/collapse; expansion state is persisted.
- Click a file to open it. See routing under "Use cases".
- Wire from this tile's output port to an Editor or Diff — subsequent clicks route there instead of spawning new editors.

## Use cases

**Canvas file browser.** One File Tree + one Editor wired together = a VS Code-like pair that doesn't sprawl into tabs.

**Diff-as-you-browse.** Wire to a Diff tile in git mode — clicking files shows their diff vs HEAD without opening anything else.

**Multi-editor fan-out.** Wire to two Editors — clicks open in whichever one the wire prioritizes (visual wire order).

## Tech notes

- Backend `read_file_tree` recurses up to a configurable depth (default 4, max 8) to avoid pulling `node_modules` into the frontend. Symlinks are skipped to prevent infinite loops.
- File-open wires are **click-routed, not data-driven**. Clicking a file invokes `handleSelectFile`, which scans wires from this tile of type `file-open` and routes the path to each target with smart per-type logic:
  - Editor: sets `filePath` + `title`.
  - Diff git mode: sets `gitTarget` if path is under `repoPath`.
  - Diff compare mode: fills the empty side.
  - Diff paste mode: switches to compare mode with the path on the right.
- No wire = fallback to spawning a new Editor next to this tile.
- Wire pulses for 1.5 s after routing for visual feedback.

**Key files:** `src/components/tiles/FileTreeTile.tsx`, `src-tauri/src/commands/filesystem.rs` (read_file_tree).

## Related

- [file-open wire](../wiring/file-open.md) · [Editor tile](./editor.md) · [Diff tile](./diff.md) · [Filesystem access](../platform/filesystem-access.md)
