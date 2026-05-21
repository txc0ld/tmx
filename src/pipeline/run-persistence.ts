/**
 * Run-record persistence (Phase 3a follow-up).
 *
 * `pipelineStore.runs` lives entirely in memory. App reload (Cmd+R, crash,
 * HMR) wipes the run state — the worktree, telemetry JSONL, and plan files
 * survive on disk but the orchestration record doesn't, so a 30-minute run
 * stuck in `awaiting_plan_approval` is gone the moment the renderer dies.
 *
 * This module persists the `PipelineRun` as a JSON snapshot at
 *   `<projectDir>/.terminalx/pipeline-runs/<runId>.json`
 * on every state-machine transition. Hydration walks that directory at
 * boot, deserializes each file, and rebuilds `pipelineStore.runs`.
 *
 * What we DO NOT do
 * ─────────────────
 * - Restore agent PTYs. They died with the app; nothing this layer can do.
 * - Auto-resume active stages. A run that was `building` when the app
 *   reloaded is reclassified to `failed` with a "disconnected" reason
 *   (which then triggers the failure-bundle lifecycle handler). The user
 *   relaunches.
 * - Auto-resume `awaiting_*`. The run is left as-is so the user can
 *   inspect / approve / abort. The controller surfaces a "Agents
 *   disconnected — approval may be stale" banner.
 * - Touch `done` / `failed` / `escalated`. Already terminal.
 *
 * Single-writer model
 * ───────────────────
 * Persistence piggybacks on `setPipelineLifecycleEmitter` (one IPC per
 * state transition). Newly-created runs get a one-shot post-`createRun`
 * persist call from `launch.ts` so the JSON exists before the first
 * transition fires.
 *
 * `writeFileText` already does atomic temp+rename per `filesystem.rs`.
 */

import type { PipelineRun, PipelineState } from '@/types';
import {
  usePipelineStore,
  type LifecycleEvent,
} from '@/stores/pipelineStore';
import { isTerminalState, ACTIVE_STAGES } from './state-machine';
import {
  readFileText as defaultReadFileText,
  readFileTree as defaultReadFileTree,
  writeFileText as defaultWriteFileText,
  type FileTreeNode,
} from '@/utils/ipc';
import { useProjectStore } from '@/stores/projectStore';

/** Match Rust-side validation in `pipeline_telemetry_log` etc. */
export const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Subdir under `<projectDir>` where snapshots live. */
export const RUN_PERSISTENCE_SUBDIR = '.terminalx/pipeline-runs';

export interface RunPersistenceDeps {
  /** Resolves the active project's `cwd` from `projectStore`. */
  resolveProjectCwd(projectId: string): string | null;
  writeFileText(path: string, contents: string): Promise<void>;
  readFileText(path: string): Promise<string>;
  readFileTree(path: string, maxDepth?: number): Promise<FileTreeNode[]>;
}

/** Built-in deps. Tests pass an explicit object instead. */
export function defaultRunPersistenceDeps(): RunPersistenceDeps {
  return {
    resolveProjectCwd: (projectId) => {
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
      return project?.cwd ?? null;
    },
    writeFileText: defaultWriteFileText,
    readFileText: defaultReadFileText,
    readFileTree: defaultReadFileTree,
  };
}

/** Compose the JSON path from a project cwd + run id. */
export function snapshotPath(projectCwd: string, runId: string): string {
  return `${projectCwd}/${RUN_PERSISTENCE_SUBDIR}/${runId}.json`;
}

/**
 * Serialize a run as deterministic JSON (no Date objects on `PipelineRun`,
 * just numbers + strings + nested objects). Indented for human-readable
 * crash inspection — JSON.parse doesn't care.
 */
export function serializeRun(run: PipelineRun): string {
  return JSON.stringify(run, null, 2);
}

/**
 * Best-effort persist. Validates runId against the regex, no-ops if the
 * project has no cwd, swallows IPC errors with a console.warn.
 */
export async function persistRun(
  run: PipelineRun,
  deps: RunPersistenceDeps,
): Promise<void> {
  if (!RUN_ID_RE.test(run.id)) {
    console.warn('[pipeline] run-persistence: refusing to write run with invalid id:', run.id);
    return;
  }
  const cwd = deps.resolveProjectCwd(run.projectId);
  if (!cwd) {
    // Unbound run — nowhere safe to write. Same posture as the telemetry emitter.
    return;
  }
  try {
    await deps.writeFileText(snapshotPath(cwd, run.id), serializeRun(run));
  } catch (err) {
    console.warn('[pipeline] run-persistence: write failed:', err);
  }
}

