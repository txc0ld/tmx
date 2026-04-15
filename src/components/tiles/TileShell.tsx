import { useRef, useCallback, useState, memo, type ReactNode } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { colors, glass, glassActive, radius, spacing, typography, tileColors, motion, fonts, alpha } from '@/design/tokens';
import { snapToGrid, snapToTiles } from '@/utils/layout';
import { ptyKill } from '@/utils/ipc';
import { detachTile } from '@/utils/detachTile';
import { useTemplateStore } from '@/stores/templateStore';
import { useWiringStore } from '@/stores/wiringStore';
import type { Tile, TileType } from '@/types';

interface TileShellProps {
  tile: Tile;
  zIndex: number;
  children: ReactNode;
}

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_W = 200;
const MIN_H = 150;

const EDGE_SIZE = 6;
const CORNER_SIZE = 12;

const RESIZE_CURSORS: Record<ResizeEdge, string> = {
  n: 'n-resize', s: 's-resize', e: 'e-resize', w: 'w-resize',
  ne: 'ne-resize', nw: 'nw-resize', se: 'se-resize', sw: 'sw-resize',
};

export const TileShell = memo(function TileShell({ tile, zIndex, children }: TileShellProps) {
  // Each subscription returns a primitive so Zustand's default Object.is
  // equality check short-circuits re-renders unless THIS tile's state
  // actually flipped. Subscribing to `s.wires` (a Record) would re-render
  // this shell on every wire added/removed to any tile in any project.
  const isFocused = useCanvasStore(s => s.focusedTile === tile.id);
  const isSelected = useCanvasStore(s => s.selectedTiles.includes(tile.id));
  const isDimmed = useCanvasStore(
    s => s.focusModeActive && !s.focusModeTiles.includes(tile.id),
  );
  const hasIncomingWire = useCanvasStore(s => {
    const wires = s.wires[s.activeProject];
    if (!wires) return false;
    for (const w of wires) {
      if (w.toTile === tile.id && w.active) return true;
    }
    return false;
  });

  const dragRef = useRef<{ startX: number; startY: number; tileX: number; tileY: number } | null>(null);
  const resizeRef = useRef<{ edge: ResizeEdge; startX: number; startY: number; tileX: number; tileY: number; tileW: number; tileH: number } | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  const onTitlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    const store = useCanvasStore.getState();
    if (e.shiftKey) {
      store.toggleSelectTile(tile.id);
      return;
    }
    store.bringToFront(tile.id);
    dragRef.current = { startX: e.clientX, startY: e.clientY, tileX: tile.x, tileY: tile.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [tile.id, tile.x, tile.y]);

  const lastDragPos = useRef<{ x: number; y: number } | null>(null);

  const onTitlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const state = useCanvasStore.getState();
    const scale = (state.transforms[state.activeProject] || { scale: 1 }).scale;
    const dx = (e.clientX - dragRef.current.startX) / scale;
    const dy = (e.clientY - dragRef.current.startY) / scale;
    const rawX = snapToGrid(dragRef.current.tileX + dx);
    const rawY = snapToGrid(dragRef.current.tileY + dy);

    // If this tile is in the selection, move all selected tiles by delta
    if (state.selectedTiles.includes(tile.id) && state.selectedTiles.length > 1) {
      const prevX = lastDragPos.current?.x ?? dragRef.current.tileX;
      const prevY = lastDragPos.current?.y ?? dragRef.current.tileY;
      const ddx = rawX - prevX;
      const ddy = rawY - prevY;
      if (ddx !== 0 || ddy !== 0) {
        state.moveSelectedTiles(ddx, ddy);
      }
      lastDragPos.current = { x: rawX, y: rawY };
      state.setSnapGuides([]);
    } else {
      // Single tile drag — use tile-to-tile snapping
      const allTiles = state.tiles[state.activeProject] || [];
      const { x: snappedX, y: snappedY, guides } = snapToTiles(rawX, rawY, tile.w, tile.h, allTiles, tile.id);
      state.moveTile(tile.id, snappedX, snappedY);
      state.setSnapGuides(guides);
    }
  }, [tile.id, tile.w, tile.h]);

  const onTitlePointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    lastDragPos.current = null;
    useCanvasStore.getState().setSnapGuides([]);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  const onResizePointerDown = useCallback((edge: ResizeEdge, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    useCanvasStore.getState().bringToFront(tile.id);
    resizeRef.current = {
      edge,
      startX: e.clientX, startY: e.clientY,
      tileX: tile.x, tileY: tile.y,
      tileW: tile.w, tileH: tile.h,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [tile.id, tile.x, tile.y, tile.w, tile.h]);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const r = resizeRef.current;
    const state = useCanvasStore.getState();
    const scale = (state.transforms[state.activeProject] || { scale: 1 }).scale;
    const dx = (e.clientX - r.startX) / scale;
    const dy = (e.clientY - r.startY) / scale;

    let newX = r.tileX, newY = r.tileY, newW = r.tileW, newH = r.tileH;

    if (r.edge.includes('e')) newW = Math.max(MIN_W, r.tileW + dx);
    if (r.edge.includes('w')) {
      const dw = Math.min(dx, r.tileW - MIN_W);
      newX = r.tileX + dw;
      newW = r.tileW - dw;
    }
    if (r.edge.includes('s')) newH = Math.max(MIN_H, r.tileH + dy);
    if (r.edge.includes('n')) {
      const dh = Math.min(dy, r.tileH - MIN_H);
      newY = r.tileY + dh;
      newH = r.tileH - dh;
    }

    state.moveTile(tile.id, snapToGrid(newX), snapToGrid(newY));
    state.resizeTile(tile.id, snapToGrid(newW), snapToGrid(newH));
  }, [tile.id]);

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    resizeRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  const handlePinOutput = useCallback(() => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    // Grab wireData for this tile's PTY
    const currentTile = (store.tiles[pid] || []).find(t => t.id === tile.id);
    const ptyId = currentTile && 'ptyId' in currentTile ? (currentTile as { ptyId?: string }).ptyId : undefined;
    const output = ptyId ? (store.wireData[ptyId] || '') : '';
    if (!output) return;
    store.addTile({
      id: crypto.randomUUID(),
      type: 'note',
      title: `Pin: ${tile.title || tile.type}`,
      content: '```\n' + output + '\n```',
      x: tile.x + tile.w + 16,
      y: tile.y,
      w: 400,
      h: 300,
    } as Tile);
  }, [tile]);

  const handleClone = useCallback(() => {
    const store = useCanvasStore.getState();
    const { id: _id, ptyId: _pty, ...config } = tile as unknown as Record<string, unknown>;
    delete config.ptyId;
    store.addTile({
      ...config,
      id: crypto.randomUUID(),
      x: tile.x + 40,
      y: tile.y + 40,
      title: (tile.title || tile.type) + ' (copy)',
    } as Tile);
  }, [tile]);

  const handleSaveAsTemplate = useCallback(() => {
    const name = prompt('Template name:', tile.title || tile.type);
    if (!name) return;
    // Extract tile config (everything except positional/id fields)
    const { id: _id, x: _x, y: _y, w: _w, h: _h, type, title: _title, ...config } = tile as unknown as Record<string, unknown>;
    // Remove runtime state (ptyId, status, elapsed, connected, etc.)
    delete config.ptyId;
    useTemplateStore.getState().addTemplate({
      id: crypto.randomUUID(),
      name,
      category: type as TileType,
      description: `Saved from ${tile.title || tile.type}`,
      config,
      isBuiltin: false,
    });
  }, [tile]);

  const handleClose = useCallback(() => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    const currentTile = (store.tiles[pid] || []).find(t => t.id === tile.id);
    const ptyId = currentTile && 'ptyId' in currentTile ? (currentTile as { ptyId?: string }).ptyId : undefined;
    if (ptyId) ptyKill(ptyId).catch(() => {});
    store.removeTile(tile.id);
  }, [tile.id]);


  const tileColor = tileColors[tile.type] || colors.onSurfaceVariant;

  return (
    <div
      ref={shellRef}
      data-tile-shell="true"
      role="region"
      aria-label={`${tile.type} tile: ${tile.title || tile.type}`}
      aria-selected={isSelected}
      tabIndex={0}
      onFocus={() => useCanvasStore.getState().bringToFront(tile.id)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          (e.currentTarget as HTMLElement).blur();
          useCanvasStore.getState().setFocusedTile(null);
        }
        if (e.key === 'Delete' && (e.ctrlKey || e.metaKey)) {
          e.stopPropagation();
          handleClose();
        }
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        left: tile.x,
        top: tile.y,
        width: tile.w,
        height: tile.h,
        zIndex: Math.max(0, zIndex),
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        ...(isFocused ? glassActive : glass),
        ...(isSelected ? {
          boxShadow: `0 0 0 2px ${colors.primary}, 0 0 24px 6px ${alpha(colors.primary, 25)}`,
        } : {}),
        opacity: isDimmed ? 0.15 : 1,
        filter: isDimmed ? 'blur(2px)' : 'none',
        pointerEvents: isDimmed ? 'none' : 'auto',
        transition: `opacity ${motion.enter}, filter ${motion.enter}`,
      }}
    >
      {/* Title bar */}
      <div
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          gap: spacing.sm,
          padding: `0 ${spacing.sm}`,
          cursor: 'grab',
          flexShrink: 0,
          borderBottom: `1px solid ${colors.outlineGhost}`,
          background: colors.surfaceHigh,
          userSelect: 'none',
        }}
      >
        <div style={{
          width: 8, height: 8,
          borderRadius: radius.full,
          background: tileColor,
          flexShrink: 0,
        }} />

        <div style={{
          ...typography.labelSm,
          color: colors.onSurfaceVariant,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {tile.title || tile.type}
        </div>

        {hasIncomingWire && (
          <div style={{
            ...typography.labelSm,
            fontSize: '0.5625rem',
            color: colors.primary,
            background: alpha(colors.primary, 9),
            padding: '1px 5px',
            borderRadius: radius.sm,
            fontFamily: fonts.mono,
            flexShrink: 0,
          }}>
            piped
          </div>
        )}

        {hovered && (tile.type === 'terminal' || tile.type === 'agent' || tile.type === 'runner') && (
          <button
            onClick={handlePinOutput}
            onPointerDown={e => e.stopPropagation()}
            title="Pin output as note"
            aria-label="Pin output as note"
            style={{
              width: 20, height: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none',
              color: colors.onSurfaceVariant,
              cursor: 'pointer',
              borderRadius: radius.sm,
              fontSize: 10,
              lineHeight: 1,
              padding: 0,
              opacity: 0.6,
              transition: `color ${motion.hover}, opacity ${motion.hover}`,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.primary; e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.onSurfaceVariant; e.currentTarget.style.opacity = '0.6'; }}
          >
            &#128204;
          </button>
        )}

        {hovered && (
          <button
            onClick={handleClone}
            onPointerDown={e => e.stopPropagation()}
            title="Duplicate tile"
            aria-label="Duplicate tile"
            style={{
              width: 20, height: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none',
              color: colors.onSurfaceVariant,
              cursor: 'pointer',
              borderRadius: radius.sm,
              fontSize: 10,
              lineHeight: 1,
              padding: 0,
              opacity: 0.6,
              transition: `color ${motion.hover}, opacity ${motion.hover}`,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.primary; e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.onSurfaceVariant; e.currentTarget.style.opacity = '0.6'; }}
          >
            &#8910;
          </button>
        )}

        {hovered && (
          <button
            onClick={() => detachTile(tile.id)}
            onPointerDown={e => e.stopPropagation()}
            title="Detach to new window"
            aria-label="Detach tile to new window"
            style={{
              width: 20, height: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none',
              color: colors.onSurfaceVariant,
              cursor: 'pointer',
              borderRadius: radius.sm,
              fontSize: 9,
              lineHeight: 1,
              padding: 0,
              opacity: 0.6,
              transition: `color ${motion.hover}, opacity ${motion.hover}`,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.primary; e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.onSurfaceVariant; e.currentTarget.style.opacity = '0.6'; }}
          >
            &#8599;
          </button>
        )}

        {hovered && (
          <button
            onClick={handleSaveAsTemplate}
            onPointerDown={e => e.stopPropagation()}
            title="Save as template"
            aria-label="Save tile as template"
            style={{
              width: 20, height: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none',
              color: colors.onSurfaceVariant,
              cursor: 'pointer',
              borderRadius: radius.sm,
              fontSize: 9,
              lineHeight: 1,
              padding: 0,
              opacity: 0.6,
              transition: `color ${motion.hover}, background ${motion.hover}, opacity ${motion.hover}`,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.primary; e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.onSurfaceVariant; e.currentTarget.style.opacity = '0.6'; }}
          >
            &#9733;
          </button>
        )}

        <button
          onClick={handleClose}
          onPointerDown={e => e.stopPropagation()}
          aria-label="Close tile"
          style={{
            width: 20, height: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none',
            color: colors.onSurfaceVariant,
            cursor: 'pointer',
            borderRadius: radius.sm,
            fontSize: 12,
            fontFamily: fonts.mono,
            lineHeight: 1,
            padding: 0,
            transition: `color ${motion.hover}, background ${motion.hover}`,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = colors.primary; e.currentTarget.style.background = 'var(--tx-glow-strong)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = colors.onSurfaceVariant; e.currentTarget.style.background = 'none'; }}
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div
        data-tile-content="true"
        onPointerDown={() => {
          // Defer bringToFront so the synchronous Zustand state update + React
          // re-render doesn't happen during the pointer-down event chain.
          // A synchronous re-render here steals focus from xterm's hidden
          // <textarea>, making terminals un-typable.
          requestAnimationFrame(() => useCanvasStore.getState().bringToFront(tile.id));
          // NEVER call e.preventDefault() here — the click must reach xterm's
          // internal textarea so it receives focus.
        }}
        style={{ flex: 1, overflow: 'hidden', position: 'relative', userSelect: 'text' }}
      >
        {children}
      </div>

      {/* Wiring ports — right = output, left = input */}
      <WiringPortHandle tileId={tile.id} side="right" visible={hovered} />
      <WiringPortHandle tileId={tile.id} side="left" visible={hovered} />

      {/* Resize handles */}
      {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeEdge[]).map(edge => (
        <div
          key={edge}
          onPointerDown={e => onResizePointerDown(edge, e)}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          style={{
            position: 'absolute',
            cursor: RESIZE_CURSORS[edge],
            ...getResizeHandleStyle(edge),
          }}
        />
      ))}
    </div>
  );
});

