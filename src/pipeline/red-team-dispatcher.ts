/**
 * Red-team dispatcher (Polish.1).
 *
 * Closes the spawn-side gap from Phase 3c.6 — the state-machine half
 * (`awaiting_red_team` state, `red_team_done`/`red_team_failed` events,
 * `RedTeamReport` validation in controller-runtime) all landed in 3c.6, but
 * nothing actually fires the red-team agent. Without this dispatcher,
 * complex runs (which set `runRedTeam = true` on planner_done) reach
 * `awaiting_red_team` after Reviewer approval and stall indefinitely.
 *
 * Mirrors `dual-reviewer-dispatcher.ts`:
 *   - DI'd via `runRedTeam` + `buildBrief` (production wires to
 *     `agent_run_oneshot` + `ingestOneshotResult`; tests pass mocks).
 *   - Subscribes via the multi-listener `setPipelineLifecycleEmitter` Set.
 *   - Per-run `firedAt` bookkeeping reset on transition OUT of the gate so
 *     a Builder reject re-loop (which cycles `building → reviewing →
 *     awaiting_red_team` again) gets a fresh dispatch on each Reviewer
 *     re-approval. Unlike dual-reviewer (which keys on
 *     `retryCounters.reviewerReject`), red-team is simpler: there's only
 *     one slot to fill per gate entry, so a boolean + entry/exit reset is
 *     sufficient and avoids a dedicated counter.
 *   - Brief-build failure logs and resets the fired flag so a future
 *     re-entry can retry — same reason dual-reviewer's fireSafely catches:
 *     a transient brief-build error shouldn't permanently silence the
 *     dispatcher for a run.
 */

import {
  usePipelineStore,
  setPipelineLifecycleEmitter,
  emitTelemetry,
  type LifecycleEvent,
} from '@/stores/pipelineStore';

/**
 * Provider for the red-team agent. Hardcoded to `opus` today, matching the
 * `tx-pipeline-red-team` skill's authored examples; future per-run config
 * (custom agent / provider override) lands with the broader role-config
 * work and will live alongside the dual-reviewer provider toggles.
 */
export const REDTEAM_PROVIDER = 'opus' as const;

export interface RunRedTeamInput {
  runId: string;
  /** The full prompt assembled by `buildBrief`. */
  brief: string;
}

export interface RedTeamDispatcherDeps {
  /**
   * Spawn the red-team one-shot. Production wires this to
   * `agent_run_oneshot` and pipes the result into
   * `controller-runtime.ingestOneshotResult` so the existing sentinel
   * parser dispatches `red_team_done` / `red_team_failed`.
   *
   * Errors are caught inside the dispatcher: a failed spawn resets the
   * fired flag so a future re-entry can retry. We never propagate to the
   * lifecycle emitter (which would surface a console.warn from the
   * `setPipelineLifecycleEmitter` try/catch but not affect other listeners).
   */
  runRedTeam(input: RunRedTeamInput): Promise<void> | void;

  /**
   * Build the red-team brief — production composes the
   * `tx-pipeline-red-team` skill content + diff + plan + spec context.
   * Returning `null`/empty is allowed; the dispatcher passes it through to
   * `runRedTeam` unchanged. Throwing/rejecting is caught and treated as a
   * transient failure (see `runRedTeam` doc).
   */
  buildBrief(runId: string): Promise<string> | string;

  /** Optional clock for deterministic telemetry timestamps in tests. */
  now?: () => number;
}

interface RunBookkeeping {
  /** Whether the red-team has been fired for the CURRENT entry into the gate. */
  fired: boolean;
}

const bookkeeping = new Map<string, RunBookkeeping>();

/** Test helper — drop all bookkeeping between vitest cases. */
export function resetRedTeamDispatcherForTest(): void {
  bookkeeping.clear();
}

/**
 * Lifecycle handler. Public for unit-test ergonomics; production callers
 * use `startRedTeamDispatcher` which wires this through the lifecycle Set.
 */
export function handleRedTeamLifecycle(
  ev: LifecycleEvent,
  deps: RedTeamDispatcherDeps,
): void {
  // Entry into the red-team gate from any non-red-team state — fire once.
  if (ev.to === 'awaiting_red_team' && ev.from !== 'awaiting_red_team') {
    const entry = bookkeeping.get(ev.runId) ?? { fired: false };
    if (entry.fired) {
      // Defensive: shouldn't happen because we clear on exit, but if a
      // pathological transition flips us back to the gate without a
      // matching exit (e.g. test seeds), don't double-fire.
      return;
    }
    entry.fired = true;
    bookkeeping.set(ev.runId, entry);

    // Sanity check: the run must still exist and actually be in the gate.
    // If the store has been mutated between dispatch and emitter (which
    // shouldn't happen synchronously, but tests can race), bail rather
    // than fire against a stale snapshot.
    const run = usePipelineStore.getState().runs[ev.runId];
    if (!run) {
      bookkeeping.delete(ev.runId);
      return;
    }

    void fireRedTeam(ev.runId, deps);

    emitTelemetry({
      at: (deps.now ?? Date.now)(),
      event: 'red_team_invoked',
      runId: ev.runId,
      projectId: ev.projectId,
      provider: REDTEAM_PROVIDER,
    });
    return;
  }

  // Exit from the gate — clear bookkeeping so the next Reviewer re-approval
  // (after a Builder reject loop) gets a fresh dispatch. We clear on ANY
  // outbound transition: success path → awaiting_merge_approval, blocker
  // → failed, abort → escalated, etc. The next entry from a non-red-team
  // state will allocate a new RunBookkeeping with `fired: false`.
  if (ev.from === 'awaiting_red_team' && ev.to !== 'awaiting_red_team') {
    bookkeeping.delete(ev.runId);
  }
}

async function fireRedTeam(runId: string, deps: RedTeamDispatcherDeps): Promise<void> {
  try {
    const brief = await Promise.resolve(deps.buildBrief(runId));
    await Promise.resolve(deps.runRedTeam({ runId, brief }));
  } catch (err) {
    console.warn(`[red-team-dispatcher] firing failed for ${runId}:`, err);
    // Reset fired flag so a future re-entry can retry. Mirrors
    // dual-reviewer's resilience: a transient brief-build error or spawn
    // failure shouldn't permanently silence the dispatcher.
    const entry = bookkeeping.get(runId);
    if (entry) entry.fired = false;
  }
}

/**
 * Convenience wrapper: register the dispatcher on the lifecycle emitter and
 * return an unsubscribe fn. App.tsx calls this once at boot.
 */
export function startRedTeamDispatcher(deps: RedTeamDispatcherDeps): () => void {
  return setPipelineLifecycleEmitter((ev) => handleRedTeamLifecycle(ev, deps));
}
