# Wire: file-open

> File Tree → Editor/Diff. Click routing, not data flow.

## What it does

Unlike other wires, file-open is **click-routed**, not data-driven. When you click a file in a File Tree tile, the click handler finds outgoing `file-open` wires and routes the file path to each target with smart per-type logic.

## How to wire

- Drag from a File Tree's right-edge port to an Editor or Diff tile's left-edge port.
- Click any file in the tree.
- The path loads into the wired target — **without** spawning a new Editor tile.

## Routing logic per target

| Target type | Behavior |
|---|---|
| **Editor** | Sets `filePath` + `title` on the target. Brings to front. |
| **Diff — git mode** | Sets `gitTarget` if the file is under `repoPath`; otherwise ignored. |
| **Diff — compare mode** | Fills the empty side (`compareLeft` or `compareRight`). If both full, replaces `compareRight`. |
| **Diff — paste mode** | Switches to compare mode and seeds `compareRight`. |

## Power moves

- **File tree + two editors.** Wire the tree to two editors. Clicks populate whichever makes sense per the visual wire ordering. Perfect for side-by-side review.
- **Tree + git-mode diff.** Browse your repo; clicking a file jumps to its diff vs HEAD automatically.
- **Tree + three-panel review.** Tree → Editor (open file), Tree → Diff (git changes). Click once, both tiles update.
- **Multiple trees.** Pin one File Tree per repo. Each tree wires to its own Editor; the canvas becomes a multi-repo dashboard.

## Tech notes

- Routing lives in `FileTreeTile.tsx → handleSelectFile`. It reads outgoing wires from `canvasStore.wires[pid]`, filters for `wireType === 'file-open'`, and invokes type-specific updates via `canvasStore.updateTile`.
- Wire pulses for 1.5 s after firing via `canvasStore.setWireActive`.
- Fallback: if no file-open wires exist, the handler spawns a new Editor tile next to the tree. Never silently drops a click.

**Key files:** `src/components/tiles/FileTreeTile.tsx`, `src/stores/wiringStore.ts` (inferWireType).

## Related

- [File Tree tile](../tiles/filetree.md) · [Editor tile](../tiles/editor.md) · [Diff tile](../tiles/diff.md)
