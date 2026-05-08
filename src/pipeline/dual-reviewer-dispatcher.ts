/**
 * Dual-reviewer dispatcher (Phase 3c.4).
 *
 * Subscribes to pipelineStore lifecycle transitions and fires the reviewer
 * one-shots that the state machine expects:
 *
 *   - On `* → awaiting_dual_reviewer`: spawn BOTH `reviewer` (Opus) and
 *     `reviewer-codex`. The state-machine then waits for both verdicts and
 *     reconciles.
 *
 *   - On `* → awaiting_tiebreaker`: spawn the third tiebreaker reviewer —
 *     the OTHER provider, hardcoded to `gemini` for now (Opus + Codex are
 *     the dual pair, so the tiebreaker is the third major provider). If
 *     gemini isn't installed the dispatcher logs a warning and the run
 *     stalls — the user can intervene via the Run modal.
 *
 * Pure DI: callers inject `runOneShotReviewer` (production wires this to
 * `agent_run_oneshot` in App.tsx; tests pass a mock). The dispatcher itself
 * never touches IPC directly.
 *
 * Idempotency: each (runId, gate) pair fires exactly once. A tiebreaker
 * round AFTER a re-build (which puts the run back through
 * `awaiting_dual_reviewer`) is treated as a new gate because the run
 * cycles building → awaiting_dual_reviewer → ... — we key by `(runId,
 * gateState, retryCounter)` so each round gets fresh dispatches.
 */

import type { PipelineRole, PipelineState } from '@/types';
import { TERMINAL_STATES } from '@/pipeline/state-machine';
import {
  usePipelineStore,
  setPipelineLifecycleEmitter,
  emitTelemetry,
  type LifecycleEvent,
} from '@/stores/pipelineStore';

/** Provider for the tiebreaker reviewer when Opus + Codex disagree. */
export const TIEBREAKER_PROVIDER = 'gemini' as const;

export interface RunOneShotReviewerInput {
  runId: string;
  /** `reviewer` (Opus), `reviewer-codex`, or `reviewer` again for the gemini tiebreaker. */
  role: PipelineRole;
  /** Free-form provider hint for the spawn layer ('opus' | 'codex' | 'gemini'). */
  provider: 'opus' | 'codex' | 'gemini';
}

export interface DualReviewerDeps {
  /**
   * Spawn one reviewer one-shot. Production wires this to
   * `agent_run_oneshot`; tests pass a `vi.fn()` that records the call.
   * Errors are logged but never rethrown — a failed spawn shouldn't
   * suppress the other reviewer in the dual pair.
   */
  runOneShotReviewer(input: RunOneShotReviewerInput): Promise<void> | void;
}

interface RunBookkeeping {
  /** Counter snapshot of the most recent dual-gate dispatch fire. */
  dualLastReject: number;
  dualFired: boolean;
  /** Counter snapshot of the most recent tiebreaker-gate dispatch fire. */
  tiebreakerLastReject: number;
  tiebreakerFired: boolean;
}

const bookkeeping = new Map<string, RunBookkeeping>();

function track(runId: string): RunBookkeeping {
  let entry = bookkeeping.get(runId);
  if (!entry) {
    entry = { dualLastReject: -1, dualFired: false, tiebreakerLastReject: -1, tiebreakerFired: false };
    bookkeeping.set(runId, entry);
  }
  return entry;
}

/** Test helper — drop all bookkeeping between vitest cases. */
export function resetDualReviewerDispatcherForTest(): void {
  bookkeeping.clear();
}

/**
 * Lifecycle handler — wire via `setPipelineLifecycleEmitter` at app boot.
 *
 * The handler reads `usePipelineStore.getState().runs[runId]` to learn the
 * current `retryCounters.reviewerReject` so we can fire ONCE per round.
 * Reading from the store is fine here: the lifecycle emitter fires
 * synchronously from inside `dispatch` *after* the new state has been
 * committed, so the run we read reflects the post-transition shape.
 */
export function handleDualReviewerLifecycle(
  ev: LifecycleEvent,
  deps: DualReviewerDeps,
): void {
  const toState = ev.to as PipelineState;

  if (toState === 'awaiting_dual_reviewer') {
    const run = usePipelineStore.getState().runs[ev.runId];
    if (!run) return;
    const reject = run.retryCounters.reviewerReject;
    const entry = track(ev.runId);
    // Re-fire when entering the gate again on a NEW round (counter changed).
    if (entry.dualFired && entry.dualLastReject === reject) return;
    entry.dualFired = true;
    entry.dualLastReject = reject;
    // Reset tiebreaker bookkeeping — a new dual round may produce a fresh tie.
    entry.tiebreakerFired = false;
    entry.tiebreakerLastReject = -1;
    fireSafely(deps, { runId: ev.runId, role: 'reviewer', provider: 'opus' });
    fireSafely(deps, { runId: ev.runId, role: 'reviewer-codex', provider: 'codex' });
    return;
  }

  // Audit fix: prune bookkeeping when the run reaches a terminal state.
  // Without this, the Map grows by one entry per run forever.
  if (TERMINAL_STATES.has(toState)) {
    bookkeeping.delete(ev.runId);
    return;
  }

  if (toState === 'awaiting_tiebreaker') {
    const run = usePipelineStore.getState().runs[ev.runId];
    if (!run) return;
    const reject = run.retryCounters.reviewerReject;
    const entry = track(ev.runId);
    if (entry.tiebreakerFired && entry.tiebreakerLastReject === reject) return;
    entry.tiebreakerFired = true;
    entry.tiebreakerLastReject = reject;
    // Tiebreaker uses the `reviewer` role slot — same prompt + capabilities,
    // different provider. Spawn layer maps `provider: 'gemini'` to the
    // gemini CLI binary; if absent it logs and the run stalls until the
    // user intervenes (per spec — no silent fallback).
    fireSafely(deps, { runId: ev.runId, role: 'reviewer', provider: TIEBREAKER_PROVIDER });
    // Phase 3c.7: trust telemetry — record that the tiebreaker fired.
    // `dual_reviewer_disagreement` is logged from pipelineStore.dispatch
    // on the awaiting_dual_reviewer→awaiting_tiebreaker transition; this
    // event captures that the dispatcher actually invoked the third
    // provider. The two together let dashboards distinguish "we noticed
    // a disagreement" from "we resolved it via gemini."
    emitTelemetry({
      at: Date.now(),
      event: 'tiebreaker_invoked',
      runId: ev.runId,
      projectId: ev.projectId,
      provider: TIEBREAKER_PROVIDER,
    });
    return;
  }
}

function fireSafely(deps: DualReviewerDeps, input: RunOneShotReviewerInput): void {
  try {
    const ret = deps.runOneShotReviewer(input);
    if (ret && typeof (ret as Promise<void>).then === 'function') {
      (ret as Promise<void>).catch((err) => {
        console.warn('[dual-reviewer] runOneShotReviewer rejected', input, err);
      });
    }
  } catch (err) {
    console.warn('[dual-reviewer] runOneShotReviewer threw', input, err);
  }
}

/**
 * Convenience wrapper: register the dispatcher on the lifecycle emitter and
 * return an unsubscribe fn. App.tsx calls this once at boot.
 */
export function startDualReviewerDispatcher(deps: DualReviewerDeps): () => void {
  return setPipelineLifecycleEmitter((ev) => handleDualReviewerLifecycle(ev, deps));
}
