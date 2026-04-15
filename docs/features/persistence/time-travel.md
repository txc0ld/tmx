# Time Travel

> Restore any snapshot — auto or manual — as a point-in-time undo.

## What it is

The feature name for using [snapshots](./snapshots.md) as a coarse-grained undo. Auto-snapshots fire every 5 minutes, so you always have ~12 recent canvas states to restore from.

## How to use

- Command Palette → "Time Travel" (alias for "Load Snapshot" with auto-snapshots shown by default).
- Pick a snapshot from the list — auto-snapshots appear as `auto-${timestamp}`, manual ones by their name.
- Confirm — the current canvas is replaced.

## Power moves

- **Oh-no recovery.** Deleted too many tiles? Clear-canvas'd by accident? Load the most recent auto-snapshot.
- **Exploration branches.** Treat each auto-snapshot as a checkpoint — experiment freely, revert at any 5-min boundary.
- **Pin a known-good.** Before anything risky, save a manual snapshot named `stable-${date}` — your auto-snapshots roll over, manual ones don't.

## Why no fine-grained undo?

A full undo/redo stack would need to record every tile edit, wire creation, drag, resize, etc. That's a lot of state to track reliably. The 5-min coarse-grained model ships real reliability today; a future redo stack is an additive feature.

## Tech notes

- Auto-snapshots triggered by an interval timer in `App.tsx` on a 5-minute cadence. Each saves `auto-${Date.now()}.json` alongside named snapshots.
- No retention policy: auto-snapshots accumulate until the disk fills. Manual cleanup via the list picker.
- Restore is wholesale — `canvasStore.loadSnapshot(snapshot)` replaces `tiles`, `wires`, `transform` in one set call.

**Key files:** `src/App.tsx` (auto-snapshot interval), `src/stores/canvasStore.ts` (loadSnapshot).

## Related

- [Snapshots](./snapshots.md) · [Workspace persistence](./workspace.md) · [Layout slots](../canvas/layouts.md)
