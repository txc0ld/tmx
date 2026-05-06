import { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useCanvasStore } from '@/stores/canvasStore';
import { useThemeStore } from '@/stores/themeStore';
import { usePty } from '@/hooks/usePty';
import { ptySpawn, ptyWrite } from '@/utils/ipc';
import { isWindows } from '@/utils/platform';
import { colors, fonts, spacing, typography, radius } from '@/design/tokens';
import { attachKeyboardCapture } from './xtermInput';
import type { RunnerTile as RunnerTileType } from '@/types';

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
    cursorAccent: light ? '#2d3228' : t.bg,
    selectionBackground: t.accent + '26',
  };
}

interface RunnerTileProps {
  tile: RunnerTileType;
}

const STATUS_ICONS: Record<string, string> = {
  idle: '-',
  running: '...',
  pass: 'OK',
  fail: 'X',
};

const STATUS_LABEL_COLORS: Record<string, string> = {
  idle: colors.secondary,
  running: colors.primary,
  pass: colors.primary,
  fail: colors.onSurfaceVariant,
};

function buildRunnerScript(command: string): string {
  if (isWindows()) {
    return [
      '$global:LASTEXITCODE = $null',
      command,
      '$txSucceeded = $?',
      '$txExit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($txSucceeded) { 0 } else { 1 }',
      'Write-Output "__TX_EXIT:$txExit"',
      'exit $txExit',
      '',
    ].join('\r\n');
  }

  return `${command}\ntx_exit=$?\nprintf '\\n__TX_EXIT:%s\\n' "$tx_exit"\nexit "$tx_exit"\n`;
}

export function RunnerTile({ tile }: RunnerTileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const [command, setCommand] = useState(tile.command);

  const onData = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);

  const onExit = useCallback(() => {
    termRef.current?.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    // Determine pass/fail by checking last output for common patterns
    const store = useCanvasStore.getState();
    const wireData = store.wireData[tile.ptyId || ''] || '';
    const lower = wireData.toLowerCase();
    const exitMatch = wireData.match(/__TX_EXIT:(\d+)/);
    const failed = exitMatch
      ? Number(exitMatch[1]) !== 0
      : lower.includes('fail') || lower.includes('error') || lower.includes('exit code 1');
    const status = failed ? 'fail' : 'pass';
    store.updateTile(tile.id, { status, ptyId: undefined } as Partial<RunnerTileType>);
  }, [tile.id, tile.ptyId]);

  const { write, resize } = usePty(tile.ptyId, onData, onExit);

  // Keep a ref so keyboard capture always uses the current write fn
  const writeRef = useRef(write);
  useEffect(() => { writeRef.current = write; }, [write]);

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const terminal = new Terminal({
      theme: getXtermTheme(),
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: false,
      cursorStyle: 'bar',
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    const detachKb = attachKeyboardCapture(
      containerRef.current,
      (data) => writeRef.current(data),
    );
    const rafId = requestAnimationFrame(() => fitAddon.fit());

    termRef.current = terminal;
    fitRef.current = fitAddon;

    terminal.onData(data => writeRef.current(data));

    return () => {
      cancelAnimationFrame(rafId);
      detachKb();
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme changes
  useEffect(() => {
    const unsub = useThemeStore.subscribe(() => {
      if (termRef.current) {
        termRef.current.options.theme = getXtermTheme();
      }
    });
    return unsub;
  }, []);

  // Resize observer
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


  const handleRun = async () => {
    if (tile.status === 'running' || !command.trim()) return;

    // Warn if command looks like it contains secrets
    const SECRET_PATTERNS = /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|BEARER|AUTH)[=:\s]/i;
    if (SECRET_PATTERNS.test(command)) {
      const proceed = confirm('Command appears to contain a secret and will be saved to disk. Continue?');
      if (!proceed) return;
    }

    // Save command to tile
    useCanvasStore.getState().updateTile(tile.id, { command, status: 'running' } as Partial<RunnerTileType>);

    // Clear terminal
    termRef.current?.clear();

    try {
      // Spawn a shell, then write the command to it
      const term = termRef.current;
      const id = await ptySpawn({
        cwd: tile.cwd || undefined,
        cols: term?.cols,
        rows: term?.rows,
      });
      useCanvasStore.getState().updateTile(tile.id, { ptyId: id } as Partial<RunnerTileType>);
      // Write the command followed by exit so we detect completion
      setTimeout(() => {
        ptyWrite(id, buildRunnerScript(command.trim())).catch((err) => {
          termRef.current?.write(`\x1b[31mFailed to write command: ${err}\x1b[0m\r\n`);
          useCanvasStore.getState().updateTile(tile.id, { status: 'fail' } as Partial<RunnerTileType>);
        });
      }, 200);
    } catch (err) {
      termRef.current?.write(`\x1b[31mFailed to spawn: ${err}\x1b[0m\r\n`);
      useCanvasStore.getState().updateTile(tile.id, { status: 'fail' } as Partial<RunnerTileType>);
    }
  };

  const statusIcon = STATUS_ICONS[tile.status] || '-';
  const statusColor = STATUS_LABEL_COLORS[tile.status] || colors.secondary;
  const isIdle = tile.status === 'idle' || tile.status === 'pass' || tile.status === 'fail';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: spacing.xs,
        padding: `4px ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineGhost}`,
        flexShrink: 0,
      }}>
        {/* Status badge */}
        <span style={{
          ...typography.labelSm,
          color: statusColor,
          background: `${statusColor}18`,
          padding: '1px 6px',
          borderRadius: radius.sm,
          fontWeight: 600,
          fontSize: '0.5625rem',
          textTransform: 'uppercase',
          minWidth: 28,
          textAlign: 'center',
          boxShadow: tile.status === 'running' ? `0 0 6px ${statusColor}` : 'none',
        }}>
          {statusIcon}
        </span>

        {/* Command input */}
        <input
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleRun(); }}
          disabled={tile.status === 'running'}
          placeholder="Command (e.g. npm test)"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            color: colors.onSurfaceVariant,
            fontFamily: fonts.mono,
            fontSize: '0.75rem',
            outline: 'none',
            opacity: isIdle ? 1 : 0.6,
          }}
        />

        {/* Run button */}
        <button
          onClick={handleRun}
          disabled={tile.status === 'running'}
          style={{
            background: tile.status === 'running' ? colors.surfaceHigh : colors.primary,
            border: 'none',
            borderRadius: radius.sm,
            color: tile.status === 'running' ? colors.secondary : colors.bg,
            fontFamily: fonts.mono,
            fontSize: '0.625rem',
            fontWeight: 600,
            padding: '2px 10px',
            cursor: tile.status === 'running' ? 'not-allowed' : 'pointer',
            height: 22,
          }}
        >
          {tile.status === 'running' ? 'Running' : 'Run'}
        </button>
      </div>

      {/* Terminal output */}
      <div
        ref={containerRef}
        style={{ flex: 1, background: colors.bg, padding: '4px 0 0 4px' }}
      />
    </div>
  );
}
