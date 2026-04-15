import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCanvas } from '@/hooks/useCanvas';
import { useWiringEngine } from '@/hooks/useWiringEngine';
import { saveWorkspace } from '@/utils/ipc';
import { screenToCanvas } from '@/utils/layout';
import { colors, fonts, alpha } from '@/design/tokens';
import { CanvasGrid } from './CanvasGrid';
import { Minimap } from './Minimap';
import { FocusMode } from './FocusMode';
import { WiringLayer } from '@/components/wiring/WiringLayer';
import { TileShell } from '@/components/tiles/TileShell';
// Core workflow tiles are imported eagerly so they're in the initial bundle
// and show up instantly — users open these first.
import { TerminalTile } from '@/components/tiles/TerminalTile';
import { AgentTile } from '@/components/tiles/AgentTile';
import { NoteTile } from '@/components/tiles/NoteTile';
import { TodoTile } from '@/components/tiles/TodoTile';
import { FileTreeTile } from '@/components/tiles/FileTreeTile';
import { GroupTileComponent } from '@/components/tiles/GroupTile';
import { RunnerTile as RunnerTileComponent } from '@/components/tiles/RunnerTile';
import { GitTile } from '@/components/tiles/GitTile';

// Lazy-load tile components that pull large dependencies or aren't used in
// the typical first-load flow. Each becomes its own chunk; Suspense shows a
// tiny loading fallback on first mount.
const EditorTile = lazy(() => import('@/components/tiles/EditorTile').then(m => ({ default: m.EditorTile })));
const DiffTile = lazy(() => import('@/components/tiles/DiffTile').then(m => ({ default: m.DiffTile })));
const BrowserTile = lazy(() => import('@/components/tiles/BrowserTile').then(m => ({ default: m.BrowserTile })));
const SshTile = lazy(() => import('@/components/tiles/SshTile').then(m => ({ default: m.SshTile })));
const DockerTile = lazy(() => import('@/components/tiles/DockerTile').then(m => ({ default: m.DockerTile })));
const KanbanTileComponent = lazy(() => import('@/components/tiles/KanbanTile').then(m => ({ default: m.KanbanTile })));
const UsageTile = lazy(() => import('@/components/tiles/UsageTile').then(m => ({ default: m.UsageTile })));
import { TileErrorBoundary } from '@/components/tiles/TileErrorBoundary';
import { TileDock } from './TileDock';
import { WorkspaceTabs } from './WorkspaceTabs';
import type { Tile, CanvasTransform, GroupTile, RunnerTile, SshTile as SshTileType, DockerTile as DockerTileType, KanbanTile, GitTile as GitTileType } from '@/types';

const EMPTY_TILES: Tile[] = [];
const EMPTY_STICKIES: { id: string; x: number; y: number; text: string; color: string }[] = [];
const DEFAULT_TRANSFORM: CanvasTransform = { x: 0, y: 0, scale: 1 };

function TileLoadingFallback() {
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: colors.secondary, fontFamily: fonts.body, fontSize: '0.75rem',
    }}>
      Loading...
    </div>
  );
}

function renderTileContent(tile: Tile) {
  switch (tile.type) {
    case 'terminal':
      return <TerminalTile tile={tile} />;
    case 'agent':
      return <AgentTile tile={tile} />;
    case 'note':
      return <NoteTile tile={tile} />;
    case 'todo':
      return <TodoTile tile={tile} />;
    case 'editor':
      return <EditorTile tile={tile} />;
    case 'diff':
      return <DiffTile tile={tile} />;
    case 'browser':
      return <BrowserTile tile={tile} />;
    case 'filetree':
      return <FileTreeTile tile={tile} />;
    case 'group':
      return <GroupTileComponent tile={tile as GroupTile} />;
    case 'runner':
      return <RunnerTileComponent tile={tile as RunnerTile} />;
    case 'ssh':
      return <SshTile tile={tile as SshTileType} />;
    case 'docker':
      return <DockerTile tile={tile as DockerTileType} />;
    case 'kanban':
      return <KanbanTileComponent tile={tile as KanbanTile} />;
    case 'git':
      return <GitTile tile={tile as GitTileType} />;
    case 'usage':
      return <UsageTile />;
    default:
      return null;
  }
}

