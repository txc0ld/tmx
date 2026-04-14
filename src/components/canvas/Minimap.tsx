import { useCanvasStore } from '@/stores/canvasStore';
import { colors, glass, radius, tileColors, alpha } from '@/design/tokens';

const MINIMAP_W = 180;
const MINIMAP_H = 120;
const PADDING = 20;

const EMPTY_TILES: never[] = [];
const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1 };

export function Minimap() {
  const activeProject = useCanvasStore(s => s.activeProject);
  const tilesMap = useCanvasStore(s => s.tiles);
  const transformsMap = useCanvasStore(s => s.transforms);

  const tiles = tilesMap[activeProject] ?? EMPTY_TILES;
  const transform = transformsMap[activeProject] ?? DEFAULT_TRANSFORM;

  if (tiles.length === 0) return null;

  // Compute bounding box of all tiles
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + t.w);
    maxY = Math.max(maxY, t.y + t.h);
  }

  // Include viewport bounds
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const vpLeft = -transform.x / transform.scale;
  const vpTop = -transform.y / transform.scale;
  const vpRight = vpLeft + vpW / transform.scale;
  const vpBottom = vpTop + vpH / transform.scale;

  minX = Math.min(minX, vpLeft) - PADDING;
  minY = Math.min(minY, vpTop) - PADDING;
  maxX = Math.max(maxX, vpRight) + PADDING;
  maxY = Math.max(maxY, vpBottom) + PADDING;

  const worldW = maxX - minX;
  const worldH = maxY - minY;
  const scale = Math.min(MINIMAP_W / worldW, MINIMAP_H / worldH);

  const toMinimap = (x: number, y: number) => ({
    x: (x - minX) * scale,
    y: (y - minY) * scale,
  });

  const handleClick = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Convert minimap click to canvas coordinates
    const canvasX = mx / scale + minX;
    const canvasY = my / scale + minY;

    // Center the viewport on the clicked point
    useCanvasStore.getState().setTransform({
      x: -canvasX * transform.scale + vpW / 2,
      y: -canvasY * transform.scale + vpH / 2,
      scale: transform.scale,
    });
  };

  return (
    <div
      onClick={handleClick}
      style={{
        position: 'absolute',
        bottom: 12,
        right: 12,
        width: MINIMAP_W,
        height: MINIMAP_H,
        ...glass,
        borderRadius: radius.md,
        cursor: 'pointer',
        overflow: 'hidden',
        zIndex: 100,
      }}
    >
      <svg width={MINIMAP_W} height={MINIMAP_H}>
        {/* Tiles */}
        {tiles.map(t => {
          const pos = toMinimap(t.x, t.y);
          return (
            <rect
              key={t.id}
              x={pos.x}
              y={pos.y}
              width={Math.max(3, t.w * scale)}
              height={Math.max(3, t.h * scale)}
              fill={tileColors[t.type] || colors.onSurfaceVariant}
              rx={1}
              opacity={0.8}
            />
          );
        })}

        {/* Viewport indicator */}
        {(() => {
          const vp = toMinimap(vpLeft, vpTop);
          return (
            <rect
              x={vp.x}
              y={vp.y}
              width={Math.max(4, (vpW / transform.scale) * scale)}
              height={Math.max(4, (vpH / transform.scale) * scale)}
              fill="none"
              stroke={alpha(colors.onSurface, 40)}
              strokeWidth={1}
              rx={1}
            />
          );
        })()}
      </svg>
    </div>
  );
}
