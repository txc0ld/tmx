/**
 * Scratchpad-watcher (Phase 3b.2).
 *
 * Builder agents are *required* to journal long-running state into
 * `<worktree>/.tx-builder-notes.md` (see the `tx-pipeline-builder-scratchpad`
 * skill). The watcher makes that requirement load-bearing: every Builder
 * sentinel or heartbeat triggers an mtime check on the scratchpad. If
 * 10+ minutes of activity pass with no scratchpad write, the controller
 * injects a synthetic `<<<TX_STAGE_QUESTION>>>` that counts against the
 * 3-question budget — forcing the Builder to either pause and document,
 * or invoke the refusal protocol if genuinely blocked.
 *
 * Sibling to `stuck-detector.ts`: that one fires on PTY *silence*, this
 * one fires on PTY activity that lacks scratchpad writes.
 *
 * DI'd so vitest can drive it with `vi.useFakeTimers()` + injected
 * `readMtime` / `injectClarification` mocks. Production wiring resolves
 * the deps inside the module from the IPC + pipelineStore (see
 * `defaultDeps` below) so callers in `controller-runtime.ts` don't have
 * to thread them through.
 */

import { usePipelineStore } from '@/stores/pipelineStore';
import { readFileMtime } from '@/utils/ipc';
import type { PipelineRole, QuestionArtifact } from '@/types';

export const SCRATCHPAD_FILE = '.tx-builder-notes.md';
export const STAGNATION_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

interface ScratchpadState {
  /** Last observed mtime (ms-epoch). `null` until the file appears. */
  lastNotedMtime: number | null;
  /** Wall-clock at last Builder sentinel/heartbeat. */
  lastBuilderActivityAt: number;
  /**
   * `true` when a synthetic clarification has already been injected for
   * the *current* stagnation window. Cleared by `clearScratchpadState`
   * (called when the run leaves `awaiting_clarification` or terminates)
   * so the next stagnation window can fire one fresh probe.
   */
  pendingProbe: boolean;
}

const state = new Map<string, ScratchpadState>();

export interface ScratchpadDeps {
  /**
   * Resolve the mtime of `path` in ms-since-epoch. Returns `null` for a
   * missing or inaccessible file (e.g. before the Builder writes for the
   * first time). MUST NOT throw — production wiring catches IPC errors
   * and converts them to `null`.
   */
  readMtime(path: string): Promise<number | null>;
  /**
   * Inject the synthetic clarification into the run. Production wires to
   * `pipelineStore.dispatch` with a `question_raised` event; tests
   * substitute a recording mock.
   */
  injectClarification(runId: string, role: PipelineRole, question: QuestionArtifact): void;
  /** Wall clock — `Date.now` in production, fake-injected in tests. */
  now(): number;
}

/**
 * Production deps — used when the caller (controller-runtime) doesn't
 * pass a `deps` override. Kept as a module-level builder so tests still
 * have a clean injection point and importing `scratchpad-watcher` doesn't
 * eagerly evaluate `Date.now` or hold onto a stale store reference.
 */
function defaultDeps(): ScratchpadDeps {
  return {
    readMtime: async (path) => {
      try {
        return await readFileMtime(path);
      } catch (err) {
        // IPC-layer failure (path-allowlist, transient I/O) is *not* a
        // stagnation signal. Treat it as "unknown" so we don't false-fire
        // a clarification on a misconfigured path. The controller will
        // see future activity and re-check on the next sentinel.
        console.warn('[pipeline] scratchpad-watcher readMtime failed:', err);
        return null;
      }
    },
    injectClarification: (runId, _role, question) => {
      usePipelineStore.getState().dispatch(runId, {
        type: 'question_raised',
        question,
      });
    },
    now: () => Date.now(),
  };
}

const SYNTHETIC_QUESTION =
  "Builder hasn't updated .tx-builder-notes.md recently. Pause and document state, or refusal-protocol if blocked.";
const SYNTHETIC_CONTEXT =
  '10+ minutes of activity since last scratchpad update. The scratchpad is load-bearing for long Builder runs (see tx-pipeline-builder-scratchpad skill).';

interface NotifyInput {
  runId: string;
  role: PipelineRole;
  worktreePath: string;
  /** Tests pass partial overrides; production passes nothing. */
  deps?: Partial<ScratchpadDeps>;
}

