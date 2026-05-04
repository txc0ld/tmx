import { useEffect, useState, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { colors } from '@/design/tokens';
import { screenToCanvas } from '@/utils/layout';
import { loadWorkspace } from '@/utils/ipc';
import { InfiniteCanvas } from '@/components/canvas/InfiniteCanvas';
import { ProjectSidebar } from '@/components/sidebar/ProjectSidebar';
import { TopBar } from '@/components/topbar/TopBar';
import { StatusRail } from '@/components/status/StatusRail';
import { ToastContainer } from '@/components/status/ToastContainer';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { SearchOverlay } from '@/components/canvas/SearchOverlay';
import { SessionTimeline } from '@/components/timeline/SessionTimeline';
import type { TileType, Tile } from '@/types';
import type { TileTemplate } from '@/stores/templateStore';
import '@/stores/clipboardStore'; // Initialize clipboard listener
import { initMcpProjectSync, migrateMcpSecretsToKeychain } from '@/stores/mcpStore';
import { initUsageTracking } from '@/stores/usageStore';

export const TILE_DEFAULTS: Record<TileType, { w: number; h: number }> = {
  terminal: { w: 600, h: 400 },
  agent: { w: 600, h: 450 },
  browser: { w: 600, h: 500 },
  editor: { w: 500, h: 400 },
  diff: { w: 500, h: 400 },
  todo: { w: 320, h: 400 },
  note: { w: 320, h: 300 },
  'pipeline-controller': { w: 600, h: 240 },
  kanban: { w: 700, h: 500 },
  filetree: { w: 280, h: 500 },
  group: { w: 400, h: 300 },
  runner: { w: 600, h: 400 },
  ssh: { w: 500, h: 400 },
  docker: { w: 500, h: 450 },
  git: { w: 350, h: 500 },
  usage: { w: 320, h: 480 },
};

function buildTileDefaults(type: TileType): Record<string, unknown> {
  switch (type) {
    case 'terminal': return { cwd: '~', branch: '', node: '', splits: [] };
    case 'agent': return { agent: 'claude', model: 'opus-4', effort: 'high', mode: 'code', version: '', cwd: '~', branch: '', status: 'idle', elapsed: 0 };
    case 'browser': return { url: 'http://localhost:3000' };
    case 'editor': return { filePath: '', language: 'typescript' };
    case 'diff': return { filePath: '', hunks: [], comments: [] };
    case 'todo': return { items: [] };
    case 'note': return { content: '' };
    case 'kanban': return { columns: [] };
    case 'filetree': return { rootPath: '~', expandedPaths: [] };
    case 'group': return { label: 'Group', childTileIds: [], collapsed: false };
    case 'runner': return { command: '', cwd: '~', status: 'idle', lastOutput: '' };
    case 'ssh': return { host: '', port: 22, user: '', connected: false };
    case 'docker': return { containers: [] };
    case 'git': return { repoPath: '~' };
    case 'usage': return {};
    default: return {};
  }
}

function spawnTileAtCenter(type: TileType, overrides: Record<string, unknown> = {}): void {
  const state = useCanvasStore.getState();
  const pid = state.activeProject;
  const transform = state.transforms[pid] || { x: 0, y: 0, scale: 1 };
  const defaults = TILE_DEFAULTS[type];
  const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2, transform);
  // Use project directory for cwd-based tiles
  const project = useProjectStore.getState().projects.find(p => p.id === pid);
  const projectCwd = project?.cwd || '~';
  const cwdOverrides: Record<string, unknown> = {};
  if (['terminal', 'agent', 'runner'].includes(type)) cwdOverrides.cwd = projectCwd;
  if (type === 'filetree') cwdOverrides.rootPath = projectCwd;
  if (type === 'git') cwdOverrides.repoPath = projectCwd;

  const tile = {
    id: crypto.randomUUID(),
    type,
    x: center.x - defaults.w / 2,
    y: center.y - defaults.h / 2,
    w: defaults.w,
    h: defaults.h,
    ...buildTileDefaults(type),
    ...cwdOverrides,
    ...overrides,
  } as Tile;

  state.addTile(tile);
}

