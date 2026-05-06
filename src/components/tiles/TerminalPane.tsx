import { useRef, useEffect, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useThemeStore } from '@/stores/themeStore';
import { usePty } from '@/hooks/usePty';
import { ptySpawn } from '@/utils/ipc';
import { colors, fonts } from '@/design/tokens';
import { attachKeyboardCapture } from './xtermInput';

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
    black: light ? '#2d3228' : t.bg,
    brightBlack: light ? '#888888' : t.fg + '55',
    white: light ? '#e0e0e0' : t.fg + 'c4',
    brightWhite: light ? '#ffffff' : t.fg,
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

interface TerminalPaneProps {
  paneId: string;
  ptyId?: string;
  cwd: string;
  tileId: string;
  onPtySpawned: (paneId: string, ptyId: string) => void;
}

export function TerminalPane({ paneId, ptyId, cwd, tileId, onPtySpawned }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);

  const onData = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);

  const onExit = useCallback(() => {
    termRef.current?.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
  }, []);

  const { write, resize } = usePty(ptyId, onData, onExit);

  // Keep a ref so keyboard capture always uses the current write fn
  const writeRef = useRef(write);
  useEffect(() => { writeRef.current = write; }, [write]);

  // Initialize xterm
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

    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon?.dispose());
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not available
      webglAddon = null;
    }

    terminal.open(containerRef.current);
    const detachKb = attachKeyboardCapture(
      containerRef.current,
      (data) => writeRef.current(data),
    );
    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      containerRef.current?.focus({ preventScroll: true });
    });

    termRef.current = terminal;
    fitRef.current = fitAddon;

    terminal.onData((data) => writeRef.current(data));

    return () => {
      cancelAnimationFrame(rafId);
      detachKb();
      // WebglAddon must be disposed BEFORE terminal — otherwise its render
      // loop fires once more on a torn-down store and throws
      // `_store._isDisposed` of undefined.
      webglAddon?.dispose();
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

  // Spawn PTY
  useEffect(() => {
    if (spawnedRef.current || ptyId || !termRef.current) return;
    spawnedRef.current = true;

    const term = termRef.current;
    ptySpawn({
      cwd: cwd || undefined,
      cols: term.cols,
      rows: term.rows,
    }).then((id) => {
      onPtySpawned(paneId, id);
    }).catch((err) => {
      term.write(`\x1b[31mFailed to spawn PTY: ${err}\x1b[0m\r\n`);
    });
  }, [paneId, ptyId, cwd, tileId, onPtySpawned]);

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

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: colors.bg,
        padding: '4px 0 0 4px',
        cursor: 'text',
      }}
    />
  );
}
