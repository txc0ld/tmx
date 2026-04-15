# Editor Tile

> Monaco editor inside a tile, with tiered loading for large files.

## What it is

A full Monaco editor (the same one in VS Code) tuned for canvas use. Auto-detects language from file extension, auto-saves, and scales heavy features down when a file is large enough to freeze the UI.

## How to use

- Open by clicking a file in a wired [File Tree](./filetree.md), via the Command Palette, or by setting `filePath` on the tile.
- Edits auto-save after 1 s of idle typing.
- Three load tiers triggered by file size:
  - **< 512 KB** — full Monaco (syntax, bracket pair colorization, validation).
  - **512 KB – 5 MB** — silent "optimized" mode: drops bracket colorization, occurrence highlights, validation decorations. Folding + syntax stay.
  - **> 5 MB** — prompts before load; if accepted, opens in plain-text mode (folding + guides off).

## Use cases

**Code editing.** Pair with a Terminal running `npm run dev` and a Browser tile pointing at localhost for the classic triad.

**Drop-in review.** Click a path in File Tree → it auto-loads here via [file-open](../wiring/file-open.md). Browse without spawning a new editor per file.

**Log inspection.** Point at a big log file and get plain-text mode automatically — viewable without freezing the app.

## Tech notes

- Reads and writes go through `readFileText` / `writeFileText` in `utils/ipc.ts` (Rust side), **not** the `tauri-plugin-fs` plugin. The plugin's default scope is too narrow (fails on `~/.claude/projects/...`). Rust IPC uses the broader `is_path_allowed` validator.
- `getFileSize` is called *before* reading so we fail cheap on oversized files rather than pulling 50 MB into memory then deciding to cancel.
- Autosave captures `filePathRef` at edit time and re-verifies it on the debounce tick — switching files mid-debounce previously wrote content A to file B (fixed in the audit pass).
- Monaco's main text is DOM (not canvas), so it re-rasterizes cleanly under CSS transforms. Minimap is disabled.

**Key files:** `src/components/tiles/EditorTile.tsx`, `src-tauri/src/commands/filesystem.rs` (read_file_text, write_file_text, get_file_size).

## Related

- [Diff tile](./diff.md) · [File Tree tile](./filetree.md) · [file-open wire](../wiring/file-open.md) · [Filesystem access](../platform/filesystem-access.md)
