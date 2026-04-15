# Diff Tile

> Side-by-side code comparison with three modes.

## What it is

Three modes in one tile, switched via tabs:

- **Git** — lists `git status --porcelain` files in a sidebar; clicking a file shows its diff vs `HEAD`.
- **Compare** — two native file-pickers for arbitrary files.
- **Paste** — two textareas, pipe in any snippets.

All three render through Monaco's DiffEditor.

## How to use

- Add a Diff tile from the dock. Mode defaults to `git` with `repoPath` = project cwd.
- **Git mode:** Pick a file from the sidebar — shows working tree vs `HEAD`. Status icons: `M` (modified, yellow), `A` (added, green), `D` (deleted, red), `??` (untracked, grey).
- **Compare mode:** Use the file pickers. File paths shown in the header.
- **Paste mode:** Paste into the two textareas, click "Compare →".
- Wire a File Tree in to auto-seed the most contextual slot (git → `gitTarget`, compare → empty side, paste → switches to compare).

## Use cases

**Review before commit.** Git mode shows exactly what `git diff` would, clicking through each dirty file.

**Ad-hoc compare.** Agent spits out a refactored version of a function; paste original + new into Paste mode to see the diff without touching disk.

**Two-file sanity check.** Pick two sibling files across branches or repos in Compare mode.

## Tech notes

- Mode + per-mode state (`gitTarget`, `compareLeft/Right`, `pasteOriginal/Modified`) all live on the tile — restored verbatim from saved workspaces. `mode` is optional, defaults to `'git'` for back-compat with pre-v1.1 workspaces.
- Git side uses `git_show_head_file` (returns empty string rather than error for files not in HEAD — handles added-but-uncommitted cases cleanly).
- Same large-file tiered loading as the [Editor tile](./editor.md) — oversized files prompt before Monaco tries to tokenize them.
- Monaco DiffEditor respects `renderSideBySide` and reuses the same theme as EditorTile.

**Key files:** `src/components/tiles/DiffTile.tsx`, `src-tauri/src/commands/git.rs` (git_show_head_file, git_files_status).

## Related

- [Editor tile](./editor.md) · [Git tile](./git.md) · [File Tree tile](./filetree.md) · [file-open wire](../wiring/file-open.md) · [diff-feed wire](../wiring/diff-feed.md)