/** Debounce window before a per-run write actually flushes to disk. */
export const PERSIST_DEBOUNCE_MS = 500;

/**
 * Per-run pending-write registry. Module-scoped because the debouncer must
 * coalesce across every `makeRunPersistenceLifecycleHandler()` invocation
 * AND across the one-shot `flushPendingPersistence()` call from beforeunload.
 *
 * On a non-terminal event we (re)schedule a 500ms timer; the timer's
 * callback re-reads `pipelineStore.getState().runs[runId]` so the snapshot
 * reflects every transition that landed during the debounce window. On a
 * terminal-state event we cancel the pending timer (if any) and write
 * immediately — production correctness (the JSON-on-disk ledger of the run
 * terminating is the moment we MOST want fresh).
 */
const pendingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/** Cancel a pending timer for a run, if one is queued. */
function clearPendingTimer(runId: string): void {
  const t = pendingTimers.get(runId);
  if (t !== undefined) {
    clearTimeout(t);
    pendingTimers.delete(runId);
  }
}

/**
 * Lifecycle handler — fires on every `state_change` lifecycle event.
 *
 * Hot path: schedule a 500ms debounced write so a chatty run (heartbeats,
 * rapid state-machine bursts) doesn't fan out to one disk write per event.
 * The closure re-reads `pipelineStore.getState()` when the timer fires, so
 * the snapshot picked up is whatever lands at flush time — the second
 * write supersedes the first if both fire within the window.
 *
 * Terminal transitions (`done` / `failed` / `escalated`) bypass the
 * debounce: cancel any pending timer for this run, write the current
 * snapshot synchronously (well, fire-and-forget — the lifecycle emitter
 * doesn't await us, but no setTimeout interposes).
 */
export function makeRunPersistenceLifecycleHandler(
  deps: RunPersistenceDeps = defaultRunPersistenceDeps(),
): (ev: LifecycleEvent) => void {
  return (ev) => {
    const runId = ev.runId;
    const initialRun = usePipelineStore.getState().runs[runId];
    if (!initialRun) return;

    // Terminal transitions: cancel any queued debounced write and flush
    // immediately. We use ev.to rather than the loaded run.state because
    // the run snapshot in the store IS the post-transition state, but
    // ev.to is the same thing in source-of-truth terms and reads cleaner.
    if (isTerminalState(ev.to as PipelineState)) {
      clearPendingTimer(runId);
      void persistRun(initialRun, deps);
      return;
    }

    // Non-terminal: (re)schedule. If a timer is already queued, replace it
    // — the next firing reads fresh state, so the dropped tick's snapshot
    // would have been stale anyway.
    clearPendingTimer(runId);
    const t = setTimeout(() => {
      pendingTimers.delete(runId);
      const fresh = usePipelineStore.getState().runs[runId];
      if (!fresh) return;
      void persistRun(fresh, deps);
    }, PERSIST_DEBOUNCE_MS);
    pendingTimers.set(runId, t);
  };
}

/**
 * Shutdown flush. Called from `beforeunload` so any pending debounced
 * writes land before the renderer tears down. Each pending run is written
 * once with its current store snapshot; timers are cleared either way so
 * we don't double-fire after a re-entry.
 *
 * `writeFileText` is async and we can't await it from `beforeunload` (the
 * event handler can't block the window unload), but firing the IPC
 * synchronously enqueues the work in the Tauri command dispatch loop —
 * Rust will complete the atomic temp+rename even if the renderer is gone
 * by the time the worker thread runs (the OS keeps the FD/dir handle
 * alive long enough). Best-effort by design; same posture as the
 * lifecycle emitter writes.
 */
export function flushPendingPersistence(
  deps: RunPersistenceDeps = defaultRunPersistenceDeps(),
): void {
  if (pendingTimers.size === 0) return;
  const ids = Array.from(pendingTimers.keys());
  for (const runId of ids) {
    clearPendingTimer(runId);
    const run = usePipelineStore.getState().runs[runId];
    if (!run) continue;
    void persistRun(run, deps);
  }
}

/**
 * Test-only: drop every pending timer without firing. Used by the
 * debounce tests to keep state isolated between cases under
 * `vi.useFakeTimers()`.
 */
