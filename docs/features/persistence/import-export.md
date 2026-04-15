# Import / Export Workspace

> Share or back up a workspace as a JSON file.

## What it is

Save your current workspace to a standalone JSON file, or load one from disk. The file format is the same as internal snapshots — portable between machines.

## How to use

- Command Palette → **Export Workspace** → system file dialog → pick a destination.
- Command Palette → **Import Workspace** → system file dialog → pick a JSON file.
- On import, the file is validated (see below); if it passes, it replaces the current workspace.

## Power moves

- **Share a layout.** Export a "starter kit" workspace for your team (Claude + Codex + Git + Editor wired together). New teammates import to get going fast.
- **Cross-machine.** Move work between laptops. Desktop exports, MacBook imports.
- **Backup outside the app.** The JSON is self-contained — commit it to git, stash in Dropbox, whatever.
- **Public templates.** Post a workspace JSON on GitHub as a reference config — anyone can import.

## Tech notes

- Import goes through the `validateWorkspaceImport` validator in `src/utils/workspaceImport.ts`. The validator checks:
  - Version matches (`version: 1`).
  - `MAX_TILES = 5000`, `MAX_WIRES = 10000`.
  - Per-string cap `65 536` (short fields) or `2 MB` (note content / diff paste).
  - Per-tile-type discriminated-union validation: unknown types rejected, fields checked against the known schema.
  - Coord clamp: `x / y` to `[-1 000 000, 1 000 000]`, `w / h` to `[40, 10 000]`.
  - Dangerous browser URL schemes (`javascript:`, `file:`, `data:`) rejected.
  - Duplicate tile IDs rejected.
  - Dangling wire endpoints rejected.
- Failures throw `WorkspaceImportError` with a clear message; the UI shows a toast.
- 92 tests in `src/test/workspaceImport.test.ts` cover the validator boundary cases.

**Key files:** `src/utils/workspaceImport.ts`, `src/test/workspaceImport.test.ts`, `src/components/palette/CommandPalette.tsx` (Export/Import actions).

## Related

- [Workspace persistence](./workspace.md) · [Snapshots](./snapshots.md) · [Time travel](./time-travel.md)
