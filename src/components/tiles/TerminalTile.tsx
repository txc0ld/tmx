import { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useCanvasStore } from '@/stores/canvasStore';
import { useThemeStore } from '@/stores/themeStore';
import { usePty } from '@/hooks/usePty';
import { ptySpawn } from '@/utils/ipc';
import { colors, fonts, typography, radius, motion, alpha } from '@/design/tokens';
import { TerminalPane } from './TerminalPane';
import { attachKeyboardCapture } from './xtermInput';
import { useCommandHistoryStore } from '@/stores/commandHistoryStore';
import type { TerminalTile as TerminalTileType, TerminalSplit } from '@/types';

const EMPTY_HISTORY: string[] = [];

const MAX_PANES = 4;

function isLightTheme(t: { bg: string }): boolean {
  const hex = t.bg.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}

function getXtermTheme() {
  const t = useThemeStore.getState().getActiveTheme();
  const light = isLightTheme(t);
  return {
    background: light ? '#2d3228' : t.bg,
    foreground: light ? '#e0e0e0' : t.fg + 'c4',
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: t.accent + '26',
    black: t.bg,
    brightBlack: light ? t.fg + 'aa' : t.fg + '55',
    white: light ? t.fg : t.fg + 'c4',
    brightWhite: t.fg,
    green: t.accent,
    brightGreen: t.accent,
    yellow: t.accent,
    brightYellow: t.accent,
    blue: t.accent,
    brightBlue: t.accent,
    red: t.accent,
    brightRed: t.accent,
    cyan: t.accent,
    brightCyan: t.accent,
    magenta: t.accent,
    brightMagenta: t.accent,
  };
}

interface TerminalTileProps {
  tile: TerminalTileType;
}