export function _resetPendingPersistenceForTest(): void {
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
}

/** Walk the directory tree returned by `readFileTree` for *.json leaves. */
function collectJsonPaths(nodes: FileTreeNode[]): string[] {
  const out: string[] = [];
  const stack: FileTreeNode[] = [...nodes];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.node_type === 'File' && n.name.endsWith('.json')) {
      out.push(n.path);
    } else if (n.node_type === 'Directory' && n.children) {
      stack.push(...n.children);
    }
  }
  return out;
}

/**
 * Apply the active-state-on-reload policy to a hydrated run.
 *
 *  - Active (planning/building/reviewing/merging/...) → marked `failed`.
 *    The failure-bundle lifecycle handler will dump telemetry + diff.
 *  - `awaiting_*` → left as-is. Operator decides.
 *  - Terminal → left as-is.
 */
export function reconcileHydratedRun(run: PipelineRun): PipelineRun {
  if (isTerminalState(run.state)) return run;
  if (ACTIVE_STAGES.has(run.state)) {
    return {
      ...run,
      state: 'failed' as PipelineState,
      failureReason: 'app reloaded during active state — agents disconnected',
      failureClass: 'unknown',
      endedAt: Date.now(),
    };
  }
  // awaiting_* (incl. awaiting_clarification, awaiting_plan_approval, etc.)
  // and `idle` survive untouched. The controller renders a "agents
  // disconnected" banner for awaiting_* runs, and the builder-kick lifecycle
  // short-circuits so we don't write to dead PTY ids on the next transition.
  if (run.state.startsWith('awaiting_')) {
    return { ...run, agentsDisconnected: true };
  }
  return run;
}

/**
 * Hydrate the pipelineStore from disk. Walks `<projectCwd>/.terminalx/pipeline-runs/`,
 * deserializes every `.json` file, applies the reconcile policy, and writes
 * the runs map back into the store.
 *
 * Errors at any one file are logged + skipped — a single corrupt snapshot
 * cannot block the rest of the hydration.
 *
 * Returns the count of hydrated runs.
 */
export async function hydrateRunsFromDisk(
  projectCwd: string,
  deps: RunPersistenceDeps = defaultRunPersistenceDeps(),
): Promise<number> {
  const dirPath = `${projectCwd}/${RUN_PERSISTENCE_SUBDIR}`;
  let nodes: FileTreeNode[];
  try {
    nodes = await deps.readFileTree(dirPath, 1);
  } catch {
    // Directory missing is the common case (no runs ever launched).
    return 0;
  }

  const jsonPaths = collectJsonPaths(nodes);
  if (jsonPaths.length === 0) return 0;

  const hydrated: PipelineRun[] = [];
  for (const path of jsonPaths) {
    try {
      const raw = await deps.readFileText(path);
      const parsed = JSON.parse(raw) as PipelineRun;
      if (!parsed || typeof parsed !== 'object' || !parsed.id) {
        console.warn('[pipeline] run-persistence: skipping malformed snapshot:', path);
        continue;
      }
      hydrated.push(reconcileHydratedRun(parsed));
    } catch (err) {
      console.warn('[pipeline] run-persistence: failed to read snapshot', path, err);
    }
  }

  if (hydrated.length > 0) {
    _hydrateForTest(hydrated);
    // Persist the reconciled state back to disk for runs we just marked
    // failed, so the next reload doesn't re-mark them.
    for (const run of hydrated) {
      if (run.state === 'failed' && run.failureReason?.startsWith('app reloaded')) {
        void persistRun(run, deps);
      }
    }
  }
  return hydrated.length;
}

/**
 * Test-only helper: replace the store's `runs` map directly. Production
 * uses this from `hydrateRunsFromDisk`; tests assert against the result.
 *
 * Doesn't go through `createRun` because hydration needs to skip the
 * "skip if id already exists" guard and preserve every field of the
 * persisted run (including `state`, `endedAt`, etc.).
 */
export function _hydrateForTest(runs: PipelineRun[]): void {
  usePipelineStore.setState((s) => {
    const next = { ...s.runs };
    for (const r of runs) next[r.id] = r;
    const activeRunIds = Object.values(next)
      .filter((r) => !isTerminalState(r.state))
      .map((r) => r.id);
    return { runs: next, activeRunIds };
  });
}
