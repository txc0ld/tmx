# Bundle Chunking

> How the Vite build splits for fast first paint.

## What it is

The frontend bundle is split into named vendor chunks plus per-tile lazy chunks. The main bundle is **~413 KB gzipped ~120 KB** — under Vite's 600 KB soft warning.

## Chunk map

| Chunk | Size (minified) | Size (gzip) | Contents |
|---|---:|---:|---|
| `index-*.js` | ~413 KB | ~120 KB | Core app, canvas, stores, tile wiring |
| `xterm-*.js` | ~391 KB | ~98 KB | xterm.js + fit + webgl addons |
| `motion-*.js` | ~131 KB | ~43 KB | framer-motion |
| `fuse-*.js` | ~24 KB | ~9 KB | Fuse.js (command palette) |
| `react-*.js` | ~4 KB | ~1.5 KB | react + react-dom |
| `DiffTile-*.js` | ~12 KB | ~4 KB | Lazy — loaded when a Diff tile mounts |
| `EditorTile-*.js` | ~3 KB | ~1 KB | Lazy — Monaco is a separate chunk via `@monaco-editor/react` |
| `BrowserTile-*.js` | ~3 KB | ~1 KB | Lazy |
| `SshTile-*.js` | ~3 KB | ~1 KB | Lazy |
| `DockerTile-*.js` | ~3 KB | ~1 KB | Lazy |
| `KanbanTile-*.js` | ~6 KB | ~1.6 KB | Lazy |
| `UsageTile-*.js` | ~6 KB | ~2 KB | Lazy |

## Power moves

- **First paint < 400 ms.** On a warm cache, the app renders the canvas before any tile-specific chunks have to load.
- **No Monaco on startup.** Monaco's ~2 MB of assets don't load until you open an Editor or Diff tile.
- **No xterm for users who only use Notes.** If you never spawn a terminal, the xterm chunk is never fetched (well — core tiles like Terminal pull it, but non-terminal tiles like Note/Todo/Kanban are standalone).

## Tech notes

- `vite.config.ts` declares `manualChunks`:
  ```ts
  {
    xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl'],
    motion: ['framer-motion'],
    fuse: ['fuse.js'],
    react: ['react', 'react-dom'],
  }
  ```
- Per-tile lazy loading via `lazy(() => import('./TileX'))` in `InfiniteCanvas.tsx`. Core workflow tiles (Terminal, Agent, Note, Todo, FileTree, Group, Runner, Git) stay eager for instant spawn.
- Tauri's WebView2/WebKit loads from `dist/` — no network request latency (files bundled with the app).
- `chunkSizeWarningLimit: 600` in build config — keeps us honest.

**Key files:** `vite.config.ts`, `src/components/canvas/InfiniteCanvas.tsx` (lazy imports).

## Related

- [Infinite canvas](../canvas/infinite-canvas.md)
