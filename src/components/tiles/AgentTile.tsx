import { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useCanvasStore } from '@/stores/canvasStore';
import { useThemeStore } from '@/stores/themeStore';
import { usePty } from '@/hooks/usePty';
import { agentSpawn, onAgentStatus, ptyWrite } from '@/utils/ipc';
import { colors, fonts, spacing, typography, radius, agentColors, alpha } from '@/design/tokens';
import { attachKeyboardCapture } from './xtermInput';
import { cleanPtyOutput } from '@/utils/ansi';
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
      fontSize: 13,
      lineHeight: 1.3,
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
    }).then(async (id) => {
      useCanvasStore.getState().updateTile(tile.id, { ptyId: id, status: 'working' } as Partial<AgentTileType>);
      // Pipeline role-prompt injection (Phase 2c-iii post-script): if the
      // tile's mode is one of the four pipeline roles, write the bundled
      // role prompt as the agent's first input. Skipped for stub modes
      // and for non-pipeline agent tiles. Awaits before agent-memory
      // injection so the role prompt always lands first.
      const { injectRolePromptForAgent } = await import('@/pipeline/role-prompt-injection');
      await injectRolePromptForAgent({ ptyId: id, mode: tile.mode });

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

      {/* Terminal */}
      <div
        ref={containerRef}
        style={{ flex: 1, background: colors.bg, padding: '4px 0 0 4px', cursor: 'text' }}
      />
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
