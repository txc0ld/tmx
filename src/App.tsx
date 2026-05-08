import { useEffect, useState, useCallback } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { colors } from '@/design/tokens';
import { screenToCanvas } from '@/utils/layout';
import { agentRunOneshot, httpFetch, loadWorkspace, pipelineInstallSkills, pipelineTelemetryLog, ptyWrite, secretsMask } from '@/utils/ipc';
import { setPipelineTelemetryEmitter, setPipelineLifecycleEmitter, usePipelineStore } from '@/stores/pipelineStore';
import { isTerminalState } from '@/pipeline/state-machine';
import { handleGuardrailsLifecycle } from '@/pipeline/guardrails-lifecycle';
import { handleCapabilitiesLifecycle, activeRoleForState } from '@/pipeline/capabilities-lifecycle';
import { handleFailureBundleLifecycle } from '@/pipeline/failure-bundle-lifecycle';
import { handleBuilderKickLifecycle } from '@/pipeline/builder-kick-lifecycle';
import { makeRunPersistenceLifecycleHandler, hydrateRunsFromDisk } from '@/pipeline/run-persistence';
import { startRedTeamDispatcher } from '@/pipeline/red-team-dispatcher';
import { startDualReviewerDispatcher } from '@/pipeline/dual-reviewer-dispatcher';
import { startSingleReviewerDispatcher } from '@/pipeline/single-reviewer-dispatcher';
import { buildOneshotBrief } from '@/pipeline/brief-builder';
import { startStuckDetector } from '@/pipeline/stuck-detector';
import { startNotifier } from '@/pipeline/notifications';
import { startWebhookNotifier } from '@/pipeline/webhook-notifier';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { getLastStdoutAt, ingestOneshotResult, clearRunBuffers } from '@/pipeline/controller-runtime';
import { startPipelinePtyRouter } from '@/pipeline/pty-router';
import type { PipelineState } from '@/types';
import { resumeFromClarification } from '@/pipeline/scratchpad-watcher';
import type { AgentTile, PipelineRole, PipelineRun } from '@/types';
import { InfiniteCanvas } from '@/components/canvas/InfiniteCanvas';
import { ProjectSidebar } from '@/components/sidebar/ProjectSidebar';
import { TopBar } from '@/components/topbar/TopBar';
import { StatusRail } from '@/components/status/StatusRail';
import { ToastContainer } from '@/components/status/ToastContainer';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { SearchOverlay } from '@/components/canvas/SearchOverlay';
import { SessionTimeline } from '@/components/timeline/SessionTimeline';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { SensitivePathsModal } from '@/components/pipeline/SensitivePathsModal';
import { StartPipelineRunModal } from '@/components/pipeline/StartPipelineRunModal';
import { RunHistoryPanel } from '@/components/pipeline/RunHistoryPanel';
import { RunLogsModal } from '@/components/pipeline/RunLogsModal';
import { launchPipelineRun } from '@/pipeline/launch';
import { useToastStore } from '@/stores/toastStore';
import type { TileType, Tile } from '@/types';
import type { TileTemplate } from '@/stores/templateStore';
import '@/stores/clipboardStore'; // Initialize clipboard listener
import { initMcpProjectSync, migrateMcpSecretsToKeychain } from '@/stores/mcpStore';
import { initUsageTracking } from '@/stores/usageStore';

export const TILE_DEFAULTS: Record<TileType, { w: number; h: number }> = {
  terminal: { w: 600, h: 400 },
  agent: { w: 600, h: 450 },
  browser: { w: 600, h: 500 },
  editor: { w: 500, h: 400 },
  diff: { w: 500, h: 400 },
  todo: { w: 320, h: 400 },
  note: { w: 320, h: 300 },
  'pipeline-controller': { w: 600, h: 240 },
  kanban: { w: 700, h: 500 },
  filetree: { w: 280, h: 500 },
  group: { w: 400, h: 300 },
  runner: { w: 600, h: 400 },
  ssh: { w: 500, h: 400 },
  docker: { w: 500, h: 450 },
  git: { w: 350, h: 500 },
  usage: { w: 320, h: 480 },
};