export function TerminalTile({ tile }: TerminalTileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);
  // Note: we previously tried an inflate + counter-scale + fontSize-bump
  // dance to keep xterm crisp under outer CSS zoom. In practice it
  // scrambled xterm's buffer on zoom changes (fit recalcs + PTY resize
  // racing the fontSize update). xterm is now allowed to be bitmap-
  // stretched by the outer zoom — slightly blurry at non-1x zoom but
  // functional. DOM-heavy tiles (Monaco, notes, chrome) still re-raster
  // crisp because of the outer zoom.

  // Track splits locally — derive from tile.splits persisted in store
  const [splits, setSplits] = useState<TerminalSplit[]>(tile.splits || []);

  const onData = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);

  const onExit = useCallback(() => {
    termRef.current?.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
  }, []);

  const { write, resize } = usePty(tile.ptyId, onData, onExit);

  // Keep a ref so keyboard capture always uses the current write fn
  const writeRef = useRef(write);
  useEffect(() => { writeRef.current = write; }, [write]);

  // Command history integration
  const [showHistory, setShowHistory] = useState(false);
  const historyEntries = useCommandHistoryStore(s => (tile.ptyId && s.history[tile.ptyId]) || EMPTY_HISTORY);
  const writeWithHistory = useCallback((data: string) => {
    if (tile.ptyId) {
      if (data === '\r' || data === '\n') {
        useCommandHistoryStore.getState().commitCommand(tile.ptyId);
      } else if (data.length === 1 || !data.startsWith('\x1b')) {
        useCommandHistoryStore.getState().appendBuffer(tile.ptyId, data);
      }
    }
    writeRef.current(data);
  }, [tile.ptyId]);

  // Handle split pane PTY spawning
  const handlePaneSpawned = useCallback((paneId: string, ptyId: string) => {
    setSplits(prev => {
      const updated = prev.map(s => s.id === paneId ? { ...s, ptyId } : s);
      // Persist splits to store
      useCanvasStore.getState().updateTile(tile.id, { splits: updated } as Partial<TerminalTileType>);
      return updated;
    });
  }, [tile.id]);

  // Add split pane
  const addSplit = useCallback((direction: 'horizontal' | 'vertical') => {
    const totalPanes = 1 + splits.length; // main + splits
    if (totalPanes >= MAX_PANES) return;

    const newSplit: TerminalSplit = {
      id: crypto.randomUUID(),
      direction,
      ratio: 0.5,
      ptyId: '', // will be assigned on spawn
    };

    const updated = [...splits, newSplit];
    setSplits(updated);
    useCanvasStore.getState().updateTile(tile.id, { splits: updated } as Partial<TerminalTileType>);
  }, [splits, tile.id]);

  // Track active pane (0 = main, 1+ = splits)
  const [activePaneIdx, setActivePaneIdx] = useState(0);

  // Keyboard handler for splits + Ctrl+Arrow navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle if this tile is focused
      const store = useCanvasStore.getState();
      if (store.focusedTile !== tile.id) return;

      // Ctrl+Shift+D — horizontal split
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        e.stopPropagation();
        addSplit('horizontal');
      }
      // Ctrl+D — vertical split (only when no text selected in terminal)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'd') {
        if (splits.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          addSplit('vertical');
        }
      }

      // Ctrl+Arrow — navigate between panes
      if (splits.length > 0 && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        const totalPanes = 1 + splits.length;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setActivePaneIdx(i => (i + 1) % totalPanes);
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setActivePaneIdx(i => (i - 1 + totalPanes) % totalPanes);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tile.id, addSplit, splits.length]);

  // Initialize xterm for main pane
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const terminal = new Terminal({
      theme: getXtermTheme(),
      fontFamily: fonts.mono,
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not available
    }

    terminal.open(containerRef.current);
    // Attach direct keyboard capture (bypasses xterm's broken textarea focus)
    const detachKb = attachKeyboardCapture(
      containerRef.current,
      (data) => writeWithHistory(data),
    );
    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      containerRef.current?.focus({ preventScroll: true });
    });

    termRef.current = terminal;
    fitRef.current = fitAddon;

    // Also wire xterm's native onData (in case textarea focus ever works)
    terminal.onData((data) => writeWithHistory(data));

    return () => {
      cancelAnimationFrame(rafId);
      detachKb();
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // React to theme changes
  useEffect(() => {
    const unsub = useThemeStore.subscribe(() => {
      if (termRef.current) {
        termRef.current.options.theme = getXtermTheme();
      }
    });
    return unsub;
  }, []);

  // Spawn PTY for main pane
  useEffect(() => {
    if (spawnedRef.current || tile.ptyId || !termRef.current) return;
    spawnedRef.current = true;

    const term = termRef.current;
    ptySpawn({
      cwd: tile.cwd || undefined,
      cols: term.cols,
      rows: term.rows,
    }).then((id) => {
      useCanvasStore.getState().updateTile(tile.id, { ptyId: id } as Partial<TerminalTileType>);
    }).catch((err) => {
      term.write(`\x1b[31mFailed to spawn PTY: ${err}\x1b[0m\r\n`);
    });
  }, [tile.id, tile.ptyId, tile.cwd]);

  // Resize observer for main pane
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        if (fitRef.current && termRef.current) {
          fitRef.current.fit();
          resize(termRef.current.cols, termRef.current.rows);
        }
      }, 100);
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [resize]);

  // No splits — render single pane (original behavior)
  if (splits.length === 0) {
    return (
      <div style={{ width: '100%', height: '100%', position: 'relative', background: colors.bg }}>
        <div
          ref={containerRef}
          style={{
            width: '100%',
            height: '100%',
            padding: '4px 0 0 4px',
            cursor: 'text',
          }}
        />

        {/* Command history button */}
        {historyEntries.length > 0 && (
          <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 5 }}>
            <button
              onClick={() => setShowHistory(h => !h)}
              style={{
                width: 20, height: 20,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: alpha(colors.surfaceLow, 80),
                border: `1px solid ${colors.outlineGhost}`,
                borderRadius: radius.sm,
                color: colors.onSurfaceVariant,
                cursor: 'pointer',
                fontSize: 10,
                fontFamily: fonts.mono,
                backdropFilter: 'blur(8px)',
              }}
              title={`Command history (${historyEntries.length})`}
            >
              &#9776;
            </button>
            {showHistory && (
              <div style={{
                position: 'absolute', top: 24, right: 0,
                width: 280, maxHeight: 200,
                overflowY: 'auto',
                background: colors.surfaceLow,
                backdropFilter: 'blur(16px)',
                border: `1px solid ${colors.outlineGhost}`,
                borderRadius: radius.md,
                padding: '4px 0',
                zIndex: 10,
              }}>
                {[...historyEntries].reverse().map((cmd, i) => (
                  <button
                    key={`${cmd}-${i}`}
                    onClick={() => {
                      writeRef.current(cmd + '\r');
                      setShowHistory(false);
                    }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '4px 8px', border: 'none',
                      background: 'transparent', cursor: 'pointer',
                      color: colors.onSurfaceVariant,
                      ...typography.labelSm, fontFamily: fonts.mono,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      transition: `background ${motion.hover}`,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = colors.surfaceHigh}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    {cmd}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Determine layout direction from first split
  const firstDirection = splits[0]?.direction || 'horizontal';
  const isVerticalStack = firstDirection === 'horizontal'; // horizontal split = panes stacked vertically

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: isVerticalStack ? 'column' : 'row',
      background: colors.bg,
    }}>
      {/* Main pane */}
      <div
        ref={containerRef}
        onClick={() => setActivePaneIdx(0)}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          padding: '4px 0 0 4px',
          outline: activePaneIdx === 0 ? `1px solid ${colors.primary}` : 'none',
          outlineOffset: -1,
        }}
      />

      {/* Split panes */}
      {splits.map(split => (
        <div key={split.id} style={{
          display: 'flex',
          flexDirection: split.direction === 'horizontal' ? 'column' : 'row',
        }}>
          {/* Divider */}
          <div style={{
            background: colors.primary,
            flexShrink: 0,
            ...(split.direction === 'horizontal'
              ? { height: 2, width: '100%' }
              : { width: 2, height: '100%' }),
          }} />

          {/* Pane */}
          <div
            onClick={() => setActivePaneIdx(splits.indexOf(split) + 1)}
            style={{
              flex: 1, minWidth: 0, minHeight: 0,
              outline: activePaneIdx === splits.indexOf(split) + 1 ? `1px solid ${colors.primary}` : 'none',
              outlineOffset: -1,
            }}
          >
            <TerminalPane
              paneId={split.id}
              ptyId={split.ptyId || undefined}
              cwd={tile.cwd}
              tileId={tile.id}
              onPtySpawned={handlePaneSpawned}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
