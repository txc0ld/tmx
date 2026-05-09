import { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useCanvasStore } from '@/stores/canvasStore';
import { useThemeStore } from '@/stores/themeStore';
import { useToastStore } from '@/stores/toastStore';
import { usePty } from '@/hooks/usePty';
import { agentSpawn, onAgentStatus, ptyKill, ptyWrite } from '@/utils/ipc';
import { colors, fonts, spacing, typography, radius, agentColors, alpha } from '@/design/tokens';
import { attachKeyboardCapture } from './xtermInput';
import { cleanPtyOutput } from '@/utils/ansi';
import { ConfirmableButton } from '@/components/pipeline/ConfirmableButton';
import type { AgentTile as AgentTileType } from '@/types';

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
  };
}

interface AgentTileProps {
  tile: AgentTileType;
}

const STATUS_COLORS: Record<string, string> = {
  spawning: colors.secondary,
  idle: colors.onSurfaceVariant,
  working: colors.primary,
  done: colors.green,
  error: colors.red,
};

export function AgentTile({ tile }: AgentTileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [customCmd, setCustomCmd] = useState(tile.command || '');

  // ─── Auto-complete detection ─────────────────────────────────────────
  // Fires the agent's status → 'done' without requiring the process to exit,
  // so agent-chain wires can trigger after each response.
  //
  // Two triggers, both optional and configurable per-tile:
  //  1. DONE sentinel — the agent (or user) writes "DONE" / "✅ DONE" /
  //     "[DONE]" on its own line. Fires immediately.
  //  2. Idle — no PTY output for `idleThresholdMs` (default 8s) after
  //     the agent has produced substantial output since its last transition.
  const idleTimerRef = useRef<number | null>(null);
  const sentinelFiredRef = useRef(false);
  const bytesSinceResetRef = useRef(0);
  const spawnedAtRef = useRef<number>(Date.now());

  const autoComplete = tile.autoComplete !== false; // default on
  const idleMs = tile.idleThresholdMs ?? 8000;
  const sentinelSource = tile.doneSentinel
    ?? String.raw`(?:^|\n)\s*(?:[✅✓]\s*|\[|##\s*)?DONE(?:\]|!|\.)?\s*(?:$|\n|\r)`;

  const markDoneFromAuto = useCallback((reason: 'sentinel' | 'idle') => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    const current = (store.tiles[pid] || []).find(t => t.id === tile.id) as AgentTileType | undefined;
    if (!current || current.status !== 'working') return;
    // Visually tag the agent's output so the user knows why the wire fired
    const marker = reason === 'sentinel'
      ? '\r\n\x1b[90m[auto-complete: DONE sentinel detected]\x1b[0m\r\n'
      : `\r\n\x1b[90m[auto-complete: idle > ${Math.round(idleMs / 1000)}s]\x1b[0m\r\n`;
    termRef.current?.write(marker);
    store.updateTile(tile.id, { status: 'done' } as Partial<AgentTileType>);
  }, [tile.id, idleMs]);

  const onData = useCallback((data: string) => {
    termRef.current?.write(data);
    termRef.current?.scrollToBottom();

    if (!autoComplete) return;

    // Grace period: ignore the first 3 seconds after spawn (welcome banners,
    // initial prompt render etc. shouldn't count as work).
    const elapsedSinceSpawn = Date.now() - spawnedAtRef.current;
    if (elapsedSinceSpawn < 3000) return;

    bytesSinceResetRef.current += data.length;

    // If we're currently 'done' and fresh output arrives, reset to 'working'
    // so the next idle/sentinel cycle can fire again on the next response.
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    const current = (store.tiles[pid] || []).find(t => t.id === tile.id) as AgentTileType | undefined;
    if (current && current.status === 'done') {
      sentinelFiredRef.current = false;
      bytesSinceResetRef.current = data.length;
      store.updateTile(tile.id, { status: 'working' } as Partial<AgentTileType>);
    }

    // Sentinel: literal "DONE" (case-insensitive) on its own line
    if (!sentinelFiredRef.current) {
      try {
        const re = new RegExp(sentinelSource, 'im');
        if (re.test(data)) {
          sentinelFiredRef.current = true;
          // Brief delay so the engine sees the final output in wireData
          setTimeout(() => markDoneFromAuto('sentinel'), 250);
          return;
        }
      } catch { /* bad regex — silently skip */ }
    }

    // Idle: reset timer on every output chunk, fire after silence
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      // Require substantial output since last reset to avoid firing on
      // transient status lines / boot messages.
      if (bytesSinceResetRef.current >= 50) {
        markDoneFromAuto('idle');
      }
    }, idleMs);
  }, [autoComplete, idleMs, sentinelSource, tile.id, markDoneFromAuto]);

  const onExit = useCallback(() => {
    termRef.current?.write('\r\n\x1b[90m[agent exited]\x1b[0m\r\n');
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    useCanvasStore.getState().updateTile(tile.id, { status: 'done' } as Partial<AgentTileType>);
  }, [tile.id]);

  // Clean up idle timer on unmount
  useEffect(() => () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
  }, []);

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
      // 12px gives ~92 cols at the Anthropic Trio template's 720-wide
      // tile — enough headroom for Claude Code's status bar + tip box
      // without the box-frame overflowing into mangled wraps.
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
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

    terminal.onData(data => writeRef.current(data));

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

  // Subscribe to agent status events
  useEffect(() => {
    if (!tile.ptyId) return;
    const unsub = onAgentStatus(({ id, status }) => {
      if (id === tile.ptyId) {
        useCanvasStore.getState().updateTile(tile.id, { status: status as AgentTileType['status'] } as Partial<AgentTileType>);
      }
    });
    return () => { unsub.then(fn => fn()); };
  }, [tile.id, tile.ptyId]);

  // Spawn agent
  useEffect(() => {
    if (spawnedRef.current || tile.ptyId) return;
    spawnedRef.current = true;
    spawnedAtRef.current = Date.now(); // anchor for the 3s grace period
    bytesSinceResetRef.current = 0;
    sentinelFiredRef.current = false;

    const agentTypeMap: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
    const agentType = agentTypeMap[tile.agent] || 'Claude';

    agentSpawn({
      agentType: agentType as 'Claude' | 'Codex' | 'Gemini',
      cwd: tile.cwd || '~',
      ...(tile.command ? { customCommand: tile.command } : {}),
      // Pipeline-spawned tiles carry `pipelineRunId` (set by `instantiate.ts`).
      // The flag tells Rust to append `--dangerously-skip-permissions` to
      // Claude Code so the run can `git add`, `npm install`, `Write(...)`,
      // etc., without hitting the interactive consent prompt. The worktree
      // boundary + guardrails hook + capabilities lists are the safety net.
      // Manual user-spawned agent tiles omit `pipelineRunId` and keep the
      // prompt — that's a normal interactive session.
      ...(tile.pipelineRunId ? { pipelineRun: true } : {}),
    }).then(async (id) => {
      useCanvasStore.getState().updateTile(tile.id, { ptyId: id, status: 'working' } as Partial<AgentTileType>);
      // Sync PTY size with xterm BEFORE the agent paints anything. The
      // PTY default is 80x24 but xterm fits to the tile (~92x40 at the
      // template size). Without this, Claude Code positions cursor for
      // its assumed cols, xterm renders at actual cols, and you get
      // overlapping text + mangled box-drawing — exactly the "glitchy
      // consoles" the user reported.
      if (termRef.current && fitRef.current) {
        try { fitRef.current.fit(); } catch { /* container detached */ }
        const cols = termRef.current.cols;
        const rows = termRef.current.rows;
        if (cols > 0 && rows > 0) {
          // The Rust IPC for ptyResize lives on `usePty`'s `resize` callback.
          // Lazy import to avoid a circular initialization order with the
          // hook's effect chain.
          const { ptyResize } = await import('@/utils/ipc');
          ptyResize(id, cols, rows).catch(() => { /* PTY may have raced */ });
        }
      }
      // Pipeline role-prompt injection (Phase 2c-iii post-script): if the
      // tile's mode is one of the four pipeline roles, write the bundled
      // role prompt as the agent's first input. Skipped for stub modes
      // and for non-pipeline agent tiles. Awaits before agent-memory
      // injection so the role prompt always lands first.
      const { injectRolePromptForAgent } = await import('@/pipeline/role-prompt-injection');
      // Phase 3b.7: pass the agent's cwd as `projectDir` so the injection
      // step can read `<projectDir>/INVARIANTS.md` and substitute its content
      // into the role prompt's `{INVARIANTS_PLACEHOLDER}` token. Re-read at
      // spawn time so users editing INVARIANTS.md mid-run see the new content
      // on next role spawn.
      await injectRolePromptForAgent({ ptyId: id, mode: tile.mode, projectDir: tile.cwd });

      // Inject agent memory context once the agent is ready. Ready =
      // 1.2 s of PTY silence after any output arrives, indicating the
      // agent has finished its startup banner and is sitting at a prompt.
      // Fallback hard ceiling of 15 s prevents hanging on a silent agent.
      const { useAgentMemoryStore } = await import('@/stores/agentMemoryStore');
      const { ptyWrite: ptyWriteCtx, onPtyOutput } = await import('@/utils/ipc');
      const pid = useCanvasStore.getState().activeProject;
      const memory = useAgentMemoryStore.getState().getMemory(pid);
      if (memory) {
        // Strip control chars and ANSI escapes to prevent terminal injection.
        const safeMem = memory.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

        let injected = false;
        let silenceTimer: ReturnType<typeof setTimeout> | null = null;
        let cleanupOutput: (() => void) | null = null;
        const fallbackTimer = setTimeout(() => inject(), 15_000);

        const inject = () => {
          if (injected) return;
          injected = true;
          if (silenceTimer !== null) clearTimeout(silenceTimer);
          clearTimeout(fallbackTimer);
          cleanupOutput?.();
          ptyWriteCtx(id, `Project context: ${safeMem}`).catch(() => {});
          setTimeout(() => ptyWriteCtx(id, '\r').catch(() => {}), 300);
        };

        onPtyOutput(({ id: evId }) => {
          if (evId !== id || injected) return;
          if (silenceTimer !== null) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => inject(), 1200);
        }).then(fn => {
          if (injected) { fn(); return; }
          cleanupOutput = fn;
        });
      }
    }).catch(err => {
      const msg = String(err);
      termRef.current?.write(`\x1b[1m--- Agent Spawn Failed ---\x1b[0m\r\n\r\n`);
      termRef.current?.write(`${msg}\r\n\r\n`);
      if (msg.toLowerCase().includes('not found')) {
        termRef.current?.write(`The '${tile.agent}' CLI is not installed or not in PATH.\r\n`);
        termRef.current?.write(`Install it, or click the gear icon to set a custom command.\r\n`);
      }
      useCanvasStore.getState().updateTile(tile.id, { status: 'error' } as Partial<AgentTileType>);
    });
  }, [tile.id, tile.ptyId, tile.agent, tile.cwd]);

  // Resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        if (fitRef.current && termRef.current) {
          fitRef.current.fit();
          const cols = termRef.current.cols;
          const rows = termRef.current.rows;
          if (cols > 0 && rows > 0) {
            resize(cols, rows);
          }
        }
      }, 100);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [resize]);

  // Zoom-refit — when the canvas transform.scale changes (pinch / wheel zoom),
  // the tile's logical pixel size doesn't change so ResizeObserver never fires,
  // but the visual size does — and Claude Code's box-drawing assumes the
  // pre-zoom col count, producing overlapping text. Subscribe directly to the
  // store (not a selector hook) so we don't re-render the tile on every
  // transform tick. Debounce 120ms so a rapid wheel-zoom gesture coalesces
  // into one fit + ptyResize at the final scale.
  const zoomTimerRef = useRef<number | null>(null);
  useEffect(() => {
    let lastScale = useCanvasStore.getState().transforms[
      useCanvasStore.getState().activeProject
    ]?.scale;
    const unsub = useCanvasStore.subscribe((s) => {
      const scale = s.transforms[s.activeProject]?.scale;
      if (scale === lastScale) return;
      lastScale = scale;
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = window.setTimeout(() => {
        if (!fitRef.current || !termRef.current) return;
        try { fitRef.current.fit(); } catch { /* container detached */ }
        const cols = termRef.current.cols;
        const rows = termRef.current.rows;
        if (cols > 0 && rows > 0) {
          resize(cols, rows);
        }
      }, 120);
    });
    return () => {
      unsub();
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    };
  }, [resize]);


  // Elapsed timer — use getState() to avoid effect cascade from tile.elapsed dep
  useEffect(() => {
    if (tile.status !== 'working') return;
    const interval = setInterval(() => {
      const store = useCanvasStore.getState();
      const pid = store.activeProject;
      const current = (store.tiles[pid] || []).find(t => t.id === tile.id) as AgentTileType | undefined;
      if (current) {
        store.updateTile(tile.id, { elapsed: current.elapsed + 1 } as Partial<AgentTileType>);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [tile.id, tile.status]);

  const handleSaveCommand = () => {
    useCanvasStore.getState().updateTile(tile.id, { command: customCmd } as Partial<AgentTileType>);
    setConfigOpen(false);
  };

  // ─── Mini-toolbar actions ────────────────────────────────────────────
  // Kill / Restart / Copy / Clear. Lives just above the xterm container
  // and is hover-revealed so it stays out of the way during normal use.

  const handleKill = useCallback(async () => {
    if (!tile.ptyId) return;
    try {
      await ptyKill(tile.ptyId);
      useToastStore.getState().addToast('Agent killed', 'info');
    } catch (err) {
      useToastStore.getState().addToast(`Kill failed: ${String(err)}`, 'error');
    }
  }, [tile.ptyId]);

  const handleRestart = useCallback(async () => {
    // Kill current PTY (if any) then clear the ptyId so the spawn effect
    // re-fires. spawnedRef guards repeat-spawn within the same id; flip
    // it back to false so the next render's effect runs.
    const oldPty = tile.ptyId;
    spawnedRef.current = false;
    try {
      if (oldPty) {
        await ptyKill(oldPty).catch(() => { /* PTY may already be gone */ });
      }
      // Clear ptyId on the tile so the spawn effect's `tile.ptyId` guard
      // releases and the effect re-runs.
      useCanvasStore.getState().updateTile(tile.id, {
        ptyId: undefined,
        status: 'spawning',
        elapsed: 0,
      } as Partial<AgentTileType>);
      useToastStore.getState().addToast('Restarting agent…', 'info');
    } catch (err) {
      useToastStore.getState().addToast(`Restart failed: ${String(err)}`, 'error');
    }
  }, [tile.id, tile.ptyId]);

  const handleCopyOutput = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      useToastStore.getState().addToast('Output copied', 'success');
    } catch (err) {
      useToastStore.getState().addToast(`Copy failed: ${String(err)}`, 'error');
    }
  }, []);

  const handleClear = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    useToastStore.getState().addToast('Output cleared', 'info');
  }, []);

  const agentColor = agentColors[tile.agent] || colors.primary;
  const statusColor = STATUS_COLORS[tile.status] || colors.secondary;
  const elapsedMin = Math.floor(tile.elapsed / 60);
  const elapsedSec = tile.elapsed % 60;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Agent header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: spacing.sm,
        padding: `4px ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineGhost}`,
        flexShrink: 0,
      }}>
        <span style={{
          ...typography.labelSm,
          color: agentColor,
          background: alpha(agentColor, 9),
          padding: '1px 6px',
          borderRadius: radius.sm,
          textTransform: 'uppercase',
          fontWeight: 600,
        }}>
          {tile.agent}
        </span>

        <span style={{ ...typography.labelSm, color: colors.secondary }}>
          {tile.model}
        </span>

        <div style={{ flex: 1 }} />

        {/* Status dot */}
        <div style={{
          width: 6, height: 6, borderRadius: radius.full,
          background: statusColor,
          boxShadow: tile.status === 'working' ? `0 0 6px ${statusColor}` : 'none',
        }} />

        {/* Elapsed */}
        <span style={{ ...typography.labelSm, color: colors.secondary, fontFamily: fonts.mono }}>
          {elapsedMin}m {elapsedSec}s
        </span>

        {/* Pipe context from incoming wires */}
        <PipeContextButton
          tileId={tile.id}
          ptyId={tile.ptyId}
          autoPipe={tile.autoPipe === true}
          autoPipeIdleMs={tile.autoPipeIdleMs ?? 2000}
          autoPromptTemplate={tile.autoPromptTemplate ?? ''}
        />

        {/* Config gear */}
        <button
          onClick={() => setConfigOpen(!configOpen)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: colors.onSurfaceVariant, fontSize: 12, padding: 0,
            fontFamily: fonts.mono,
          }}
        >
          ⚙
        </button>
      </div>

      {/* Config panel */}
      {configOpen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: spacing.xs,
          padding: `4px ${spacing.sm}`,
          borderBottom: `1px solid ${colors.outlineGhost}`,
          flexShrink: 0,
        }}>
          <input
            value={customCmd}
            onChange={e => setCustomCmd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSaveCommand(); }}
            placeholder="Custom command (e.g. claude --dangerously-skip-permissions)"
            style={{
              flex: 1, background: 'transparent', border: 'none',
              color: colors.onSurfaceVariant, fontFamily: fonts.mono,
              fontSize: '0.75rem', outline: 'none',
            }}
          />
          <button
            onClick={handleSaveCommand}
            style={{
              background: colors.primary, border: 'none', borderRadius: radius.sm,
              color: colors.bg, fontFamily: fonts.mono, fontSize: '0.625rem',
              padding: '2px 6px', cursor: 'pointer',
            }}
          >
            Save
          </button>
        </div>
      )}

      {/* Mini-toolbar: hover-revealed agent-only quick actions */}
      <AgentMiniToolbar
        isPipeline={Boolean(tile.pipelineRunId)}
        canKill={Boolean(tile.ptyId)}
        onKill={handleKill}
        onRestart={handleRestart}
        onCopy={handleCopyOutput}
        onClear={handleClear}
      />

      {/* Terminal */}
      <div
        ref={containerRef}
        style={{ flex: 1, background: colors.bg, padding: '4px 0 0 4px', cursor: 'text' }}
      />
    </div>
  );
}