function WiringPortHandle({ tileId, side, visible }: { tileId: string; side: 'left' | 'right'; visible: boolean }) {
  const dragging = useWiringStore(s => s.dragging);
  const isSource = useWiringStore(s => s.fromTileId === tileId);

  // Hide the source tile's left port during drag, hide target's right port during drag
  const show = visible || dragging;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (side !== 'right') return;
    e.stopPropagation();
    e.preventDefault();
    useWiringStore.getState().start(tileId, e.clientX, e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    if (side !== 'left') return;
    e.stopPropagation();
    e.preventDefault();
    useWiringStore.getState().finish(tileId);
  };

  const handlePointerEnter = () => {
    // Highlight the port when hovered during a drag
  };

  if (!show) return null;

  const leftOffset = side === 'left' ? -6 : undefined;
  const rightOffset = side === 'right' ? -6 : undefined;

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerEnter={handlePointerEnter}
      title={side === 'right' ? 'Drag to connect to another tile' : 'Connection input'}
      style={{
        position: 'absolute',
        top: '50%',
        left: leftOffset,
        right: rightOffset,
        transform: 'translateY(-50%)',
        width: 14,
        height: 14,
        borderRadius: radius.full,
        border: `2px solid ${colors.primary}`,
        background: (dragging && side === 'left' && !isSource) ? colors.primary : colors.bg,
        cursor: side === 'right' ? 'crosshair' : (dragging ? 'crosshair' : 'default'),
        zIndex: 20,
        transition: `background ${motion.hover}, box-shadow ${motion.hover}`,
        boxShadow: (dragging && side === 'left' && !isSource) ? `0 0 10px ${alpha(colors.primary, 40)}` : 'none',
      }}
    />
  );
}

function getResizeHandleStyle(edge: ResizeEdge): React.CSSProperties {
  const base: React.CSSProperties = { zIndex: 10 };
  switch (edge) {
    case 'n': return { ...base, top: 0, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_SIZE };
    case 's': return { ...base, bottom: 0, left: CORNER_SIZE, right: CORNER_SIZE, height: EDGE_SIZE };
    case 'e': return { ...base, right: 0, top: CORNER_SIZE, bottom: CORNER_SIZE, width: EDGE_SIZE };
    case 'w': return { ...base, left: 0, top: CORNER_SIZE, bottom: CORNER_SIZE, width: EDGE_SIZE };
    case 'ne': return { ...base, top: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE };
    case 'nw': return { ...base, top: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE };
    case 'se': return { ...base, bottom: 0, right: 0, width: CORNER_SIZE, height: CORNER_SIZE };
    case 'sw': return { ...base, bottom: 0, left: 0, width: CORNER_SIZE, height: CORNER_SIZE };
  }
}
