/**
 * Single-reviewer dispatcher.
 *
 * STANDARD pipeline runs (Anthropic Trio default) route `building →
 * reviewing` and expect the Reviewer to run as a one-shot agent — there is
 * no live Reviewer tile (instantiate.ts skips agent specs with
 * `config.oneshot === true`). This dispatcher is the spawn-side glue: on
 * entry into `reviewing` it builds the brief and fires `agent_run_oneshot`,
 * then pipes the captured stdout back through `ingestOneshotResult` so the
 * existing controller-runtime parser dispatches the resulting
 * `reviewer_done` / `abort` events.
 *
 * Mirrors `dual-reviewer-dispatcher.ts` and `red-team-dispatcher.ts`:
 *   - DI'd via `runOneShotReviewer` (production wires to the brief-builder
 *     + IPC + ingest stack in App.tsx; tests pass mocks).
 *   - Subscribes via the multi-listener `setPipelineLifecycleEmitter` Set.
 *   - Per-(runId, retryCounters.reviewerReject) dedup so each new
 *     reject-loop round legitimately re-fires while idempotent re-entries
 *     of the same gate (e.g. duplicate emitter calls) do not.
 *   - Skips when `run.useDualReviewer === true` — that gate lands in
 *     `awaiting_dual_reviewer`, never `reviewing`, but a defensive skip
 *     guards against future state-machine changes.
 *   - Bookkeeping pruned on terminal-state transitions (matches the audit
 *     fix in dual-reviewer-dispatcher).
 */

import type { PipelineState } from '@/types';
import { TERMINAL_STATES } from '@/pipeline/state-machine';
import {
  usePipelineStore,
  setPipelineLifecycleEmitter,
  type LifecycleEvent,
} from '@/stores/pipelineStore';

export interface RunOneShotReviewerInput {
  runId: string;
}

export interface SingleReviewerDeps {
  /**
   * Spawn the reviewer one-shot. Production wires this to a closure that
   * builds the brief, calls `agent_run_oneshot`, and pipes the result into
   * `controller-runtime.ingestOneshotResult`. Errors are logged but never
   * rethrown — a transient failure shouldn't crash the lifecycle emitter.
   */
  runOneShotReviewer(input: RunOneShotReviewerInput): Promise<void> | void;
}

interface RunBookkeeping {
  /**
   * `retryCounters.reviewerReject` value of the most recent dispatch.
   * `-1` means "never fired in this run yet."
   */
  lastReject: number;
  fired: boolean;
}

const bookkeeping = new Map<string, RunBookkeeping>();

function track(runId: string): RunBookkeeping {
  let entry = bookkeeping.get(runId);
  if (!entry) {
    entry = { lastReject: -1, fired: false };
    bookkeeping.set(runId, entry);
  }
  return entry;
}

/** Test helper — drop all bookkeeping between vitest cases. */
export function resetSingleReviewerDispatcherForTest(): void {
  bookkeeping.clear();
}

/**
 * Lifecycle handler. Public for unit-test ergonomics; production callers
 * use `startSingleReviewerDispatcher` which wires this through the
 * lifecycle Set.
 */
export function handleSingleReviewerLifecycle(
  ev: LifecycleEvent,
  deps: SingleReviewerDeps,
): void {
  const toState = ev.to as PipelineState;

  // Prune bookkeeping when the run reaches a terminal state. Without this
  // the Map grows by one entry per run forever.
  if (TERMINAL_STATES.has(toState)) {
    bookkeeping.delete(ev.runId);
    return;
  }

  if (toState !== 'reviewing') return;

  const run = usePipelineStore.getState().runs[ev.runId];
  if (!run) return;

  // Defensive: dual-reviewer runs never reach `reviewing` per the
  // state-machine, but skip explicitly so a future state-machine change
  // doesn't double-fire alongside the dual-reviewer dispatcher.
  if (run.useDualReviewer) return;

  const reject = run.retryCounters.reviewerReject;
  const entry = track(ev.runId);
  // Re-fire when entering the gate again on a NEW round (counter changed).
  if (entry.fired && entry.lastReject === reject) return;
  entry.fired = true;
  entry.lastReject = reject;

  fireSafely(deps, { runId: ev.runId });
}

function fireSafely(deps: SingleReviewerDeps, input: RunOneShotReviewerInput): void {
  try {
    const ret = deps.runOneShotReviewer(input);
    if (ret && typeof (ret as Promise<void>).then === 'function') {
      (ret as Promise<void>).catch((err) => {
        console.warn('[single-reviewer] runOneShotReviewer rejected', input, err);
      });
    }
  } catch (err) {
    console.warn('[single-reviewer] runOneShotReviewer threw', input, err);
  }
}

/**
 * Convenience wrapper: register the dispatcher on the lifecycle emitter and
 * return an unsubscribe fn. App.tsx calls this once at boot.
 */
export function startSingleReviewerDispatcher(deps: SingleReviewerDeps): () => void {
  return setPipelineLifecycleEmitter((ev) => handleSingleReviewerLifecycle(ev, deps));
}
