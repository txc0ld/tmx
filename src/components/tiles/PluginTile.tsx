import { useRef, useEffect, useCallback } from 'react';
import { usePluginStore } from '@/stores/pluginStore';
import { colors, typography, spacing, fonts } from '@/design/tokens';
import type { TileBase } from '@/types';

interface PluginTileProps {
  tile: TileBase & { pluginId?: string };
}

export function PluginTile({ tile }: PluginTileProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const plugin = usePluginStore(s =>
    s.plugins.find(p => p.id === tile.pluginId && p.enabled),
  );

  // Post tile config to iframe on load
  const handleIframeLoad = useCallback(() => {
    if (!iframeRef.current || !plugin) return;
    iframeRef.current.contentWindow?.postMessage({
      type: 'tx-plugin-init',
      tileId: tile.id,
      config: tile,
    }, '*');
  }, [tile, plugin]);

  // Listen for messages from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'tx-plugin-action' && e.data?.tileId === tile.id) {
        // Handle plugin actions (future: wire to canvasStore)
        console.log('[Plugin action]', e.data);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [tile.id]);

  if (!plugin) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: spacing.sm,
        color: colors.secondary,
      }}>
        <span style={{ ...typography.labelMd }}>Plugin Not Found</span>
        <span style={{ ...typography.labelSm, color: colors.onSurfaceVariant }}>
          Plugin "{tile.pluginId}" is not installed or disabled
        </span>
      </div>
    );
  }

  if (!plugin.entryUrl) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: spacing.sm,
        color: colors.secondary,
      }}>
        <span style={{ ...typography.labelMd }}>{plugin.name}</span>
        <span style={{ ...typography.labelSm, color: colors.onSurfaceVariant }}>
          {plugin.description || 'No UI entry point configured'}
        </span>
        <span style={{ ...typography.labelSm, fontFamily: fonts.mono, color: colors.onSurfaceVariant }}>
          v{plugin.version}
        </span>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={plugin.entryUrl}
      onLoad={handleIframeLoad}
      sandbox="allow-scripts allow-same-origin"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        background: colors.bg,
      }}
      title={`Plugin: ${plugin.name}`}
    />
  );
}