export default function App() {
  const projects = useProjectStore(s => s.projects);
  const activeProject = useProjectStore(s => s.active);
  const setActiveProject = useProjectStore(s => s.setActive);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Install per-app subscriptions at mount (not module import). Avoids
  // leaking a duplicate subscription if the module is re-loaded under HMR
  // or the app re-renders at the root.
  useEffect(() => initMcpProjectSync(), []);
  useEffect(() => initUsageTracking(), []);

  // One-shot migration on app start: move any MCP secrets still living
  // in localStorage into the OS keychain, strip them from the JSON
  // config. Idempotent — no-ops after the first run.
  useEffect(() => {
    migrateMcpSecretsToKeychain().then(({ moved }) => {
      if (moved > 0) {
        import('@/stores/toastStore').then(({ useToastStore }) => {
          useToastStore.getState().addToast(
            `Moved ${moved} MCP token${moved === 1 ? '' : 's'} from localStorage to the OS keychain.`,
            'info',
          );
        });
      }
    }).catch(() => { /* keychain unavailable — user sees errors on sync */ });
  }, []);

  // Load persisted projects then init canvas + restore workspace
  useEffect(() => {
    useProjectStore.getState().loadFromDisk().then(async () => {
      const canvasActive = useCanvasStore.getState().activeProject;
      let storeActive = useProjectStore.getState().active;

      // Restore last active project from localStorage (survives crashes)
      if (!storeActive) {
        const cached = localStorage.getItem('tx-active-project');
        if (cached) {
          const projects = useProjectStore.getState().projects;
          if (projects.some(p => p.id === cached)) {
            useProjectStore.getState().setActive(cached);
            storeActive = cached;
          }
        }
      }

      if (!canvasActive && storeActive) {
        useCanvasStore.getState().switchProject(storeActive);
      }

      // Restore workspace — try IPC (disk) first, fall back to localStorage cache
      const pid = useCanvasStore.getState().activeProject;
      if (pid) {
        let restored = false;
        try {
          const saved = await loadWorkspace(pid);
          if (saved && saved.tiles && saved.tiles.length > 0) {
            const cs = useCanvasStore.getState();
            cs.loadSnapshot({
              name: '__restore__',
              tiles: saved.tiles,
              wires: saved.wires ?? [],
              transform: saved.transform ?? { x: 0, y: 0, scale: 1 },
              createdAt: '',
            });
            restored = true;
          }
        } catch {
          // Disk load failed
        }

        // Fallback: restore from localStorage crash cache
        if (!restored) {
          try {
            const raw = localStorage.getItem(`tx-cache-${pid}`);
            if (raw) {
              const cache = JSON.parse(raw);
              if (cache.tiles && cache.tiles.length > 0) {
                const cs = useCanvasStore.getState();
                cs.loadSnapshot({
                  name: '__cache_restore__',
                  tiles: cache.tiles,
                  wires: cache.wires ?? [],
                  transform: cache.transform ?? { x: 0, y: 0, scale: 1 },
                  zStack: cache.zStack,
                  createdAt: '',
                });
              }
            }
          } catch {
            // Cache corrupted — start fresh
          }
        }
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept ANY keystrokes when xterm's hidden textarea (or any
      // input/textarea) has focus — those keystrokes belong to the terminal.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        // Still allow our global Ctrl/Meta shortcuts and Escape through
        if (!e.ctrlKey && !e.metaKey && e.key !== 'Escape') return;
      }

      // Don't intercept plain keystrokes when focus is inside tile content (terminals, editors, inputs)
      const target = e.target as HTMLElement;
      const inTile = target.closest?.('[data-tile-content]');
      if (inTile && !e.ctrlKey && !e.metaKey && e.key !== 'Escape') return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(p => !p);
      }
      // Ctrl+F — global search across tiles
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !inTile) {
        e.preventDefault();
        setSearchOpen(p => !p);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const store = useCanvasStore.getState();
        if (store.focusModeActive) store.exitFocusMode();
        else if (store.focusedTile) store.enterFocusMode([store.focusedTile]);
      }
      // Ctrl+Tab / Ctrl+Shift+Tab — cycle through tiles
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault();
        const store = useCanvasStore.getState();
        const stack = store.zStack;
        if (stack.length === 0) return;
        const currentIdx = store.focusedTile ? stack.indexOf(store.focusedTile) : -1;
        const dir = e.shiftKey ? -1 : 1;
        const nextIdx = (currentIdx + dir + stack.length) % stack.length;
        const nextId = stack[nextIdx];
        store.bringToFront(nextId);
        store.setFocusedTile(nextId);
      }
      // Ctrl+W — close selected tiles or focused tile
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        const store = useCanvasStore.getState();
        if (store.selectedTiles.length > 0) {
          store.removeSelectedTiles();
        } else if (store.focusedTile) {
          store.removeTile(store.focusedTile);
        }
      }
      // Ctrl+G — group selected tiles
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        const store = useCanvasStore.getState();
        if (store.selectedTiles.length >= 2) {
          const label = prompt('Group name:') || 'Group';
          store.groupTiles(store.selectedTiles, label);
        }
      }
      // Ctrl+Shift+B — save bookmark
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault();
        const name = prompt('Bookmark name:');
        if (name) {
          useCanvasStore.getState().addBookmark(name);
        }
      }
      // Ctrl+1 through Ctrl+9 — jump to bookmark
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key, 10) - 1;
        useCanvasStore.getState().jumpToBookmark(index);
      }
      // Ctrl+J — toggle timeline
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        useTimelineStore.getState().toggle();
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setSearchOpen(false);
        useCanvasStore.getState().exitFocusMode();
        useCanvasStore.getState().clearSelection();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleAddTile = useCallback((type: TileType) => {
    spawnTileAtCenter(type);
  }, []);

  const handleAddFromTemplate = useCallback((template: TileTemplate) => {
    spawnTileAtCenter(template.category, template.config);
  }, []);

  const project = projects.find(p => p.id === activeProject);

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      background: colors.bg,
      fontFamily: "'Public Sans', sans-serif",
      color: colors.onSurfaceVariant,
      overflow: 'hidden',
    }}>
      <ProjectSidebar projects={projects} active={activeProject} onSelect={setActiveProject} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar
          project={project}
          onAddTile={handleAddTile}
          onAddFromTemplate={handleAddFromTemplate}
          onOpenPalette={() => setPaletteOpen(true)}
        />
        <InfiniteCanvas />
        <SessionTimeline onClose={() => useTimelineStore.getState().setOpen(false)} />
        <StatusRail />
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onAddTile={handleAddTile}
          onAddFromTemplate={handleAddFromTemplate}
        />
      )}

      {searchOpen && (
        <SearchOverlay onClose={() => setSearchOpen(false)} />
      )}

      <ToastContainer />
    </div>
  );
}