// ─── Agent Mini-Toolbar ──────────────────────────────────────────────
// Hover-revealed row of agent-specific quick actions. Stays out of the
// way during normal use (collapsed to 0 height, opacity 0); on hover the
// row expands to ~24px tall and the buttons fade in. Distinct from the
// universal TileShell chrome (pin/clone/detach/template/close) — these
// actions only make sense for an agent tile.

interface MiniToolbarProps {
  isPipeline: boolean;
  canKill: boolean;
  onKill: () => void;
  onRestart: () => void;
  onCopy: () => void;
  onClear: () => void;
}

const PIPELINE_WARNING = '[Pipeline] Killing this agent will mark the run as failed';

const TOOLBAR_BTN_STYLE: React.CSSProperties = {
  width: 22,
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--tx-surface-2)',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  color: 'var(--tx-text-muted)',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
  fontFamily: fonts.mono,
  transition: 'color 120ms ease, background 120ms ease, border-color 120ms ease',
};

function AgentMiniToolbar({ isPipeline, canKill, onKill, onRestart, onCopy, onClear }: MiniToolbarProps) {
  const [hover, setHover] = useState(false);

  const killTitle = (isPipeline ? `${PIPELINE_WARNING}. ` : '') + 'Kill agent process';
  const restartTitle = (isPipeline ? `${PIPELINE_WARNING}. ` : '') + 'Restart agent (kill + re-spawn)';

  return (
    <div
      data-testid="agent-mini-toolbar"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 4,
        padding: hover ? '2px 6px' : 0,
        height: hover ? 24 : 1,
        background: hover ? 'var(--tx-surface-1, transparent)' : 'transparent',
        borderBottom: hover ? '1px solid var(--tx-border, rgba(255,255,255,0.06))' : '1px solid transparent',
        opacity: hover ? 1 : 0,
        overflow: 'hidden',
        transition: 'opacity 140ms ease, height 140ms ease, padding 140ms ease',
        // When collapsed, don't capture pointer events so canvas drag/resize
        // and the surrounding tile still work normally.
        pointerEvents: hover ? 'auto' : 'none',
        flexShrink: 0,
      }}
    >
      <ConfirmableButton
        label="Kill"
        confirmLabel="Kill agent?"
        onConfirm={onKill}
        confirmDelayMs={4000}
        variant="danger"
        title={killTitle}
        disabled={!canKill}
        style={{
          ...TOOLBAR_BTN_STYLE,
          width: 'auto',
          padding: '0 6px',
          fontSize: 10,
        }}
      />
      <ConfirmableButton
        label="Restart"
        confirmLabel="Restart agent?"
        onConfirm={onRestart}
        confirmDelayMs={4000}
        variant="danger"
        title={restartTitle}
        style={{
          ...TOOLBAR_BTN_STYLE,
          width: 'auto',
          padding: '0 6px',
          fontSize: 10,
        }}
      />
      <button
        type="button"
        onClick={onCopy}
        title="Copy all output to clipboard"
        aria-label="Copy output"
        style={TOOLBAR_BTN_STYLE}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--tx-text)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--tx-text-muted)';
        }}
      >
        ⧉
      </button>
      <button
        type="button"
        onClick={onClear}
        title="Clear terminal output and scrollback"
        aria-label="Clear output"
        style={TOOLBAR_BTN_STYLE}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--tx-text)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--tx-text-muted)';
        }}
      >
        ⌫
      </button>
    </div>
  );
}