function buildTileDefaults(type: TileType): Record<string, unknown> {
  switch (type) {
    case 'terminal': return { cwd: '~', branch: '', node: '', splits: [] };
    case 'agent': return { agent: 'claude', model: 'opus-4', effort: 'high', mode: 'code', version: '', cwd: '~', branch: '', status: 'idle', elapsed: 0 };
    case 'browser': return { url: 'http://localhost:3000' };
    case 'editor': return { filePath: '', language: 'typescript' };
    case 'diff': return { filePath: '', hunks: [], comments: [] };
    case 'todo': return { items: [] };
    case 'note': return { content: '' };
    case 'kanban': return { columns: [] };
    case 'filetree': return { rootPath: '~', expandedPaths: [] };
    case 'group': return { label: 'Group', childTileIds: [], collapsed: false };
    case 'runner': return { command: '', cwd: '~', status: 'idle', lastOutput: '' };
    case 'ssh': return { host: '', port: 22, user: '', connected: false };
    case 'docker': return { containers: [] };
    case 'git': return { repoPath: '~' };
    case 'usage': return {};
    default: return {};
  }
}

/**
 * Resolve the PTY id of the role currently active for a run (planner during
 * `planning`, builder during `building`, reviewer during `reviewing`).
 * Returns undefined for runs in awaiting/terminal states or when the role's
 * tile has no PTY (one-shot reviewers, unspawned tiles). Mirrors the
 * canvas-store lookup pattern in ClarificationModal::findAgentTile.
 */
function findActiveRolePtyId(run: PipelineRun): string | undefined {
  const role: PipelineRole | null = activeRoleForState(run.state);
  if (!role) return undefined;
  const tileId = run.tiles[role];
  if (!tileId) return undefined;
  const projectTiles = useCanvasStore.getState().tiles;
  for (const list of Object.values(projectTiles)) {
    const arr = list as Tile[] | undefined;
    if (!arr) continue;
    const found = arr.find(t => t.id === tileId);
    if (found && found.type === 'agent') return (found as AgentTile).ptyId;
  }
  return undefined;
}

/**
 * Project IDs whose pipeline runs have already been hydrated from disk this
 * session. Module-level so HMR-driven re-mounts don't re-hydrate (which
 * could race with the lifecycle-handler writes happening for the same
 * runs). The set is intentionally never cleared — once a project's runs
 * are in pipelineStore, they stay there for the session's lifetime.
 */
const hydratedProjectIds = new Set<string>();

/** Test-only: clear the hydration tracker between tests. */
export function _resetHydratedProjectIdsForTest(): void {
  hydratedProjectIds.clear();
}

/**
 * Hydrate one project's persisted runs into pipelineStore if we haven't
 * already done so this session. Pulled out so the boot effect and the
 * project-switch subscription share the same dedup + warning behavior.
 */
function maybeHydrateProject(projectId: string): void {
  if (!projectId) return;
  if (hydratedProjectIds.has(projectId)) return;
  const proj = useProjectStore.getState().projects.find(p => p.id === projectId);
  if (!proj?.cwd) return;
  hydratedProjectIds.add(projectId);
  hydrateRunsFromDisk(proj.cwd).catch(err => {
    console.warn('[pipeline] run hydration failed:', err);
  });
}

function spawnTileAtCenter(type: TileType, overrides: Record<string, unknown> = {}): void {
  const state = useCanvasStore.getState();
  const pid = state.activeProject;
  const transform = state.transforms[pid] || { x: 0, y: 0, scale: 1 };
  const defaults = TILE_DEFAULTS[type];
  const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2, transform);
  // Use project directory for cwd-based tiles
  const project = useProjectStore.getState().projects.find(p => p.id === pid);
  const projectCwd = project?.cwd || '~';
  const cwdOverrides: Record<string, unknown> = {};
  if (['terminal', 'agent', 'runner'].includes(type)) cwdOverrides.cwd = projectCwd;
  if (type === 'filetree') cwdOverrides.rootPath = projectCwd;
  if (type === 'git') cwdOverrides.repoPath = projectCwd;

  const tile = {
    id: crypto.randomUUID(),
    type,
    x: center.x - defaults.w / 2,
    y: center.y - defaults.h / 2,
    w: defaults.w,
    h: defaults.h,
    ...buildTileDefaults(type),
    ...cwdOverrides,
    ...overrides,
  } as Tile;

  state.addTile(tile);
}