export function InfiniteCanvas() {
  const { containerRef, handlers, isPanning } = useCanvas();
  useWiringEngine();
  const activeProject = useCanvasStore(s => s.activeProject);
  const tilesMap = useCanvasStore(s => s.tiles);
  const transformsMap = useCanvasStore(s => s.transforms);
  const zStack = useCanvasStore(s => s.zStack);
  const focusModeActive = useCanvasStore(s => s.focusModeActive);
  const snapGuides = useCanvasStore(s => s.snapGuides);
  const stickyNotes = useCanvasStore(s => s.stickyNotes[s.activeProject] || EMPTY_STICKIES);

  const tiles = tilesMap[activeProject] ?? EMPTY_TILES;
  const transform = transformsMap[activeProject] ?? DEFAULT_TRANSFORM;

  const [altHeld, setAltHeld] = useState(false);

  // ─── Auto-snapshot for time travel (every 5 min) ────
  useEffect(() => {
    if (!activeProject) return;
    const interval = setInterval(() => {
      try {
        const s = useCanvasStore.getState();
        const pid = s.activeProject;
        if (!pid) return;
        const data = {
          tiles: (s.tiles[pid] || []).map(t => { const { ...r } = t as unknown as Record<string, unknown>; delete r.ptyId; return r; }),
          transform: s.transforms[pid] || { x: 0, y: 0, scale: 1 },
        };
        const key = `tx-autosnapshot-${pid}-${Date.now()}`;
        localStorage.setItem(key, JSON.stringify(data));
        // Keep max 12 snapshots (1 hour of history)
        const allKeys = Object.keys(localStorage).filter(k => k.startsWith(`tx-autosnapshot-${pid}-`)).sort();
        while (allKeys.length > 12) {
          localStorage.removeItem(allKeys.shift()!);
        }
      } catch { /* storage full */ }
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [activeProject]);

  // ─── Rubber-band selection state ────────────────────
  const [selRect, setSelRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const selStart = useRef<{ screenX: number; screenY: number } | null>(null);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Alt') setAltHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt') setAltHeld(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ─── Auto-save canvas state ─────────────────────────────
  // Subscribe directly to Zustand instead of using useEffect deps so the
  // effect doesn't re-run on every state change. Previously, a 50-tile
  // drag restarted two setTimeouts ~3000 times per second (60 fps × 50
  // tiles) — not catastrophic but wasted work. With Zustand.subscribe the
  // hook mounts once and only reschedules when relevant fields change.
  useEffect(() => {
    let saveTimer: number | null = null;
    let cacheTimer: number | null = null;

    const doSave = () => {
      const s = useCanvasStore.getState();
      const pid = s.activeProject;
      if (!pid) return;
      saveWorkspace({
        projectId: pid,
        tiles: s.tiles[pid] ?? [],
        wires: s.wires[pid] ?? [],
        transform: s.transforms[pid] ?? { x: 0, y: 0, scale: 1 },
      }).catch((err) => {
        if (!window.__txSaveErrorShown) {
          window.__txSaveErrorShown = true;
          import('@/stores/toastStore').then(({ useToastStore }) => {
            useToastStore.getState().addToast(`Save failed: ${String(err).slice(0, 100)}`, 'error');
          });
        }
      });
    };

    const doCache = () => {
      const s = useCanvasStore.getState();
      const pid = s.activeProject;
      if (!pid) return;
      const cache = {
        projectId: pid,
        tiles: s.tiles[pid] ?? [],
        wires: s.wires[pid] ?? [],
        transform: s.transforms[pid] ?? { x: 0, y: 0, scale: 1 },
        zStack: s.zStack,
        ts: Date.now(),
      };
      const json = JSON.stringify(cache);
      try {
        localStorage.setItem(`tx-cache-${pid}`, json);
        localStorage.setItem('tx-active-project', pid);
      } catch (err) {
        if (err instanceof Error && (err.name === 'QuotaExceededError' || err.message.includes('quota'))) {
          const snapKeys = Object.keys(localStorage)
            .filter(k => k.startsWith('tx-autosnapshot-'))
            .sort();
          const toDelete = snapKeys.slice(0, Math.ceil(snapKeys.length / 2));
          for (const k of toDelete) localStorage.removeItem(k);
          try {
            localStorage.setItem(`tx-cache-${pid}`, json);
          } catch {
            if (!window.__txQuotaWarned) {
              window.__txQuotaWarned = true;
              import('@/stores/toastStore').then(({ useToastStore }) => {
                useToastStore.getState().addToast('Local storage full — crash recovery disabled', 'warning');
              });
            }
          }
        }
      }
    };

    const schedule = () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = window.setTimeout(doSave, 2000);
      if (cacheTimer !== null) clearTimeout(cacheTimer);
      cacheTimer = window.setTimeout(doCache, 500);
    };

    const unsub = useCanvasStore.subscribe((state, prev) => {
      const active = state.activeProject;
      if (!active) return;
      // Only the current project's data + the activeProject pointer itself
      // affect what we save. Tile focus/selection/bookmarks/etc. don't.
      if (
        state.tiles[active] === prev.tiles[active] &&
        state.wires[active] === prev.wires[active] &&
        state.transforms[active] === prev.transforms[active] &&
        state.activeProject === prev.activeProject
      ) {
        return;
      }
      schedule();
    });

    return () => {
      unsub();
      if (saveTimer !== null) clearTimeout(saveTimer);
      if (cacheTimer !== null) clearTimeout(cacheTimer);
    };
  }, []);

  // ─── Immediate save on exit / beforeunload ─────────────
  useEffect(() => {
    const handleBeforeUnload = () => {
      const s = useCanvasStore.getState();
      const pid = s.activeProject;
      if (!pid) return;
      // Sync localStorage cache immediately
      try {
        const cache = {
          projectId: pid,
          tiles: s.tiles[pid] ?? [],
          wires: s.wires[pid] ?? [],
          transform: s.transforms[pid] ?? { x: 0, y: 0, scale: 1 },
          zStack: s.zStack,
          ts: Date.now(),
        };
        localStorage.setItem(`tx-cache-${pid}`, JSON.stringify(cache));
        localStorage.setItem('tx-active-project', pid);
      } catch { /* best effort */ }
      // Also fire the IPC save (may or may not complete before exit)
      saveWorkspace({
        projectId: pid,
        tiles: s.tiles[pid] ?? [],
        wires: s.wires[pid] ?? [],
        transform: s.transforms[pid] ?? { x: 0, y: 0, scale: 1 },
      }).catch(() => {});
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Collect hidden tile IDs from collapsed groups
  const hiddenTileIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const t of tiles) {
      if (t.type === 'group' && (t as GroupTile).collapsed) {
        for (const childId of (t as GroupTile).childTileIds) {
          hidden.add(childId);
        }
      }
    }
    return hidden;
  }, [tiles]);

  const visibleTiles = useMemo(
    () => tiles.filter(t => !hiddenTileIds.has(t.id)),
    [tiles, hiddenTileIds],
  );

  // Click on empty canvas to deselect (skip if we just finished rubber-band)
  const justFinishedRubberBand = useRef(false);
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (justFinishedRubberBand.current) {
      justFinishedRubberBand.current = false;
      return;
    }
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasLayer === 'transform') {
      useCanvasStore.getState().setFocusedTile(null);
      useCanvasStore.getState().clearSelection();
    }
  }, []);

  // ─── Rubber-band pointer handlers ─────────────────────
  const handleRubberBandDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    const onTile = target.closest?.('[data-tile-shell]');
    const onOverlay = target.closest?.('[data-canvas-overlay]');
    if (e.button === 0 && e.shiftKey && !onTile && !onOverlay) {
      selStart.current = { screenX: e.clientX, screenY: e.clientY };
    }
  }, []);

  const handleRubberBandMove = useCallback((e: React.PointerEvent) => {
    if (!selStart.current) return;
    const state = useCanvasStore.getState();
    const t = state.transforms[state.activeProject] || { x: 0, y: 0, scale: 1 };
    const start = screenToCanvas(selStart.current.screenX, selStart.current.screenY, t);
    const end = screenToCanvas(e.clientX, e.clientY, t);
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    setSelRect({ x, y, w, h });
  }, []);

  const handleRubberBandUp = useCallback(() => {
    if (selStart.current && selRect) {
      useCanvasStore.getState().selectTilesInRect(selRect);
      justFinishedRubberBand.current = true;
    }
    selStart.current = null;
    setSelRect(null);
  }, [selRect]);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    handlers.onPointerMove(e);
    handleRubberBandMove(e);
  }, [handlers, handleRubberBandMove]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        flex: 1,
        overflow: 'hidden',
        background: colors.bg,
        cursor: isPanning.current ? 'grabbing' : altHeld ? 'grab' : 'default',
      }}
      role="application"
      aria-label="Infinite canvas workspace"
      aria-roledescription="canvas"
      onPointerDown={(e) => { handlers.onPointerDown(e); handleRubberBandDown(e); }}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={(e) => { handlers.onPointerUp(e); handleRubberBandUp(); }}
      onPointerLeave={undefined}
      onClick={handleCanvasClick}
    >
      <CanvasGrid transform={transform} />

      {/* Transform layer — tiles live in canvas coordinate space */}
      <div
        data-canvas-layer="transform"
        style={{
          position: 'absolute',
          inset: 0,
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: '0 0',
        }}
      >
        {visibleTiles.length === 0 && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            }}>
              <span style={{
                color: colors.onSurfaceVariant,
                fontFamily: fonts.title,
                fontSize: '1.125rem',
                fontWeight: 700,
              }}>
                TerminalX
              </span>
              <span style={{
                color: colors.secondary,
                fontFamily: fonts.body,
                fontSize: '0.8125rem',
              }}>
                Click Layout above or + below to get started
              </span>
            </div>
          </div>
        )}

        {visibleTiles.map(tile => (
          <TileShell key={tile.id} tile={tile} zIndex={zStack.indexOf(tile.id)}>
            <TileErrorBoundary tileId={tile.id} tileType={tile.type}>
              <Suspense fallback={<TileLoadingFallback />}>
                {renderTileContent(tile)}
              </Suspense>
            </TileErrorBoundary>
          </TileShell>
        ))}

        <WiringLayer />

        {/* Sticky notes */}
        {stickyNotes.map(note => (
          <div key={note.id} style={{
            position: 'absolute',
            left: note.x, top: note.y,
            width: 180, minHeight: 60,
            background: note.color + '22',
            border: `1px solid ${note.color}44`,
            borderRadius: 6,
            padding: 8,
            zIndex: 9990,
            fontSize: '0.6875rem',
            fontFamily: fonts.body,
            color: colors.onSurface,
          }}>
            <div
              contentEditable
              suppressContentEditableWarning
              onBlur={e => useCanvasStore.getState().updateStickyNote(note.id, e.currentTarget.textContent || '')}
              style={{ outline: 'none', minHeight: 30, lineHeight: 1.4 }}
            >
              {note.text}
            </div>
            <button
              onClick={() => useCanvasStore.getState().removeStickyNote(note.id)}
              style={{
                position: 'absolute', top: 2, right: 4,
                background: 'none', border: 'none',
                color: note.color, cursor: 'pointer',
                fontSize: 9, opacity: 0.6,
              }}
            >
              ✕
            </button>
          </div>
        ))}

        {/* Snap alignment guides */}
        {snapGuides.map((g, i) => (
          <div key={`${g.axis}-${g.pos}-${i}`} style={{
            position: 'absolute',
            ...(g.axis === 'x'
              ? { left: g.pos, top: -9999, width: 1, height: 99999, borderLeft: `1px dashed ${colors.primary}` }
              : { top: g.pos, left: -9999, height: 1, width: 99999, borderTop: `1px dashed ${colors.primary}` }
            ),
            opacity: 0.5,
            pointerEvents: 'none',
            zIndex: 9998,
          }} />
        ))}

        {/* Rubber-band selection rectangle */}
        {selRect && (
          <div style={{
            position: 'absolute',
            left: selRect.x,
            top: selRect.y,
            width: selRect.w,
            height: selRect.h,
            border: `1.5px dashed ${colors.primary}`,
            background: alpha(colors.primary, 8),
            borderRadius: 4,
            pointerEvents: 'none',
            zIndex: 9999,
          }} />
        )}
      </div>

      {/* Screen reader live region for tile announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
      >
        {visibleTiles.length} tiles on canvas
      </div>

      {focusModeActive && <FocusMode />}
      <WorkspaceTabs />
      <Minimap />
      <TileDock />
    </div>
  );
}
