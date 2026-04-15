import { useState, useEffect, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { ptySpawn, ptyKill, dockerListContainers } from '@/utils/ipc';
import { colors, radius, spacing, typography, fonts, motion } from '@/design/tokens';
import { TerminalPane } from './TerminalPane';
import type { DockerTile as DockerTileType, DockerContainer } from '@/types';

interface DockerTileProps {
  tile: DockerTileType;
}

export function DockerTile({ tile }: DockerTileProps) {
  const [containers, setContainers] = useState<DockerContainer[]>(tile.containers || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attached, setAttached] = useState(!!tile.ptyId);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await dockerListContainers();
      const parsed: DockerContainer[] = result.map(c => ({
        id: c.id.slice(0, 12),
        name: c.name,
        image: c.image,
        status: c.status,
      }));
      setContainers(parsed);
      useCanvasStore.getState().updateTile(tile.id, { containers: parsed } as Partial<DockerTileType>);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [tile.id]);

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAttach = useCallback(async (containerId: string) => {
    // Validate container ID — Docker IDs are hex only (12 or 64 chars)
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      setError('Invalid container ID');
      return;
    }
    try {
      const id = await ptySpawn({ shell: 'docker', args: ['exec', '-it', containerId, '/bin/sh'] });
      useCanvasStore.getState().updateTile(tile.id, { ptyId: id, selectedContainer: containerId } as Partial<DockerTileType>);
      setAttached(true);
    } catch (e) {
      setError(String(e));
      setAttached(false);
    }
  }, [tile.id]);

  const handleDetach = useCallback(async () => {
    if (tile.ptyId) await ptyKill(tile.ptyId).catch(() => {});
    useCanvasStore.getState().updateTile(tile.id, { ptyId: undefined, selectedContainer: undefined } as Partial<DockerTileType>);
    setAttached(false);
  }, [tile.id, tile.ptyId]);

  const handlePtySpawned = useCallback((_paneId: string, ptyId: string) => {
    useCanvasStore.getState().updateTile(tile.id, { ptyId } as Partial<DockerTileType>);
  }, [tile.id]);

  if (attached && tile.ptyId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: spacing.sm,
          padding: `4px ${spacing.sm}`,
          borderBottom: `1px solid ${colors.outlineGhost}`,
          flexShrink: 0,
        }}>
          <span style={{ ...typography.labelSm, color: colors.primary, fontFamily: fonts.mono }}>
            {tile.selectedContainer}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={handleDetach} style={{
            background: 'none', border: `1px solid ${colors.outlineGhost}`,
            borderRadius: radius.sm, color: colors.onSurfaceVariant,
            fontSize: '0.625rem', padding: '1px 6px', cursor: 'pointer', fontFamily: fonts.mono,
          }}>
            Detach
          </button>
        </div>
        <div style={{ flex: 1 }}>
          <TerminalPane paneId={tile.id} ptyId={tile.ptyId} cwd="/" tileId={tile.id} onPtySpawned={handlePtySpawned} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: spacing.sm,
        padding: `4px ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineGhost}`, flexShrink: 0,
      }}>
        <span style={{ ...typography.labelSm, color: colors.onSurface }}>Containers</span>
        <div style={{ flex: 1 }} />
        <button onClick={refresh} disabled={loading} style={{
          background: 'none', border: `1px solid ${colors.outlineGhost}`,
          borderRadius: radius.sm, color: colors.onSurfaceVariant,
          fontSize: '0.625rem', padding: '1px 6px', cursor: 'pointer', fontFamily: fonts.mono,
        }}>
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: spacing.xs }}>
        {error && <div style={{ ...typography.labelSm, color: colors.primary, padding: spacing.sm }}>{error}</div>}

        {containers.length === 0 && !loading && !error && (
          <div style={{ ...typography.labelSm, color: colors.secondary, padding: spacing.md, textAlign: 'center' }}>
            No running containers
          </div>
        )}

        {containers.map(c => (
          <div key={c.id} style={{
            display: 'flex', alignItems: 'center', gap: spacing.sm,
            padding: `4px ${spacing.sm}`, borderRadius: radius.sm,
            transition: `background ${motion.hover}`,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: c.status.startsWith('Up') ? colors.primary : colors.secondary }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...typography.labelSm, color: colors.onSurfaceVariant, fontFamily: fonts.mono }}>{c.name}</div>
              <div style={{ ...typography.labelSm, color: colors.secondary, fontSize: '0.5625rem' }}>{c.image}</div>
            </div>
            <button onClick={() => handleAttach(c.id)} style={{
              background: colors.primary, border: 'none', borderRadius: radius.sm,
              color: colors.bg, fontSize: '0.5625rem', padding: '2px 6px',
              cursor: 'pointer', fontWeight: 600,
            }}>
              Attach
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
