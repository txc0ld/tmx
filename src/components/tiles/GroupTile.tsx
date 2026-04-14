import { useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { colors, spacing, typography, radius, fonts, motion } from '@/design/tokens';
import type { GroupTile } from '@/types';

interface GroupTileProps {
  tile: GroupTile;
}

export function GroupTileComponent({ tile }: GroupTileProps) {
  const toggleCollapse = useCallback(() => {
    useCanvasStore.getState().toggleGroupCollapse(tile.id);
  }, [tile.id]);

  const handleUngroup = useCallback(() => {
    useCanvasStore.getState().ungroupTiles(tile.id);
  }, [tile.id]);

  if (tile.collapsed) {
    return (
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        padding: spacing.md,
      }}>
        <div style={{
          ...typography.labelMd,
          color: colors.onSurface,
        }}>
          {tile.label}
        </div>
        <div style={{
          ...typography.labelSm,
          color: colors.secondary,
          fontFamily: fonts.mono,
        }}>
          {tile.childTileIds.length} tiles
        </div>
        <button
          onClick={toggleCollapse}
          style={{
            background: colors.surfaceHigh,
            border: `1px solid ${colors.outlineGhost}`,
            borderRadius: radius.sm,
            color: colors.primary,
            cursor: 'pointer',
            padding: `4px ${spacing.sm}`,
            ...typography.labelSm,
            fontFamily: fonts.mono,
            transition: `background ${motion.hover}`,
          }}
        >
          Expand
        </button>
      </div>
    );
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: spacing.xs,
      padding: spacing.xs,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: spacing.sm,
        padding: `2px ${spacing.xs}`,
      }}>
        <span style={{
          ...typography.labelMd,
          color: colors.onSurface,
          flex: 1,
        }}>
          {tile.label}
        </span>
        <span style={{
          ...typography.labelSm,
          color: colors.secondary,
          fontFamily: fonts.mono,
        }}>
          {tile.childTileIds.length}
        </span>
        <button
          onClick={toggleCollapse}
          onPointerDown={e => e.stopPropagation()}
          style={{
            background: 'none',
            border: 'none',
            color: colors.onSurfaceVariant,
            cursor: 'pointer',
            padding: '0 4px',
            ...typography.labelSm,
            fontFamily: fonts.mono,
            transition: `color ${motion.hover}`,
          }}
        >
          Collapse
        </button>
        <button
          onClick={handleUngroup}
          onPointerDown={e => e.stopPropagation()}
          style={{
            background: 'none',
            border: 'none',
            color: colors.onSurfaceVariant,
            cursor: 'pointer',
            padding: '0 4px',
            ...typography.labelSm,
            fontFamily: fonts.mono,
            transition: `color ${motion.hover}`,
          }}
        >
          Ungroup
        </button>
      </div>

      {/* The child tiles are rendered on the canvas directly, this is just a boundary indicator */}
      <div style={{
        flex: 1,
        border: `1px dashed ${colors.outlineGhost}`,
        borderRadius: radius.sm,
        opacity: 0.5,
      }} />
    </div>
  );
}
