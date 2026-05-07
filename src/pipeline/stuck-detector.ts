/**
 * Stuck-run detection.
 *
 * Ticks at 250ms. For every active run, computes a "lastActivity" stamp from
 * `max(lastHeartbeatAt, lastStdoutAt, startedAt)`. If silence exceeds
 * `PROBE_THRESHOLD_MS` we inject a synthetic "Are you stuck?\n" into the
 * active role's PTY (once per quiet window — re-armed when activity resumes).
 * If silence exceeds `ABORT_THRESHOLD_MS` we dispatch an `abort` with
 * `failureClass: 'stage_unresponsive'` so the run doesn't hang forever.
 *
 * The detector is dependency-injected (mirrors `RunFactoryDeps`) so vitest
 * can drive it with `vi.useFakeTimers()` without touching real PTYs or
 * the canvas store. App.tsx wires the production deps at boot.
 */

export const PROBE_THRESHOLD_MS = 5 * 60 * 1000;
export const ABORT_THRESHOLD_MS = 8 * 60 * 1000;
export const TICK_MS = 250;

/** Minimal view of a run the detector needs. Avoids importing the full type. */
export interface StuckDetectorRunView {
  id: string;
  /** From `PipelineRun.lastHeartbeatAt`. */
  lastHeartbeatAt?: number;
  /** From `PipelineRun.startedAt` — fallback for runs that have never spoken. */
  startedAt: number;
  /** Resolved PTY id for the run's active role (planner/builder/reviewer). */
  ptyId?: string;
}

export interface StuckDetectorDeps {
  /** Snapshot of every active (non-terminal) run with its active-role pty resolved. */
  getActiveRuns(): StuckDetectorRunView[];
  /** Read the last-stdout timestamp from controller-runtime's liveness map. */
  getLastStdoutAt(runId: string): number | undefined;
  /** Probe: write a synthetic user-turn ("Are you stuck?\n") to the run's PTY. */
  probeAgent(runId: string, ptyId: string): Promise<void>;
  /** Force-abort a run with the given reason. Calls pipelineStore dispatch. */
  abortRun(runId: string, reason: string): void;
  /** Wall clock — `Date.now` in production, fake-injected in tests. */
  now(): number;
}

/**
 * In-detector bookkeeping (NOT in PipelineRun). The "probedAt" stamp only
 * matters for de-duping the synthetic probe; persisting it on the run would
 * clutter telemetry and serialization. Local Map keeps it scoped to the
 * detector instance.
 */
interface RunBookkeeping {
  /** Most recent activity stamp we computed (heartbeat / stdout / startedAt). */
  lastActivityAt: number;
  /** When we last sent a probe; `null` if never (or activity has resumed since). */
  probedAt: number | null;
  /**
   * Whether we've already dispatched an abort for this run. The store reducer
   * will move it to `failed` so the next tick's `getActiveRuns` won't include
   * it — but in case the dispatch is async, slow, or the caller's getActiveRuns
   * snapshot lags, this flag prevents a second abort fire.
   */
  aborted: boolean;
}

/**
 * Start the detector. Returns a cleanup function that clears the interval.
 * Call exactly once at app boot; idempotent shutdown via the returned fn.
 */
export function startStuckDetector(deps: StuckDetectorDeps): () => void {
  const bookkeeping = new Map<string, RunBookkeeping>();

  const tick = (): void => {
    const now = deps.now();
    const runs = deps.getActiveRuns();
    const seen = new Set<string>();

    for (const run of runs) {
      seen.add(run.id);
      const heartbeat = run.lastHeartbeatAt ?? 0;
      const stdout = deps.getLastStdoutAt(run.id) ?? 0;
      const lastActivity = Math.max(heartbeat, stdout, run.startedAt);

      let entry = bookkeeping.get(run.id);
      if (!entry) {
        entry = { lastActivityAt: lastActivity, probedAt: null, aborted: false };
        bookkeeping.set(run.id, entry);
      } else if (lastActivity > entry.lastActivityAt) {
        // Activity resumed — re-arm the probe so a future quiet window
        // gets one fresh probe (rather than being silenced forever).
        entry.lastActivityAt = lastActivity;
        entry.probedAt = null;
      }

      // Already aborted this run — don't re-fire even if it lingers in the
      // active snapshot for one more tick before the reducer removes it.
      if (entry.aborted) continue;

      const silence = now - lastActivity;

      if (silence > ABORT_THRESHOLD_MS) {
        const minutes = Math.floor(silence / 60000);
        entry.aborted = true;
        deps.abortRun(run.id, `stage_unresponsive (silence: ${minutes}m)`);
        continue;
      }

      if (silence > PROBE_THRESHOLD_MS && entry.probedAt === null) {
        if (run.ptyId) {
          // Fire-and-forget: probe failure shouldn't crash the tick. The
          // caller can log via the injected deps if it cares.
          void deps.probeAgent(run.id, run.ptyId).catch(() => { /* swallow */ });
        }
        // Mark probed even when ptyId is missing — otherwise we'd retry
        // every tick (4×/sec) for runs without a live PTY.
        entry.probedAt = now;
      }
    }

    // Drop bookkeeping for runs that have left the active set (terminal,
    // removed, or otherwise no longer reported).
    for (const id of bookkeeping.keys()) {
      if (!seen.has(id)) bookkeeping.delete(id);
    }
  };

  const handle = setInterval(tick, TICK_MS);
  return () => clearInterval(handle);
}
