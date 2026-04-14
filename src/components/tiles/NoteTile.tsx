import { useState, useEffect } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { colors, fonts, spacing } from '@/design/tokens';
import type { NoteTile as NoteTileType } from '@/types';

interface NoteTileProps {
  tile: NoteTileType;
}

export function NoteTile({ tile }: NoteTileProps) {
  const [localContent, setLocalContent] = useState(tile.content);

  useEffect(() => {
    const timer = setTimeout(() => {
      useCanvasStore.getState().updateTile(tile.id, { content: localContent });
    }, 500);
    return () => clearTimeout(timer);
  }, [localContent, tile.id]);

  return (
    <textarea
      value={localContent}
      onChange={e => setLocalContent(e.target.value)}
      placeholder="Write something..."
      style={{
        width: '100%',
        height: '100%',
        background: 'transparent',
        border: 'none',
        resize: 'none',
        color: colors.onSurfaceVariant,
        fontFamily: fonts.body,
        fontSize: '0.875rem',
        lineHeight: '1.6',
        padding: spacing.md,
        outline: 'none',
      }}
    />
  );
}
