# Layout Slots

> Five saved layouts per project.

## What it is

A dropdown in the top bar listing one built-in **Default** layout plus 5 user save slots. Each slot captures the full tile/wire/transform set for the active workspace.

## How to use

- Top bar → **Layout** button. Dropdown shows Default + 5 numbered slots.
- Click an **empty slot** to save the current layout into it (enter a name).
- Click a **filled slot** to load that layout — current state is replaced.
- ↻ on a filled slot overwrites it with the current state.
- ✕ on a filled slot deletes it (with confirm).
- Click **Default** to reset to the empty workspace.
- Click **Clear Canvas** (next to Layout) to wipe the current workspace after a confirmation (shows tile count).

## Power moves

- **Per-project presets.** Layouts are scoped per project (`localStorage['tx-layouts-${projectId}']`). Slot 1 can be "morning standup", slot 2 "debugging", slot 3 "deploy review".
- **Layout trading.** Export a layout as a [snapshot](../persistence/snapshots.md) to share with a teammate — they import it into one of their slots.
- **Safety save.** Before a big change, save into an empty slot as a quick restore point.
- **Layout + workspace tabs.** Combine — a workspace tab gives you separation within a project, layouts give you quick restores.

## Tech notes

- Stored at `localStorage['tx-layouts-${pid}']` as `(LayoutSlot | null)[5]`. `LayoutSlot` contains `{ name, tiles, wires, transform, zStack, createdAt }`.
- Legacy single-slot key `tx-saved-layout-${pid}` auto-migrates into slot 1 and is removed on first open.
- Load calls `canvasStore.loadSnapshot(layout)` — wholesale replacement, not merge.
- **Clear Canvas** calls `removeTile` for each tile individually so Zustand's per-tile cleanup (PTY kill, wireData scrub) runs properly.

**Key files:** `src/components/topbar/TopBar.tsx` (LayoutMenuButton, ClearCanvasButton), `src/stores/canvasStore.ts`.

## Related

- [Snapshots](../persistence/snapshots.md) · [Workspace persistence](../persistence/workspace.md) · [Workspace tabs](./workspace-tabs.md)
