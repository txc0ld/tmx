# Workspace Persistence

> 3-layer auto-save: localStorage cache + disk file + beforeunload flush.

## What it is

Everything on the canvas — tiles, wires, transforms, z-stack — persists automatically. No Save button. The app survives crashes, refreshes, and panics by writing state through three channels with different latencies.

## How it saves

| Channel | Latency | Purpose |
|---|---|---|
| **localStorage cache** | 500 ms debounce | Instant crash recovery — available before disk IO finishes |
| **Disk file** | 2 s debounce | Durable source of truth, atomic temp-file + rename |
| **beforeunload** | immediate (sync) | Final flush on app exit |

All three write the same payload: `{ projectId, tiles, wires, transform, zStack }`.

## How it loads

1. App starts → read `localStorage['tx-cache-${pid}']` synchronously — show tiles instantly.
2. Async: `loadWorkspace(pid)` IPC → Rust reads the disk file.
3. Disk content wins over localStorage cache (reconciles if disk is newer).

## Power moves

- **QuotaExceeded-safe.** If localStorage hits quota, the GC deletes the oldest half of `tx-autosnapshot-*` keys and retries. Persistent crash recovery preserved.
- **Runtime-only fields.** `ptyId` isn't persisted — every app restart gives fresh PTYs. Prevents dead-PTY references.
- **Explicit snapshots.** For a named restore point rather than the auto flow, see [snapshots](./snapshots.md).
- **One project active.** Only the active project's state auto-saves. Switching projects triggers a full state swap (previous project stays on disk).

## Tech notes

- Auto-save hook uses `useCanvasStore.subscribe` (not `useEffect` deps) so it installs once and only reschedules when `tiles[pid]` / `wires[pid]` / `transforms[pid]` / `activeProject` change by reference.
- Disk path: `~/.config/terminalx/workspaces/${projectId}.json` (Linux/macOS) or `%APPDATA%\terminalx\workspaces\${projectId}.json` (Windows).
- Atomic writes: Rust `atomic_write` writes to `*.tmp` then renames. Windows fallback: if rename fails and target exists, remove then rename.
- JSON size cap: 10 MB per workspace file. Workspace import validator (on load) caps tile count at 5000 and wire count at 10 000.

**Key files:** `src/components/canvas/InfiniteCanvas.tsx` (auto-save subscribe), `src-tauri/src/commands/workspace.rs`, `src/utils/workspaceImport.ts`.

## Related

- [Snapshots](./snapshots.md) · [Import / export](./import-export.md) · [Time travel](./time-travel.md)
