import { useRef, useEffect, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useThemeStore } from '@/stores/themeStore';
import { usePty } from '@/hooks/usePty';
import { useCanvasZoom } from '@/hooks/useCanvasZoom';
import { ptySpawn } from '@/utils/ipc';
import { colors, fonts } from '@/design/tokens';
import { attachKeyboardCapture } from './xtermInput';

const BASE_FONT_SIZE = 13;

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
  const zoomFitTimerRef = useRef<number | null>(null);
  const canvasZoom = useCanvasZoom();

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
      fontSize: BASE_FONT_SIZE * canvasZoom,
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
    const detachKb = attachKeyboardCapture(
      containerRef.current,
      (data) => writeRef.current(data),
    );
    requestAnimationFrame(() => {
      fitAddon.fit();
      containerRef.current?.focus({ preventScroll: true });
    });

    termRef.current = terminal;
    fitRef.current = fitAddon;

    terminal.onData((data) => writeRef.current(data));

    return () => {
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

  // Zoom change → fontSize bump + debounced fit + PTY resize. Mirrors the
  // logic in TerminalTile so split panes stay crisp too.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const targetFont = BASE_FONT_SIZE * canvasZoom;
    if (term.options.fontSize !== targetFont) {
      term.options.fontSize = targetFont;
    }
    if (zoomFitTimerRef.current) clearTimeout(zoomFitTimerRef.current);
    zoomFitTimerRef.current = window.setTimeout(() => {
      try { fit.fit(); resize(term.cols, term.rows); } catch { /* disposed */ }
    }, 150);
    return () => {
      if (zoomFitTimerRef.current) {
        clearTimeout(zoomFitTimerRef.current);
        zoomFitTimerRef.current = null;
      }
    };
  }, [canvasZoom, resize]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', background: colors.bg }}>
      <div style={{
        position: 'absolute',
        top: 0, left: 0,
        width: `${100 * canvasZoom}%`,
        height: `${100 * canvasZoom}%`,
        transform: `scale(${1 / canvasZoom})`,
        transformOrigin: '0 0',
      }}>
        <div
          ref={containerRef}
          style={{
            width: '100%',
            height: '100%',
            padding: '4px 0 0 4px',
            cursor: 'text',
          }}
        />
      </div>
    </div>
  );
}
