import { useState, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { ptySpawn, ptyKill } from '@/utils/ipc';
import { colors, radius, spacing, typography, fonts } from '@/design/tokens';
import { TerminalPane } from './TerminalPane';
import type { SshTile as SshTileType } from '@/types';

interface SshTileProps {
  tile: SshTileType;
}

export function SshTile({ tile }: SshTileProps) {
  const [host, setHost] = useState(tile.host || '');
  const [port, setPort] = useState(String(tile.port || 22));
  const [user, setUser] = useState(tile.user || '');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  const handleConnect = useCallback(async () => {
    if (!host.trim() || !user.trim()) return;
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError('Port must be a number between 1 and 65535');
      return;
    }
    setConnecting(true);
    setError('');
    try {
      const id = await ptySpawn({
        shell: 'ssh',
        args: ['-p', port, `${user}@${host}`],
      });
      useCanvasStore.getState().updateTile(tile.id, {
        ptyId: id, connected: true, host, port: Number(port), user,
      } as Partial<SshTileType>);
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  }, [tile.id, host, port, user]);

  const handleDisconnect = useCallback(async () => {
    if (tile.ptyId) {
      await ptyKill(tile.ptyId).catch(() => {});
    }
    useCanvasStore.getState().updateTile(tile.id, {
      ptyId: undefined, connected: false,
    } as Partial<SshTileType>);
  }, [tile.id, tile.ptyId]);

  const handlePtySpawned = useCallback((_paneId: string, ptyId: string) => {
    useCanvasStore.getState().updateTile(tile.id, { ptyId } as Partial<SshTileType>);
  }, [tile.id]);

  if (tile.connected && tile.ptyId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: spacing.sm,
          padding: `4px ${spacing.sm}`,
          borderBottom: `1px solid ${colors.outlineGhost}`,
          flexShrink: 0,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: colors.primary }} />
          <span style={{ ...typography.labelSm, color: colors.onSurfaceVariant, fontFamily: fonts.mono }}>
            {tile.user}@{tile.host}:{tile.port}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={handleDisconnect} style={{
            background: 'none', border: `1px solid ${colors.outlineGhost}`,
            borderRadius: radius.sm, color: colors.onSurfaceVariant,
            fontSize: '0.625rem', padding: '1px 6px', cursor: 'pointer', fontFamily: fonts.mono,
          }}>
            Disconnect
          </button>
        </div>
        <div style={{ flex: 1 }}>
          <TerminalPane paneId={tile.id} ptyId={tile.ptyId} cwd="~" tileId={tile.id} onPtySpawned={handlePtySpawned} />
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: spacing.sm,
      padding: spacing.md, height: '100%', justifyContent: 'center',
    }}>
      <div style={{ ...typography.labelMd, color: colors.onSurface }}>SSH Connection</div>
      <input value={host} onChange={e => setHost(e.target.value)} placeholder="Host (e.g. 192.168.1.1)" style={inputStyle} />
      <div style={{ display: 'flex', gap: spacing.xs }}>
        <input value={user} onChange={e => setUser(e.target.value)} placeholder="User" style={{ ...inputStyle, flex: 1 }} />
        <input value={port} onChange={e => setPort(e.target.value)} placeholder="Port" type="number" min={1} max={65535} style={{ ...inputStyle, width: 60 }} />
      </div>
      {error && <div style={{ ...typography.labelSm, color: colors.primary }}>{error}</div>}
      <button
        onClick={handleConnect}
        disabled={connecting}
        onKeyDown={e => { if (e.key === 'Enter') handleConnect(); }}
        style={{
          height: 32, background: colors.primary, border: 'none', borderRadius: radius.sm,
          color: colors.bg, fontWeight: 600, fontSize: '0.8125rem', cursor: 'pointer',
        }}
      >
        {connecting ? 'Connecting...' : 'Connect'}
      </button>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 32, background: 'transparent',
  border: '1px solid var(--tx-outline-ghost)', borderRadius: '0.375rem',
  color: 'var(--tx-on-surface)', fontFamily: "'JetBrains Mono', monospace",
  fontSize: '0.8125rem', padding: '0 8px', outline: 'none', width: '100%',
};