// ─── Pipe Context Button ─────────────────────────────────────────────
// Pulls accumulated output from any tile wired into this agent (Terminal,
// Runner, or another Agent via context-pipe) and writes it into the
// agent's PTY as a labelled context block.
//
// Glows accent-colored when there's unread data available to pipe — so
// users discover it. After piping, we track 'pipedUpTo' (byte offset)
// per source so the button dims again until more output arrives.
function tailLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join('\n');
}

const MAX_PIPE_LINES = 50;

const EMPTY_WIRES: import('@/types').Wire[] = [];
const EMPTY_TILES: import('@/types').Tile[] = [];

interface PipeBtnProps {
  tileId: string;
  ptyId: string | undefined;
  autoPipe: boolean;
  autoPipeIdleMs: number;
  autoPromptTemplate: string;
}

function PipeContextButton({ tileId, ptyId, autoPipe, autoPipeIdleMs, autoPromptTemplate }: PipeBtnProps) {
  const wires = useCanvasStore(s => s.wires[s.activeProject] ?? EMPTY_WIRES);
  const wireData = useCanvasStore(s => s.wireData);
  const tiles = useCanvasStore(s => s.tiles[s.activeProject] ?? EMPTY_TILES);
  const [pipedOffsets, setPipedOffsets] = useState<Record<string, number>>({});
  // Remember what the buffer looked like when this button first mounted —
  // anything already there is "history", not unread context. Only new output
  // AFTER the wire existed counts as pipeable.
  const initialOffsetsRef = useRef<Record<string, number> | null>(null);

  const incoming = wires.filter(w => w.toTile === tileId && w.wireType === 'context-pipe');

  // Initialize offsets on first render where we have incoming wires
  if (initialOffsetsRef.current === null && incoming.length > 0) {
    const initial: Record<string, number> = {};
    for (const wire of incoming) {
      const src = tiles.find(t => t.id === wire.fromTile);
      if (!src) continue;
      const srcPtyId = 'ptyId' in src ? (src as { ptyId?: string }).ptyId : undefined;
      if (!srcPtyId) continue;
      initial[srcPtyId] = (wireData[srcPtyId] || '').length;
    }
    initialOffsetsRef.current = initial;
  }

  // Compute unread bytes across all incoming wires
  let unreadBytes = 0;
  const sources: { srcPtyId: string; srcName: string; fresh: string; nextOffset: number }[] = [];
  for (const wire of incoming) {
    const src = tiles.find(t => t.id === wire.fromTile);
    if (!src) continue;
    const srcPtyId = 'ptyId' in src ? (src as { ptyId?: string }).ptyId : undefined;
    if (!srcPtyId) continue;
    const data = wireData[srcPtyId] || '';
    const baseline = initialOffsetsRef.current?.[srcPtyId] ?? data.length;
    const offset = Math.max(pipedOffsets[srcPtyId] ?? 0, baseline);
    const fresh = data.slice(offset);
    if (fresh.length > 0) {
      unreadBytes += fresh.length;
      sources.push({ srcPtyId, srcName: src.title || src.type, fresh, nextOffset: offset + fresh.length });
    }
  }

  const hasIncoming = incoming.length > 0;
  const hasUnread = unreadBytes > 0;

  const pipe = useCallback((autoPrompt = '') => {
    if (!ptyId || sources.length === 0) return;
    let context = '';
    const newOffsets = { ...pipedOffsets };
    for (const { srcPtyId, srcName, fresh, nextOffset } of sources) {
      const cleaned = tailLines(cleanPtyOutput(fresh).trim(), MAX_PIPE_LINES);
      if (cleaned) {
        context += `--- Piped from ${srcName} ---\n${cleaned}\n--- End piped context ---\n`;
      }
      newOffsets[srcPtyId] = nextOffset;
    }
    if (context) {
      // Write context, then (if autoPrompt set) append the template + Enter
      // so the agent starts working on it immediately.
      const payload = autoPrompt
        ? `${context}\n${autoPrompt}`
        : context;
      ptyWrite(ptyId, payload).catch(() => {});
      if (autoPrompt) {
        // Small delay so the prompt lands cleanly after the context block
        setTimeout(() => ptyWrite(ptyId, '\r').catch(() => {}), 300);
      }
    }
    setPipedOffsets(newOffsets);
    import('@/stores/toastStore').then(({ useToastStore }) => {
      useToastStore.getState().addToast(
        context
          ? `${autoPrompt ? 'Auto-piped' : 'Piped'} ${context.length} chars${autoPrompt ? ' + prompt' : ''}`
          : 'Nothing to pipe (output was all control codes)',
        context ? 'success' : 'info',
      );
    });
  }, [ptyId, sources, pipedOffsets]);

  const handleClick = () => pipe('');

  // ─── Auto-pipe: fire after source silence ──────────────────────────
  // Stash the latest pipe fn in a ref so the effect's setTimeout can call
  // the up-to-date version without including `pipe` in deps (which would
  // otherwise thrash — `pipe` depends on `sources`, a new array every
  // render, so the effect would cleanup-kill its own timer every tick).
  const pipeRef = useRef(pipe);
  useEffect(() => { pipeRef.current = pipe; }, [pipe]);

  const autoPipeTimerRef = useRef<number | null>(null);
  const lastUnreadRef = useRef(0);
  // Track the last command-submit timestamp we piped for, per source PTY,
  // so we only fire once per command (not continuously during streaming).
  const lastPipedCommandAtRef = useRef<Record<string, number>>({});

  // Subscribe to the latest command-submit map so this effect re-runs when
  // the user presses Enter in a connected terminal.
  const commandSubmittedAt = useCanvasStore(s => s.commandSubmittedAt);

  useEffect(() => {
    if (!autoPipe || !ptyId) {
      if (autoPipeTimerRef.current) { clearTimeout(autoPipeTimerRef.current); autoPipeTimerRef.current = null; }
      lastUnreadRef.current = 0;
      return;
    }
    if (unreadBytes === 0) {
      lastUnreadRef.current = 0;
      return;
    }

    // Only arm the timer if the user has actually submitted a command since
    // our last auto-pipe for at least one source. This prevents firing on
    // ambient output (e.g. a long-running tail) that the user didn't kick off.
    const hasNewCommand = sources.some(({ srcPtyId }) => {
      const submittedAt = commandSubmittedAt[srcPtyId] || 0;
      const lastPipedAt = lastPipedCommandAtRef.current[srcPtyId] || 0;
      return submittedAt > lastPipedAt;
    });
    if (!hasNewCommand) {
      // No command pressed since last pipe — wait for user to actually run something
      if (autoPipeTimerRef.current) { clearTimeout(autoPipeTimerRef.current); autoPipeTimerRef.current = null; }
      return;
    }

    // Every time unreadBytes grows, reset the idle timer — command output
    // is streaming, wait for it to settle before piping
    if (unreadBytes !== lastUnreadRef.current) {
      lastUnreadRef.current = unreadBytes;
      if (autoPipeTimerRef.current) clearTimeout(autoPipeTimerRef.current);
      autoPipeTimerRef.current = window.setTimeout(() => {
        autoPipeTimerRef.current = null;
        // Record which commands we're firing for BEFORE the pipe (sources
        // snapshot here is captured by the ref closure)
        for (const { srcPtyId } of sources) {
          lastPipedCommandAtRef.current[srcPtyId] = commandSubmittedAt[srcPtyId] || Date.now();
        }
        pipeRef.current(autoPromptTemplate);
      }, autoPipeIdleMs);
    }
    // NOTE: no cleanup — timer must survive re-renders. Unmount cleanup below.
  }, [autoPipe, autoPipeIdleMs, autoPromptTemplate, unreadBytes, ptyId, commandSubmittedAt, sources]);

  // Clean up any pending auto-pipe timer on unmount
  useEffect(() => () => {
    if (autoPipeTimerRef.current) clearTimeout(autoPipeTimerRef.current);
  }, []);

  // Don't render at all if no incoming context-pipe wires
  if (!hasIncoming) return null;

  const handleResetAndPipeAll = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!ptyId || !hasIncoming) return;
    // Reset baseline to 0 — includes entire history on next click
    initialOffsetsRef.current = {};
    setPipedOffsets({});
    // Let state flush, then synthetically trigger a pipe
    setTimeout(() => {
      const freshSources: typeof sources = [];
      for (const wire of incoming) {
        const src = tiles.find(t => t.id === wire.fromTile);
        if (!src) continue;
        const srcPtyId = 'ptyId' in src ? (src as { ptyId?: string }).ptyId : undefined;
        if (!srcPtyId) continue;
        const data = wireData[srcPtyId] || '';
        if (data) freshSources.push({ srcPtyId, srcName: src.title || src.type, fresh: data, nextOffset: data.length });
      }
      let ctx = '';
      for (const { srcName, fresh } of freshSources) {
        const cleaned = tailLines(cleanPtyOutput(fresh).trim(), MAX_PIPE_LINES);
        if (cleaned) ctx += `--- Piped from ${srcName} (full history) ---\n${cleaned}\n--- End piped context ---\n`;
      }
      if (ctx) ptyWrite(ptyId, ctx).catch(() => {});
    }, 20);
  };

  const toggleAuto = () => {
    useCanvasStore.getState().updateTile(tileId, { autoPipe: !autoPipe } as Partial<import('@/types').AgentTile>);
  };

  const editAutoPrompt = (e: React.MouseEvent) => {
    e.preventDefault();
    const input = prompt(
      'What should the agent do after auto-pipe? (leave blank = pipe silently)\nExamples:\n- Analyze the output above and explain what happened.\n- If there are errors, fix them.\n- Summarize in one paragraph.',
      autoPromptTemplate,
    );
    if (input === null) return;
    useCanvasStore.getState().updateTile(tileId, { autoPromptTemplate: input } as Partial<import('@/types').AgentTile>);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
    <button
      onClick={handleClick}
      onContextMenu={handleResetAndPipeAll}
      disabled={!hasUnread || !ptyId}
      title={hasUnread
        ? `Click to pipe ${unreadBytes} bytes from ${sources.length} connected tile${sources.length === 1 ? '' : 's'} (right-click to pipe full history)`
        : 'No new context to pipe (right-click to pipe full history)'}
      style={{
        display: 'flex', alignItems: 'center', gap: 3,
        background: hasUnread ? alpha(colors.primary, 20) : 'none',
        border: `1px solid ${hasUnread ? colors.primary : colors.outlineGhost}`,
        borderRadius: radius.sm,
        cursor: hasUnread ? 'pointer' : 'default',
        color: hasUnread ? colors.primary : colors.secondary,
        fontSize: '0.625rem',
        padding: '2px 6px',
        fontFamily: fonts.mono,
        fontWeight: hasUnread ? 600 : 500,
        transition: 'all 150ms ease',
        boxShadow: hasUnread ? `0 0 8px ${alpha(colors.primary, 30)}` : 'none',
        animation: hasUnread ? 'pipe-pulse 2s ease-in-out infinite' : 'none',
      }}
    >
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: hasUnread ? colors.primary : colors.secondary,
      }} />
      Pipe{hasUnread ? ` (${unreadBytes > 999 ? `${Math.round(unreadBytes/1000)}k` : unreadBytes})` : ''}
      <style>{`
        @keyframes pipe-pulse {
          0%, 100% { box-shadow: 0 0 8px ${alpha(colors.primary, 30)}; }
          50%      { box-shadow: 0 0 14px ${alpha(colors.primary, 50)}; }
        }
      `}</style>
    </button>

    {/* Auto toggle — mirrors TodoTile auto-dispatch UX */}
    <button
      onClick={toggleAuto}
      onContextMenu={editAutoPrompt}
      title={autoPipe
        ? `Auto-pipe ON — fires ${autoPipeIdleMs / 1000}s after source goes silent${autoPromptTemplate ? `\n\nAuto-prompt: "${autoPromptTemplate.slice(0, 80)}${autoPromptTemplate.length > 80 ? '...' : ''}"` : '\n\n(silent pipe — right-click to set auto-prompt)'}`
        : 'Auto-pipe OFF — click to enable hands-free piping (right-click to edit auto-prompt)'}
      style={{
        display: 'flex', alignItems: 'center', gap: 3,
        padding: '2px 6px', borderRadius: radius.sm,
        border: `1px solid ${autoPipe ? colors.green : colors.outlineGhost}`,
        background: autoPipe ? alpha(colors.green, 12) : 'transparent',
        color: autoPipe ? colors.green : colors.secondary,
        cursor: 'pointer',
        fontFamily: fonts.mono,
        fontSize: '0.625rem',
        fontWeight: autoPipe ? 600 : 500,
        transition: 'all 150ms ease',
      }}
    >
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: autoPipe ? colors.green : colors.secondary,
      }} />
      Auto
    </button>
    </div>
  );
}
