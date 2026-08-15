import { useEffect, useRef, memo } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useWiringStore } from '@/stores/wiringStore';
import { confirmAction } from '@/utils/confirm';
import { colors } from '@/design/tokens';
import type { Wire, Tile } from '@/types';

const EMPTY: never[] = [];

export function WiringLayer() {
  const activeProject = useCanvasStore(s => s.activeProject);
  const tilesMap = useCanvasStore(s => s.tiles);
  const wiresMap = useCanvasStore(s => s.wires);
  const transformsMap = useCanvasStore(s => s.transforms);

  const dragging = useWiringStore(s => s.dragging);
  const fromTileId = useWiringStore(s => s.fromTileId);
  const cursorX = useWiringStore(s => s.cursorX);
  const cursorY = useWiringStore(s => s.cursorY);

  const tiles = tilesMap[activeProject] ?? EMPTY;
  const wires = wiresMap[activeProject] ?? EMPTY;
  const transform = transformsMap[activeProject] ?? { x: 0, y: 0, scale: 1 };

  // Global pointer tracking during drag + cancel on escape / right-click
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => useWiringStore.getState().moveCursor(e.clientX, e.clientY);
    const onUp = () => {
      // If pointer-up happens outside any port, cancel
      setTimeout(() => useWiringStore.getState().cancel(), 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useWiringStore.getState().cancel();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragging]);

  const svgRef = useRef<SVGSVGElement | null>(null);

  if (wires.length === 0 && !dragging) return null;

  const tileMap = new Map(tiles.map(t => [t.id, t]));
  const fromTile = fromTileId ? tileMap.get(fromTileId) : null;

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <defs>
        <style>{`
          @keyframes wire-flow {
            from { stroke-dashoffset: 20; }
            to { stroke-dashoffset: 0; }
          }
        `}</style>
      </defs>

      {wires.map(wire => {
        const from = tileMap.get(wire.fromTile);
        const to = tileMap.get(wire.toTile);
        if (!from || !to) return null;
        return <WirePath key={wire.id} wire={wire} from={from} to={to} />;
      })}

      {/* Live preview wire while dragging */}
      {dragging && fromTile && (
        <PreviewWire
          from={fromTile}
          cursorScreenX={cursorX}
          cursorScreenY={cursorY}
          transform={transform}
          svgRef={svgRef}
        />
      )}
    </svg>
  );
}

// Memoized with shallow-equal default: when ONE tile moves, only the wires
// whose endpoints changed re-render. Zustand's moveTile preserves other
// tiles' object identity, so the other WirePaths short-circuit here.
const WirePath = memo(function WirePath({ wire, from, to }: { wire: Wire; from: Tile; to: Tile }) {
  const sx = from.x + from.w;
  const sy = from.y + from.h / 2;
  const ex = to.x;
  const ey = to.y + to.h / 2;

  const dx = Math.abs(ex - sx) / 2;
  const d = `M ${sx},${sy} C ${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`;

  return (
    <g>
      {/* Invisible fat hit area for right-click delete */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onContextMenu={async e => {
          e.preventDefault();
          if (await confirmAction('Remove this wire?', { title: 'Remove Wire' })) {
            useCanvasStore.getState().removeWire(wire.id);
          }
        }}
      />
      <path
        d={d}
        fill="none"
        stroke={wire.active ? colors.primary : colors.outlineVariant}
        strokeWidth={2}
        strokeDasharray={wire.active ? '6 4' : 'none'}
        style={wire.active ? { animation: 'wire-flow 1.2s linear infinite' } : undefined}
      />
    </g>
  );
});

function PreviewWire({ from, cursorScreenX, cursorScreenY, transform, svgRef }:
  {
    from: Tile;
    cursorScreenX: number;
    cursorScreenY: number;
    transform: { x: number; y: number; scale: number };
    svgRef: React.RefObject<SVGSVGElement | null>;
  }) {
  const sx = from.x + from.w;
  const sy = from.y + from.h / 2;

  // Convert viewport cursor → canvas (pre-transform) coords.
  // The SVG sits INSIDE the transformed canvas layer, so we can read its
  // current bounding rect to find where canvas (0,0) is on screen. This
  // is the only correct way to account for the sidebar + top-bar offset
  // AND the current pan/zoom — `screenToCanvas` alone assumed the viewport
  // origin was the canvas origin, which it isn't.
  let ex: number;
  let ey: number;
  const svg = svgRef.current;
  if (svg) {
    const rect = svg.getBoundingClientRect();
    ex = (cursorScreenX - rect.left) / transform.scale;
    ey = (cursorScreenY - rect.top) / transform.scale;
  } else {
    // First-render fallback (ref not attached yet) — next render corrects it
    ex = (cursorScreenX - transform.x) / transform.scale;
    ey = (cursorScreenY - transform.y) / transform.scale;
  }

  const dx = Math.max(40, Math.abs(ex - sx) / 2);
  const d = `M ${sx},${sy} C ${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`;

  return (
    <path
      d={d}
      fill="none"
      stroke={colors.primary}
      strokeWidth={2}
      strokeDasharray="6 4"
      opacity={0.8}
    />
  );
}