/**
 * Notify the watcher that the Builder produced a sentinel or heartbeat.
 * Reads the scratchpad mtime, compares against the last observed value,
 * and injects a synthetic clarification when the file has gone stale
 * for `STAGNATION_THRESHOLD_MS` of *activity* (not silence — that's the
 * stuck-detector's job).
 *
 * Non-builder roles are filtered at the call site in `controller-runtime`
 * — this function trusts its caller.
 */
export async function notifyBuilderActivity(input: NotifyInput): Promise<void> {
  const merged: ScratchpadDeps = { ...defaultDeps(), ...input.deps };
  const path = joinPath(input.worktreePath, SCRATCHPAD_FILE);
  const now = merged.now();

  const mtime = await merged.readMtime(path);
  let entry = state.get(input.runId);

  if (!entry) {
    // First Builder activity for this run. Seed bookkeeping; never probe
    // on the first sample — even with `mtime === null` the Builder might
    // simply not have written yet (skill instructs writing within ~30s,
    // but we cut some slack).
    state.set(input.runId, {
      lastNotedMtime: mtime,
      lastBuilderActivityAt: now,
      pendingProbe: false,
    });
    return;
  }

  // Mtime advanced → Builder is updating the scratchpad. Re-arm bookkeeping.
  if (mtime !== null && (entry.lastNotedMtime === null || mtime > entry.lastNotedMtime)) {
    entry.lastNotedMtime = mtime;
    entry.lastBuilderActivityAt = now;
    entry.pendingProbe = false;
    return;
  }

  // Mtime stuck (or file missing). Fire one synthetic clarification per
  // stagnation window once threshold is exceeded.
  const stagnationMs = now - entry.lastBuilderActivityAt;
  if (stagnationMs > STAGNATION_THRESHOLD_MS && !entry.pendingProbe) {
    const question: QuestionArtifact = {
      stage: input.role,
      question: SYNTHETIC_QUESTION,
      context: SYNTHETIC_CONTEXT,
      blocking: true,
    };
    entry.pendingProbe = true;
    merged.injectClarification(input.runId, input.role, question);
    // Don't bump `lastBuilderActivityAt` here — leave it at the original
    // stamp so subsequent activities within this window short-circuit on
    // `pendingProbe` (debounce) rather than re-tripping the threshold.
    return;
  }

  // Activity arrived but neither mtime advanced nor threshold hit. We
  // intentionally do NOT update `lastBuilderActivityAt` here — that
  // counter measures activity-since-last-scratchpad-write, not
  // activity-since-last-sentinel. Keeping it pinned is what makes the
  // 10min stagnation rule meaningful.
}

/**
 * Clear bookkeeping for a run. Called on:
 *   1. Terminal state (via `clearRunBuffers` in controller-runtime).
 *   2. Clarification resume — so the *next* stagnation window can probe
 *      again without being permanently silenced by `pendingProbe`.
 */
export function clearScratchpadState(runId: string): void {
  state.delete(runId);
}

/**
 * Reset only the `pendingProbe` debounce — used when a clarification is
 * answered and the run leaves `awaiting_clarification`. Preserves the
 * mtime/activity bookkeeping so the *next* stagnation event still has
 * to wait the full 10 minutes from the most recent scratchpad write.
 */
export function resumeFromClarification(runId: string): void {
  const entry = state.get(runId);
  if (!entry) return;
  entry.pendingProbe = false;
  // Treat resume as a fresh activity stamp so we don't immediately
  // re-fire on the next builder sentinel (the agent has just been told
  // to write the scratchpad — give it the full 10min window to do so).
  // Use the production clock; tests that care can call clearScratchpadState
  // instead and re-seed via the next notify call.
  entry.lastBuilderActivityAt = Date.now();
}

/** Test helper — wipe internal state between vitest cases. */
export function resetScratchpadStateForTest(): void {
  state.clear();
}

/**
 * Path join that handles both POSIX and Windows worktree paths without
 * pulling in `path` (Node-only) or a new dep. The worktree path comes
 * from the user's project root so we trust it as-is and only normalize
 * the trailing separator.
 */
function joinPath(base: string, child: string): string {
  if (base.length === 0) return child;
  const last = base[base.length - 1];
  if (last === '/' || last === '\\') return base + child;
  // Pick the separator already in use — Windows paths typically have `\`.
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base + sep + child;
}
