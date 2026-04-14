import { useState, useEffect, useCallback } from 'react';
import { gitStatus, gitLog, gitBranches, gitCheckout, gitFilesStatus, gitStage, gitUnstage, gitCommit } from '@/utils/ipc';
import type { GitLogEntry, GitFileStatus } from '@/utils/ipc';
import type { GitTile as GitTileType } from '@/types';
import { colors, fonts, radius, spacing, typography, motion, alpha } from '@/design/tokens';

interface GitTileProps {
  tile: GitTileType;
}

type Tab = 'status' | 'log' | 'branches';

export function GitTile({ tile }: GitTileProps) {
  const [tab, setTab] = useState<Tab>('status');
  const [branch, setBranch] = useState('');
  const [dirty, setDirty] = useState(false);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tile.repoPath) return;
    setLoading(true);
    setError(null);
    try {
      const [status, fileList] = await Promise.all([
        gitStatus(tile.repoPath),
        gitFilesStatus(tile.repoPath),
      ]);
      setBranch(status.branch);
      setDirty(status.dirty);
      setFiles(fileList);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }, [tile.repoPath]);

  // Refresh on mount + every 30s
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const loadLog = useCallback(async () => {
    if (!tile.repoPath) return;
    try {
      const entries = await gitLog(tile.repoPath, 30);
      setLog(entries);
    } catch (e) {
      setError(String(e));
    }
  }, [tile.repoPath]);

  const loadBranches = useCallback(async () => {
    if (!tile.repoPath) return;
    try {
      const b = await gitBranches(tile.repoPath);
      setBranches(b);
    } catch (e) {
      setError(String(e));
    }
  }, [tile.repoPath]);

  useEffect(() => {
    if (tab === 'log') loadLog();
    if (tab === 'branches') loadBranches();
    // Also poll the active tab every 30s
    if (tab === 'log' || tab === 'branches') {
      const interval = setInterval(() => {
        if (tab === 'log') loadLog();
        if (tab === 'branches') loadBranches();
      }, 30_000);
      return () => clearInterval(interval);
    }
  }, [tab, loadLog, loadBranches]);

  const handleStage = useCallback(async (path: string) => {
    await gitStage(tile.repoPath, path).catch(() => {});
    refresh();
  }, [tile.repoPath, refresh]);

  const handleUnstage = useCallback(async (path: string) => {
    await gitUnstage(tile.repoPath, path).catch(() => {});
    refresh();
  }, [tile.repoPath, refresh]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    try {
      await gitCommit(tile.repoPath, commitMsg.trim());
      setCommitMsg('');
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [tile.repoPath, commitMsg, refresh]);

  const handleCheckout = useCallback(async (b: string) => {
    try {
      await gitCheckout(tile.repoPath, b);
      refresh();
      loadBranches();
    } catch (e) {
      setError(String(e));
    }
  }, [tile.repoPath, refresh, loadBranches]);

  if (!tile.repoPath) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: colors.secondary, ...typography.labelSm,
      }}>
        No repository path set
      </div>
    );
  }

  const tabStyle = (t: Tab) => ({
    padding: '4px 10px',
    border: 'none',
    borderRadius: radius.sm,
    background: tab === t ? colors.surfaceHigh : 'transparent',
    color: tab === t ? colors.primary : colors.onSurfaceVariant,
    boxShadow: tab === t ? `inset 0 -2px 0 ${colors.primary}` : 'none',
    cursor: 'pointer' as const,
    ...typography.labelSm,
    fontFamily: fonts.mono,
    fontWeight: tab === t ? 600 : 500,
    transition: `all ${motion.hover}`,
  });

  const stagedFiles = files.filter(f => f.staged);
  const unstagedFiles = files.filter(f => !f.staged);

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      fontFamily: fonts.mono, fontSize: '0.75rem',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: spacing.sm,
        padding: `4px ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineGhost}`,
        flexShrink: 0,
      }}>
        <span style={{ color: colors.primary, ...typography.labelSm }}>
          {branch}
        </span>
        {dirty && (
          <span style={{
            fontSize: '0.5625rem', color: colors.yellow,
            background: alpha(colors.yellow, 10),
            padding: '1px 4px', borderRadius: radius.sm,
          }}>
            dirty
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={refresh} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: colors.onSurfaceVariant, fontSize: 10,
        }}>
          &#8635;
        </button>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 2, padding: '4px 6px',
        borderBottom: `1px solid ${colors.outlineGhost}`,
        flexShrink: 0,
      }}>
        <button onClick={() => setTab('status')} style={tabStyle('status')}>Status</button>
        <button onClick={() => setTab('log')} style={tabStyle('log')}>Log</button>
        <button onClick={() => setTab('branches')} style={tabStyle('branches')}>Branches</button>
      </div>

      {error && (
        <div style={{ padding: spacing.xs, color: colors.red, ...typography.labelSm }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{
          padding: spacing.md, color: colors.secondary,
          ...typography.labelSm, textAlign: 'center',
        }}>
          Loading...
        </div>
      )}

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: spacing.xs }}>
        {tab === 'status' && !loading && (
          <>
            {/* Staged files */}
            {stagedFiles.length > 0 && (
              <div style={{ marginBottom: spacing.sm }}>
                <div style={{ color: colors.green, ...typography.labelSm, padding: '2px 4px' }}>
                  Staged ({stagedFiles.length})
                </div>
                {stagedFiles.map(f => (
                  <div key={f.path} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '2px 4px', borderRadius: radius.sm,
                  }}>
                    <span style={{ color: colors.green, width: 16, flexShrink: 0 }}>{f.status}</span>
                    <span style={{ flex: 1, color: colors.onSurfaceVariant, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.path}
                    </span>
                    <button
                      onClick={() => handleUnstage(f.path)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.secondary, fontSize: 9 }}
                    >
                      &#8722;
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Unstaged files */}
            {unstagedFiles.length > 0 && (
              <div style={{ marginBottom: spacing.sm }}>
                <div style={{ color: colors.red, ...typography.labelSm, padding: '2px 4px' }}>
                  Changes ({unstagedFiles.length})
                </div>
                {unstagedFiles.map(f => (
                  <div key={f.path} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '2px 4px', borderRadius: radius.sm,
                  }}>
                    <span style={{ color: colors.red, width: 16, flexShrink: 0 }}>{f.status}</span>
                    <span style={{ flex: 1, color: colors.onSurfaceVariant, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.path}
                    </span>
                    <button
                      onClick={() => handleStage(f.path)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.secondary, fontSize: 9 }}
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
            )}

            {files.length === 0 && !loading && (
              <div style={{ padding: spacing.md, color: colors.secondary, ...typography.labelSm, textAlign: 'center' }}>
                Working tree clean
              </div>
            )}

            {/* Commit box */}
            {stagedFiles.length > 0 && (
              <div style={{
                display: 'flex', gap: 4, padding: '4px 0',
                borderTop: `1px solid ${colors.outlineGhost}`,
                marginTop: spacing.xs,
              }}>
                <input
                  value={commitMsg}
                  onChange={e => setCommitMsg(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCommit(); }}
                  placeholder="Commit message..."
                  style={{
                    flex: 1, padding: '4px 6px',
                    background: colors.surfaceLowest,
                    border: `1px solid ${colors.outlineGhost}`,
                    borderRadius: radius.sm,
                    color: colors.onSurface,
                    fontFamily: fonts.mono, fontSize: '0.6875rem',
                    outline: 'none',
                  }}
                />
                <button
                  onClick={handleCommit}
                  disabled={!commitMsg.trim()}
                  style={{
                    padding: '4px 8px',
                    background: commitMsg.trim() ? colors.primary : colors.surfaceLow,
                    color: commitMsg.trim() ? colors.bg : colors.secondary,
                    border: 'none', borderRadius: radius.sm,
                    cursor: commitMsg.trim() ? 'pointer' : 'default',
                    ...typography.labelSm, fontFamily: fonts.mono,
                  }}
                >
                  Commit
                </button>
              </div>
            )}
          </>
        )}

        {tab === 'log' && (
          <div>
            {log.map(entry => (
              <div key={entry.hash} style={{
                padding: '4px 4px',
                borderBottom: `1px solid ${colors.outlineGhost}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: colors.primary, fontFamily: fonts.mono, fontSize: '0.625rem' }}>
                    {entry.shortHash}
                  </span>
                  <span style={{ flex: 1, color: colors.onSurface, ...typography.labelSm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.message}
                  </span>
                </div>
                <div style={{ color: colors.secondary, fontSize: '0.5625rem', marginTop: 1 }}>
                  {entry.author} &middot; {new Date(entry.date).toLocaleDateString()}
                </div>
              </div>
            ))}
            {log.length === 0 && !loading && (
              <div style={{ padding: spacing.md, color: colors.secondary, ...typography.labelSm, textAlign: 'center' }}>
                No commits
              </div>
            )}
          </div>
        )}

        {tab === 'branches' && (
          <div>
            {branches.map(b => (
              <button
                key={b}
                onClick={() => handleCheckout(b)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  width: '100%', padding: '4px 6px',
                  background: b === branch ? alpha(colors.primary, 10) : 'transparent',
                  border: 'none', borderRadius: radius.sm,
                  cursor: 'pointer', textAlign: 'left',
                  color: b === branch ? colors.primary : colors.onSurfaceVariant,
                  ...typography.labelSm, fontFamily: fonts.mono,
                  transition: `background ${motion.hover}`,
                }}
                onMouseEnter={e => {
                  if (b !== branch) e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 5);
                }}
                onMouseLeave={e => {
                  if (b !== branch) e.currentTarget.style.background = 'transparent';
                }}
              >
                {b === branch && <span style={{ fontSize: 8 }}>&#9679;</span>}
                {b}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