export default function App() {
  const projects = useProjectStore(s => s.projects);
  const activeProject = useProjectStore(s => s.active);
  const setActiveProject = useProjectStore(s => s.setActive);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Pipeline launch UX. Two modals interlock:
  //
  //   StartPipelineRunModal — collects goal + branch from the user.
  //   SensitivePathsModal   — opens mid-launch when preflight finds .env / *.pem / etc.
  //
  // The launch flow (`src/pipeline/launch.ts`) is UI-framework-free; it
  // accepts a `confirmSensitivePaths` callback. We wire that callback to a
  // promise-resolver pattern: stash the resolver in state, render the modal,
  // resolve from the modal's button clicks. Keeps the launch flow synchronous-
  // looking while still gating on user input.
  const [pipelineRunOpen, setPipelineRunOpen] = useState(false);
  const [sensitivePathsState, setSensitivePathsState] = useState<{
    paths: string[];
    resolve: (proceed: boolean) => void;
  } | null>(null);
  // Run history register + drill-through to logs. The history panel only
  // selects a run; rendering the actual logs modal lives at the App level
  // so the panel stays a thin lister.
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const [logsTarget, setLogsTarget] = useState<PipelineRun | null>(null);

  // Install per-app subscriptions at mount (not module import). Avoids
  // leaking a duplicate subscription if the module is re-loaded under HMR
  // or the app re-renders at the root.
  useEffect(() => initMcpProjectSync(), []);
  useEffect(() => initUsageTracking(), []);

  // Wire pipelineStore telemetry to the Rust JSONL writer at app boot.
  // The Rust IPC writes to <projectDir>/.terminalx/pipeline-telemetry/<runId>.jsonl
  // so we MUST resolve the project's cwd from projectStore — `ev.projectId`
  // is a UUID, passing it directly would write to a UUID-named directory
  // somewhere undefined on disk. Tests leave the emitter unset → telemetry
  // is a no-op in jsdom.
  useEffect(() => {
    return setPipelineTelemetryEmitter(ev => {
      const project = useProjectStore.getState().projects.find(p => p.id === ev.projectId);
      if (!project?.cwd) return;  // unbound run — nowhere safe to write
      pipelineTelemetryLog({
        projectDir: project.cwd,
        runId: ev.runId,
        line: JSON.stringify(ev),
      }).catch(err => console.warn('[pipeline] telemetry log failed:', err));
    });
  }, []);

  // Pipeline lifecycle handlers — registered as independent listeners
  // (the store fans out to all of them with try/catch isolation per
  // listener). Each handler operates on a disjoint slice of state:
  // - guardrails (Phase 2c-ii.3): worktree's `.claude/settings.json`
  //   `hooks.PreToolUse` entries
  // - capabilities (Phase 2c-ii.4): same file's `permissions.*` keys
  // - failure-bundle (Phase 2c-iii.7): writes a tar.gz on terminal failure
  useEffect(() => {
    const offGuardrails = setPipelineLifecycleEmitter(handleGuardrailsLifecycle);
    const offCapabilities = setPipelineLifecycleEmitter(handleCapabilitiesLifecycle);
    const offFailureBundle = setPipelineLifecycleEmitter(handleFailureBundleLifecycle);
    // Run-record persistence: writes <projectDir>/.terminalx/pipeline-runs/<id>.json
    // on every state transition so reload/crash/HMR don't wipe the run state.
    // Hydration on boot is wired below in the project-load effect.
    const offRunPersistence = setPipelineLifecycleEmitter(makeRunPersistenceLifecycleHandler());
    // Builder kick: deterministic handoff prompt to the Builder PTY when
    // the run enters `building`. The agent-chain wire pipes the planner's
    // tail output too, but it races the state transition; this kick makes
    // the handoff observable and idempotent (per-plan-path dedup).
    const offBuilderKick = setPipelineLifecycleEmitter(handleBuilderKickLifecycle);
    // Phase 3b.2: when a run leaves `awaiting_clarification`, reset the
    // scratchpad-watcher's pendingProbe debounce so the next stagnation
    // window can fire one fresh synthetic clarification (rather than being
    // permanently silenced after the first probe).
    const offScratchpadResume = setPipelineLifecycleEmitter((ev) => {
      if (ev.from === 'awaiting_clarification' && ev.to !== 'awaiting_clarification') {
        resumeFromClarification(ev.runId);
      }
    });
    return () => {
      offGuardrails();
      offCapabilities();
      offFailureBundle();
      offRunPersistence();
      offBuilderKick();
      offScratchpadResume();
    };
  }, []);

  // Audit fix: prune per-run renderer state on terminal transitions.
  // controller-runtime accumulates ptyBuffers + lastStdoutAt per (run, role);
  // scratchpad-watcher and compaction-watcher each carry per-run state.
  // Without this, those maps grow unbounded across a session — every
  // terminal-state transition is the moment to reclaim.
  useEffect(() => {
    const off = setPipelineLifecycleEmitter((ev) => {
      // ev.from / ev.to are PipelineState strings; isTerminalState takes the
      // narrower union but the discriminator is correct at runtime.
      const wasTerminal = isTerminalState(ev.from as PipelineState);
      const isTerminalNow = isTerminalState(ev.to as PipelineState);
      if (!wasTerminal && isTerminalNow) {
        clearRunBuffers(ev.runId);
      }
    });
    return off;
  }, []);

  // Global PTY → controller-runtime router. Without this, every sentinel
  // an agent emits goes nowhere — `ingestPtyChunk` was previously only
  // called from tests. The router maintains a ptyId→{runId,role} map by
  // subscribing to canvasStore (so the lookup is O(1) per chunk) and
  // forwards matching `pty-output` events into the sentinel parser.
  useEffect(() => startPipelinePtyRouter(), []);

  // Polish.1: red-team dispatcher. Closes the spawn-side gap from Phase
  // 3c.6 — without this, complex runs reaching `awaiting_red_team` after
  // Reviewer approval stall (the state-machine half is wired, but no
  // agent fires). On entry, build a brief and run the red-team one-shot;
  // pipe the captured stdout back through `ingestOneshotResult` so the
  // existing controller-runtime parser dispatches `red_team_done` /
  // `red_team_failed` from the embedded sentinel.
  useEffect(() => {
    const stop = startRedTeamDispatcher({
      runRedTeam: async ({ runId, brief }) => {
        const result = await agentRunOneshot({
          agent: 'claude',
          args: ['--print'],
          stdin: brief,
          timeoutSecs: 600,
        });
        ingestOneshotResult({
          runId,
          role: 'red-team',
          stdout: result.stdout,
          exitCode: result.exit_code,
        });
      },
      buildBrief: async (runId) => {
        const run = usePipelineStore.getState().runs[runId];
        if (!run) return '';
        const project = useProjectStore.getState().projects.find(p => p.id === run.projectId);
        return buildOneshotBrief({ role: 'red-team', run, projectDir: project?.cwd });
      },
    });
    return stop;
  }, []);

  // Polish.1 (companion): dual-reviewer dispatcher (Phase 3c.4 ship-gap).
  // The state-machine half lands the run in `awaiting_dual_reviewer` /
  // `awaiting_tiebreaker`, but until this useEffect was added no agent
  // ever fired — runs would stall. Same pattern as the red-team
  // dispatcher above: each invocation is one-shot, sentinels land back
  // through `ingestOneshotResult`.
  useEffect(() => {
    const stop = startDualReviewerDispatcher({
      runOneShotReviewer: async ({ runId, role, provider }) => {
        const agentMap: Record<string, 'claude' | 'codex' | 'gemini'> = {
          opus: 'claude',
          codex: 'codex',
          gemini: 'gemini',
        };
        const run = usePipelineStore.getState().runs[runId];
        if (!run) return;
        const project = useProjectStore.getState().projects.find(p => p.id === run.projectId);
        // Audit fix: build a real brief from the role prompt + run context
        // before invocation. Without this the agent receives empty stdin
        // and reliably aborts the run.
        const brief = await buildOneshotBrief({ role, run, projectDir: project?.cwd });
        if (!brief) {
          console.warn(`[dual-reviewer] role-prompt for ${role} missing — skipping spawn`);
          return;
        }
        const result = await agentRunOneshot({
          agent: agentMap[provider] ?? 'claude',
          args: ['--print'],
          stdin: brief,
          timeoutSecs: 600,
        });
        ingestOneshotResult({
          runId,
          role,
          stdout: result.stdout,
          exitCode: result.exit_code,
        });
      },
    });
    return stop;
  }, []);

  // Single-reviewer dispatcher (STANDARD-run companion to the dual variant).
  // The Anthropic Trio template marks Reviewer with `config.oneshot: true`,
  // so instantiate.ts skips spawning a live Reviewer tile. On entry into
  // `reviewing`, this dispatcher fires `agent_run_oneshot` with the
  // assembled brief and pipes the captured stdout back through
  // `ingestOneshotResult` so the existing controller-runtime parser
  // dispatches the `reviewer_done` / `abort` events.
  useEffect(() => {
    const stop = startSingleReviewerDispatcher({
      runOneShotReviewer: async ({ runId }) => {
        const run = usePipelineStore.getState().runs[runId];
        if (!run) return;
        const project = useProjectStore.getState().projects.find(p => p.id === run.projectId);
        const brief = await buildOneshotBrief({ role: 'reviewer', run, projectDir: project?.cwd });
        if (!brief) {
          console.warn(`[single-reviewer] role-prompt for reviewer missing — skipping spawn`);
          return;
        }
        const result = await agentRunOneshot({
          agent: 'claude',
          args: ['--print'],
          stdin: brief,
          timeoutSecs: 600,
        });
        ingestOneshotResult({
          runId,
          role: 'reviewer',
          stdout: result.stdout,
          exitCode: result.exit_code,
        });
      },
    });
    return stop;
  }, []);

  // Stuck-detector: ticks at 250ms, probes silent runs at 5min, aborts at 8min.
  // DI mirrors the rest of the pipeline — `findActiveRolePtyId` resolves the
  // PTY for whichever role is currently active (planner/builder/reviewer)
  // using the same canvas-store lookup pattern as ClarificationModal.
  useEffect(() => {
    const stop = startStuckDetector({
      getActiveRuns: () => Object.values(usePipelineStore.getState().runs)
        .filter(r => !isTerminalState(r.state))
        .map(r => ({
          id: r.id,
          lastHeartbeatAt: r.lastHeartbeatAt,
          startedAt: r.startedAt,
          ptyId: findActiveRolePtyId(r),
        })),
      getLastStdoutAt,
      probeAgent: async (_runId, ptyId) => { await ptyWrite(ptyId, 'Are you stuck?\n'); },
      abortRun: (runId, reason) => usePipelineStore.getState().dispatch(runId, { type: 'abort', reason }),
      now: () => Date.now(),
    });
    return stop;
  }, []);

  // Phase 2c-iii.3: OS notification + cadence reminders on awaiting_* gates.
  // Title contains run id (and project name when resolvable); body contains
  // the gate state + a 1-line summary. Cumulative re-cadence (15min/1hr/4hr/
  // daily) until the run leaves the awaiting_ state.
  useEffect(() => {
    const stop = startNotifier({
      send: ({ title, body }) => sendNotification({ title, body }),
      now: () => Date.now(),
      getProjectName: (projectId) =>
        useProjectStore.getState().projects.find(p => p.id === projectId)?.name,
    });
    return stop;
  }, []);

  // Phase 2c-iii.4: optional outbound webhook on awaiting_* gate entries.
  // Per-project `webhookUrl` (UI for editing lands in Phase 3); only
  // `https://` URLs are honored. Body is JSON-stringified then passed
  // through `secretsMask` before send. Network failures are swallowed.
  useEffect(() => {
    const stop = startWebhookNotifier({
      getWebhookUrl: (projectId) => {
        const url = useProjectStore.getState().projects.find(p => p.id === projectId)?.webhookUrl;
        if (!url || !url.startsWith('https://')) return null;
        return url;
      },
      getWebhookCadence: (projectId) =>
        useProjectStore.getState().projects.find(p => p.id === projectId)?.webhookCadence,
      httpFetch: async (opts) => {
        const res = await httpFetch(opts);
        return { status: res.status, body: res.body };
      },
      secretsMask,
      deepLink: (runId) => `terminalx://run/${runId}`,
      getProjectName: (projectId) =>
        useProjectStore.getState().projects.find(p => p.id === projectId)?.name,
    });
    return stop;
  }, []);

  // Auto-install pipeline skills (`tx-pipeline-stage-handoff`,
  // `tx-pipeline-reviewer`) into ~/.claude/skills/ on first mount.
  // Idempotent: skills already present are skipped. Errors surface
  // as console.warn but never crash the app.
  useEffect(() => {
    let mounted = true;
    pipelineInstallSkills()
      .then(res => {
        if (!mounted) return;
        if (res.installed.length > 0) {
          console.info('[pipeline] installed skills:', res.installed.join(', '));
        }
        if (res.errors.length > 0) {
          console.warn('[pipeline] skill install errors:', res.errors);
        }
      })
      .catch(err => {
        if (!mounted) return;
        console.warn('[pipeline] skill install failed:', err);
      });
    return () => { mounted = false; };
  }, []);

  // One-shot migration on app start: move any MCP secrets still living
  // in localStorage into the OS keychain, strip them from the JSON
  // config. Idempotent — no-ops after the first run.
  useEffect(() => {
    migrateMcpSecretsToKeychain().then(({ moved }) => {
      if (moved > 0) {
        import('@/stores/toastStore').then(({ useToastStore }) => {
          useToastStore.getState().addToast(
            `Moved ${moved} MCP token${moved === 1 ? '' : 's'} from localStorage to the OS keychain.`,
            'info',
          );
        });
      }
    }).catch(() => { /* keychain unavailable — user sees errors on sync */ });
  }, []);

  // Load persisted projects then init canvas + restore workspace
  useEffect(() => {
    useProjectStore.getState().loadFromDisk().then(async () => {
      const canvasActive = useCanvasStore.getState().activeProject;
      let storeActive = useProjectStore.getState().active;

      // Restore last active project from localStorage (survives crashes)
      if (!storeActive) {
        const cached = localStorage.getItem('tx-active-project');
        if (cached) {
          const projects = useProjectStore.getState().projects;
          if (projects.some(p => p.id === cached)) {
            useProjectStore.getState().setActive(cached);
            storeActive = cached;
          }
        }
      }

      if (!canvasActive && storeActive) {
        useCanvasStore.getState().switchProject(storeActive);
      }

      // Pipeline run-record hydration: walk
      // <projectCwd>/.terminalx/pipeline-runs/*.json for the active project,
      // deserialize, apply the active-state-on-reload policy, and load into
      // pipelineStore.runs. The project-switch subscription below picks up
      // any subsequent project changes during the session.
      maybeHydrateProject(storeActive ?? useProjectStore.getState().active);

      // Restore workspace — try IPC (disk) first, fall back to localStorage cache
      const pid = useCanvasStore.getState().activeProject;
      if (pid) {
        let restored = false;
        try {
          const saved = await loadWorkspace(pid);
          if (saved && saved.tiles && saved.tiles.length > 0) {
            const cs = useCanvasStore.getState();
            cs.loadSnapshot({
              name: '__restore__',
              tiles: saved.tiles,
              wires: saved.wires ?? [],
              transform: saved.transform ?? { x: 0, y: 0, scale: 1 },
              createdAt: '',
            });
            restored = true;
          }
        } catch {
          // Disk load failed
        }

        // Fallback: restore from localStorage crash cache
        if (!restored) {
          try {
            const raw = localStorage.getItem(`tx-cache-${pid}`);
            if (raw) {
              const cache = JSON.parse(raw);
              if (cache.tiles && cache.tiles.length > 0) {
                const cs = useCanvasStore.getState();
                cs.loadSnapshot({
                  name: '__cache_restore__',
                  tiles: cache.tiles,
                  wires: cache.wires ?? [],
                  transform: cache.transform ?? { x: 0, y: 0, scale: 1 },
                  zStack: cache.zStack,
                  createdAt: '',
                });
              }
            }
          } catch {
            // Cache corrupted — start fresh
          }
        }
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Project-switch hydration: the boot effect above only loads runs for the
  // initially-active project. When the user switches via the sidebar, the
  // newly-active project's `<projectCwd>/.terminalx/pipeline-runs/*.json`
  // snapshots need to land in pipelineStore so the run-history panel + the
  // pipeline-pending badge stop being silent. Per-session dedup via the
  // module-level `hydratedProjectIds` Set so we don't race with the
  // single-writer lifecycle handler if the user toggles projects rapidly.
  useEffect(() => {
    return useProjectStore.subscribe((state, prev) => {
      if (state.active && state.active !== prev.active) {
        maybeHydrateProject(state.active);
      }
    });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept ANY keystrokes when xterm's hidden textarea (or any
      // input/textarea) has focus — those keystrokes belong to the terminal.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        // Still allow our global Ctrl/Meta shortcuts and Escape through
        if (!e.ctrlKey && !e.metaKey && e.key !== 'Escape') return;
      }

      // Don't intercept plain keystrokes when focus is inside tile content (terminals, editors, inputs)
      const target = e.target as HTMLElement;
      const inTile = target.closest?.('[data-tile-content]');
      if (inTile && !e.ctrlKey && !e.metaKey && e.key !== 'Escape') return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(p => !p);
      }
      // Ctrl+F — global search across tiles
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !inTile) {
        e.preventDefault();
        setSearchOpen(p => !p);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const store = useCanvasStore.getState();
        if (store.focusModeActive) store.exitFocusMode();
        else if (store.focusedTile) store.enterFocusMode([store.focusedTile]);
      }
      // Ctrl+Tab / Ctrl+Shift+Tab — cycle through tiles
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault();
        const store = useCanvasStore.getState();
        const stack = store.zStack;
        if (stack.length === 0) return;
        const currentIdx = store.focusedTile ? stack.indexOf(store.focusedTile) : -1;
        const dir = e.shiftKey ? -1 : 1;
        const nextIdx = (currentIdx + dir + stack.length) % stack.length;
        const nextId = stack[nextIdx];
        store.bringToFront(nextId);
        store.setFocusedTile(nextId);
      }
      // Ctrl+W — close selected tiles or focused tile
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        const store = useCanvasStore.getState();
        if (store.selectedTiles.length > 0) {
          store.removeSelectedTiles();
        } else if (store.focusedTile) {
          store.removeTile(store.focusedTile);
        }
      }
      // Ctrl+G — group selected tiles
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        const store = useCanvasStore.getState();
        if (store.selectedTiles.length >= 2) {
          const label = prompt('Group name:') || 'Group';
          store.groupTiles(store.selectedTiles, label);
        }
      }
      // Ctrl+Shift+B — save bookmark
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault();
        const name = prompt('Bookmark name:');
        if (name) {
          useCanvasStore.getState().addBookmark(name);
        }
      }
      // Ctrl+1 through Ctrl+9 — jump to bookmark
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key, 10) - 1;
        useCanvasStore.getState().jumpToBookmark(index);
      }
      // Ctrl+J — toggle timeline
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        useTimelineStore.getState().toggle();
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
        setSearchOpen(false);
        useCanvasStore.getState().exitFocusMode();
        useCanvasStore.getState().clearSelection();
      }
      // Cmd/Ctrl+R — reload the webview (Tauri doesn't wire this by default)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'r') {
        e.preventDefault();
        window.location.reload();
      }
      // Cmd/Ctrl+Shift+R — hard reload (bypasses Vite HMR module cache)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault();
        // Append a no-op query param so Vite serves fresh modules.
        const url = new URL(window.location.href);
        url.searchParams.set('_r', String(Date.now()));
        window.location.replace(url.toString());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleAddTile = useCallback((type: TileType) => {
    spawnTileAtCenter(type);
  }, []);

  const handleAddFromTemplate = useCallback((template: TileTemplate) => {
    spawnTileAtCenter(template.category, template.config);
  }, []);

  // Pipeline run launch — invoked by StartPipelineRunModal's submit button.
  // Returns the launch flow's structured result so the modal can surface
  // the error inline instead of via a toast (faster feedback loop).
  const handleStartPipelineRun = useCallback(
    async (input: { goal: string; branch: string }) => {
      const result = await launchPipelineRun({
        goal: input.goal,
        branch: input.branch,
        confirmSensitivePaths: (paths) =>
          new Promise<boolean>((resolve) => {
            setSensitivePathsState({ paths, resolve });
          }),
      });
      if (result.ok) {
        setPipelineRunOpen(false);
        useToastStore.getState().addToast(
          `Pipeline run started — branch ${input.branch}`,
          'success',
        );
        return { ok: true };
      }
      // Toast non-cancellation errors so they're visible even after the
      // modal is closed; cancellations are silent (user-initiated).
      if (result.reason !== 'cancelled') {
        useToastStore.getState().addToast(
          `Pipeline launch failed: ${result.error}`,
          'error',
        );
      }
      return { ok: false, error: result.error };
    },
    [],
  );

  const project = projects.find(p => p.id === activeProject);

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      background: colors.bg,
      fontFamily: "'Public Sans', sans-serif",
      color: colors.onSurfaceVariant,
      overflow: 'hidden',
    }}>
      <ProjectSidebar projects={projects} active={activeProject} onSelect={setActiveProject} />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar
          project={project}
          onAddTile={handleAddTile}
          onAddFromTemplate={handleAddFromTemplate}
          onOpenPalette={() => setPaletteOpen(true)}
          onStartPipelineRun={() => setPipelineRunOpen(true)}
          onOpenRunHistory={() => setRunHistoryOpen(true)}
        />
        <InfiniteCanvas />
        <SessionTimeline onClose={() => useTimelineStore.getState().setOpen(false)} />
        <StatusRail />
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onAddTile={handleAddTile}
          onAddFromTemplate={handleAddFromTemplate}
        />
      )}

      {searchOpen && (
        <SearchOverlay onClose={() => setSearchOpen(false)} />
      )}

      <SettingsModal />

      {/* Launch + sensitive-paths gate are visually mutually exclusive.
          The launch modal stays mounted (so the user's typed goal isn't
          lost) but is hidden while the gate is up. On gate cancel the
          launch flow returns; the user re-sees the launch modal with the
          inline error pre-filled. */}
      {pipelineRunOpen && (
        <StartPipelineRunModal
          defaultBranch={`pipeline/run-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 4)}`}
          onSubmit={handleStartPipelineRun}
          onCancel={() => setPipelineRunOpen(false)}
          hidden={sensitivePathsState !== null}
        />
      )}

      {sensitivePathsState && (
        <SensitivePathsModal
          paths={sensitivePathsState.paths}
          onAcknowledge={() => {
            sensitivePathsState.resolve(true);
            setSensitivePathsState(null);
          }}
          onCancel={() => {
            sensitivePathsState.resolve(false);
            setSensitivePathsState(null);
          }}
        />
      )}

      {/* Run history register + drill-through. The panel reads runs from
          pipelineStore directly; clicking a row stages a logs target which
          mounts RunLogsModal in front. Closing logs falls back to history. */}
      {runHistoryOpen && (
        <RunHistoryPanel
          onClose={() => setRunHistoryOpen(false)}
          onOpenLogs={(run) => setLogsTarget(run)}
        />
      )}

      {logsTarget && (
        <RunLogsModal
          run={logsTarget}
          projectDir={
            projects.find((p) => p.id === logsTarget.projectId)?.cwd ?? ''
          }
          onClose={() => setLogsTarget(null)}
        />
      )}

      <ToastContainer />
    </div>
  );
}
