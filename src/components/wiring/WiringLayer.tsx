import { useCanvasStore } from '@/stores/canvasStore';
import { colors } from '@/design/tokens';
import type { Wire, Tile } from '@/types';

const EMPTY: never[] = [];

export function WiringLayer() {
  const activeProject = useCanvasStore(s => s.activeProject);
  const tilesMap = useCanvasStore(s => s.tiles);
  const wiresMap = useCanvasStore(s => s.wires);

  const tiles = tilesMap[activeProject] ?? EMPTY;
  const wires = wiresMap[activeProject] ?? EMPTY;

  if (wires.length === 0) return null;

  const tileMap = new Map(tiles.map(t => [t.id, t]));

  return (
    <svg
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

        return (
          <WirePath key={wire.id} wire={wire} from={from} to={to} />
        );
      })}
    </svg>
  );
}

function WirePath({ wire, from, to }: { wire: Wire; from: Tile; to: Tile }) {
  // Output port: right center of source tile
  const sx = from.x + from.w;
  const sy = from.y + from.h / 2;
  // Input port: left center of target tile
  const ex = to.x;
  const ey = to.y + to.h / 2;

  const dx = Math.abs(ex - sx) / 2;
  const d = `M ${sx},${sy} C ${sx + dx},${sy} ${ex - dx},${ey} ${ex},${ey}`;

  return (
    <path
      d={d}
      fill="none"
      stroke={wire.active ? colors.primary : colors.outlineVariant}
      strokeWidth={2}
      strokeDasharray={wire.active ? '6 4' : 'none'}
      style={wire.active ? { animation: 'wire-flow 1.2s linear infinite' } : undefined}
    />
  );
}
