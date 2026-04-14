import { colors } from '@/design/tokens';
import type { CanvasTransform } from '@/types';

interface CanvasGridProps {
  transform: CanvasTransform;
}

const GRID_SIZE = 8;

export function CanvasGrid({ transform }: CanvasGridProps) {
  const dotOpacity = Math.min(1, transform.scale / 0.3) * 0.4;

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      <defs>
        <pattern
          id="canvas-dot-grid"
          patternUnits="userSpaceOnUse"
          width={GRID_SIZE}
          height={GRID_SIZE}
          patternTransform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}
        >
          <circle
            cx={GRID_SIZE / 2}
            cy={GRID_SIZE / 2}
            r={1}
            fill={colors.onSurfaceVariant}
            opacity={dotOpacity}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#canvas-dot-grid)" />
    </svg>
  );
}
