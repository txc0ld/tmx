import { useState, useRef, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { colors, radius, fonts, typography } from '@/design/tokens';
import type { BrowserTile as BrowserTileType } from '@/types';

interface BrowserTileProps {
  tile: BrowserTileType;
}

export function BrowserTile({ tile }: BrowserTileProps) {
  const [inputUrl, setInputUrl] = useState(tile.url);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const navigate = useCallback((url: string) => {
    let normalized = url.trim();
    if (normalized && !/^https?:\/\//i.test(normalized)) {
      normalized = 'http://' + normalized;
    }
    setInputUrl(normalized);
    useCanvasStore.getState().updateTile(tile.id, { url: normalized } as Partial<BrowserTileType>);
  }, [tile.id]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      navigate(inputUrl);
    }
  }, [inputUrl, navigate]);

  const handleRefresh = useCallback(() => {
    const iframe = iframeRef.current;
    if (iframe) {
      // Force reload by resetting src
      const src = iframe.src;
      iframe.src = '';
      iframe.src = src;
    }
  }, []);

  return (
    <div data-tile-content style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* URL bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 28,
        minHeight: 28,
        padding: '0 6px',
        background: colors.surfaceLowest,
        borderBottom: `1px solid ${colors.outlineVariant}`,
      }}>
        <button
          onClick={handleRefresh}
          title="Refresh"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            padding: 0,
            border: 'none',
            borderRadius: radius.sm,
            background: 'transparent',
            color: colors.onSurfaceVariant,
            cursor: 'pointer',
            fontFamily: fonts.mono,
            fontSize: '0.7rem',
            lineHeight: 1,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = colors.surfaceHigh; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          &#x21bb;
        </button>
        <input
          type="text"
          value={inputUrl}
          onChange={e => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => navigate(inputUrl)}
          spellCheck={false}
          style={{
            flex: 1,
            height: 20,
            padding: '0 6px',
            border: `1px solid ${colors.outlineGhost}`,
            borderRadius: radius.sm,
            background: colors.surfaceLow,
            color: colors.onSurface,
            fontFamily: fonts.mono,
            fontSize: '0.625rem',
            outline: 'none',
          }}
        />
      </div>

      {/* iframe container */}
      <div style={{ flex: 1, position: 'relative', width: '100%' }}>
        {loading && !loadError && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: colors.secondary,
            ...typography.labelSm,
          }}>
            Loading...
          </div>
        )}
        {loadError && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: colors.secondary,
            ...typography.labelSm,
          }}>
            Failed to load
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={tile.url}
          title={`Browser: ${tile.url}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          onLoad={() => setLoading(false)}
          onError={() => { setLoading(false); setLoadError(true); }}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            background: colors.bg,
            position: 'relative',
            zIndex: 1,
          }}
        />
      </div>
    </div>
  );
}
