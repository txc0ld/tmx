# Snapshots

> Named point-in-time backups of your workspace.

## What it is

A snapshot captures `{ tiles, wires, transform, zStack, name, createdAt }` and writes it as a standalone file. Two kinds:

- **Manual** — you name it. Lives until you delete.
- **Auto** — named `auto-${iso-timestamp}`, written every 5 minutes automatically.

## How to use

- Command Palette → "Save Snapshot" → enter a name.
- Command Palette → "Load Snapshot" → pick from list → confirm.
- Delete via the list picker's ✕ button (manual snapshots only; auto snapshots roll over).
- Auto-snapshots are hidden from the default list unless you check "Show auto-snapshots".

## Power moves

- **Before a risky agent.** Snapshot named "before-refactor" → run the agent → if it goes wrong, one click restore.
- **Demo setup.** Prepare a canvas for a presentation, snapshot it as "demo-morning", load it when ready.
- **Share via import.** Export a snapshot file and hand it to a teammate (see [import / export](./import-export.md)).
- **Time travel.** Auto-snapshots give you ~1 hour of history (12 × 5 min). Restore any of them from the Command Palette. See [time travel](./time-travel.md).

## Tech notes

- Stored under `~/.config/terminalx/workspaces/snapshots/${projectId}/${name}.json`.
- `sanitize_name` in `workspace.rs` rejects `..`, `/`, `\`, `:`, null bytes — safe names only. `/` in a snapshot name would allow writing outside the directory.
- Snapshot list capped at 10 000 entries per project (filesystem-level listing limit).
- Auto-snapshots go through the same path but are prefixed `auto-` so the UI can filter them out of the default picker.
- JSON format identical to the workspace file — a snapshot file can be loaded, copied, or emailed as-is.

**Key files:** `src-tauri/src/commands/workspace.rs` (save_snapshot, load_snapshot, list_snapshots).

## Related

- [Workspace persistence](./workspace.md) · [Time travel](./time-travel.md) · [Import / export](./import-export.md) · [Layout slots](../canvas/layouts.md)
