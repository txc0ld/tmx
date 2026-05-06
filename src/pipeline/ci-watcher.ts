/**
 * CI watcher — watches a worktree's `.git/refs/heads/<branch>` ref file via the
 * existing `watchDirectory` IPC. On every new HEAD SHA, runs the verification
 * chain (Task 2c-i.1) by invoking the caller-supplied `runStep` (in production
 * `pipelineRunVerificationStep` from Task 2c-i.2) and dispatches `ci_pass` /
 * `ci_fail` events to the pipeline controller.
 *
 * Design notes:
 * - All side-effects (fs read of HEAD, manifest read, step execution) are
 *   injected through the opts object so tests can drive the watcher without
 *   touching disk or the IPC layer. Production wiring lives in Task 2c-i.6.
 * - We only run while `runs[runId].state === 'building'`. The state machine
 *   already no-ops `ci_*` outside `building`, but bailing here avoids burning
 *   minutes on a `cargo test` for an aborted run.
 * - 250ms debounce collapses git's atomic-write burst (lock file → rename).
 * - `inFlight` + `pending` flags coalesce overlapping fires into at most one
 *   queued re-run.
 *
 * Spec: docs/superpowers/specs/2026-05-03-agentic-pipeline-template-design.md §4.4
 */

import { watchDirectory, unwatchDirectory, onFsChange } from '@/utils/ipc';
import type { VerificationStepResult } from '@/utils/ipc';
import { usePipelineStore } from '@/stores/pipelineStore';
import { resolveVerificationChain, type ManifestSet, type Step } from './verification-chain';
import type { CIResult } from '@/types';

const DEBOUNCE_MS = 250;

export interface StartCommitWatcherOpts {
  runId: string;
  worktreePath: string;
  branch: string;
  /** Reads project manifests for resolveVerificationChain. Caller-injected so tests don't touch fs. */
  readManifests: () => Promise<ManifestSet>;
  /** Reads HEAD sha of the branch. Caller-injected so tests don't shell out. */
  readHeadSha: () => Promise<string>;
  /** Runs one verification step. Caller-injected for tests; production passes pipelineRunVerificationStep. */
  runStep: (step: Step) => Promise<VerificationStepResult>;
}

/**
 * Trim a trailing slash from the worktree path so we don't end up with
 * `/foo//.git/refs/heads`. Keeps the join Unix-style — the IPC normalizes.
 */
function refsHeadsDir(worktreePath: string): string {
  const trimmed = worktreePath.replace(/\/+$/, '');
  return `${trimmed}/.git/refs/heads`;
}

/** Does this fs-change path correspond to our branch's ref file? */
function isOurBranchRef(changedPath: string, branch: string): boolean {
  // git writes both `refs/heads/<branch>` and a transient `<branch>.lock` —
  // accept both since the lock-rename pair lands within the debounce window
  // and we don't want to miss the leading edge.
  const normalized = changedPath.replace(/\\/g, '/');
  return (
    normalized.endsWith(`/refs/heads/${branch}`) ||
    normalized.endsWith(`/refs/heads/${branch}.lock`)
  );
}

function vacuousPassResult(sha: string): CIResult {
  return {
    sha,
    status: 'pass',
    step: 'all',
    command: '<vacuous: no manifests detected>',
    durationMs: 0,
    failures: [],
  };
}

function failuresFromOutput(output: string): { test: string; output: string }[] {
  // We don't parse structured failures here — the Rust IPC returns a single
  // `output` blob. Surface the trailing chunk so the controller has something
  // human-readable. Phase 2c-ii may parse JUnit / cargo-test JSON.
  return [{ test: 'verification-step', output: output.slice(-2000) }];
}

/**
 * Run the verification chain for a single HEAD SHA. Stops on the first
 * failing step. Dispatches one `ci_pass` per passing step, then either a
 * trailing `ci_pass` is unnecessary (state machine is happy) or a single
 * `ci_fail` if a step failed. Returns when complete.
 *
 * Bails silently (no dispatch) if the run has left `building` while the chain
 * was running.
 */
async function runChainOnce(
  runId: string,
  readManifests: StartCommitWatcherOpts['readManifests'],
  readHeadSha: StartCommitWatcherOpts['readHeadSha'],
  runStep: StartCommitWatcherOpts['runStep'],
  worktreePath: string,
): Promise<void> {
  const { dispatch, runs } = usePipelineStore.getState();
  if (runs[runId]?.state !== 'building') return;

  const sha = await readHeadSha();
  const manifests = await readManifests();
  const chain = resolveVerificationChain(worktreePath, manifests);

  if (chain.length === 0) {
    if (usePipelineStore.getState().runs[runId]?.state !== 'building') return;
    dispatch(runId, { type: 'ci_pass', result: vacuousPassResult(sha) });
    return;
  }

  for (const step of chain) {
    if (usePipelineStore.getState().runs[runId]?.state !== 'building') return;

    const result = await runStep(step);

    if (usePipelineStore.getState().runs[runId]?.state !== 'building') return;

    const ciResult: CIResult = {
      sha,
      status: result.status,
      step: step.kind,
      command: step.command,
      durationMs: result.duration_ms,
      failures: result.status === 'fail' ? failuresFromOutput(result.output) : [],
    };

    if (result.status === 'fail') {
      dispatch(runId, { type: 'ci_fail', result: ciResult });
      return;
    }

    dispatch(runId, { type: 'ci_pass', result: ciResult });
  }
}

/**
 * Start watching the worktree's HEAD ref. Returns a cleanup fn that
 * unsubscribes the fs listener and unwatches the directory.
 *
 * Caller (Task 2c-i.6) is responsible for invoking the cleanup fn when the
 * run leaves `building` (e.g. transitions to `reviewing`, `done`, or any
 * terminal state).
 */
export async function startCommitWatcher(
  opts: StartCommitWatcherOpts,
): Promise<() => void> {
  const dir = refsHeadsDir(opts.worktreePath);
  await watchDirectory(dir);

  let inFlight = false;
  let pending = false;
  let stopped = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const drain = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      do {
        pending = false;
        try {
          await runChainOnce(
            opts.runId,
            opts.readManifests,
            opts.readHeadSha,
            opts.runStep,
            opts.worktreePath,
          );
        } catch (err) {
          // Chain explosion shouldn't kill the watcher — the next commit can
          // recover. Log loudly so the user sees it in devtools.
          console.warn('[pipeline] CI chain threw:', err);
        }
      } while (pending && !stopped);
    } finally {
      inFlight = false;
    }
  };

  const onChange = (path: string): void => {
    if (stopped) return;
    if (!isOurBranchRef(path, opts.branch)) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void drain();
    }, DEBOUNCE_MS);
  };

  // CLAUDE.md "Tauri event listener cleanup": onFsChange is async; mark stopped
  // before unlisten resolves so the late-arriving callback is a no-op.
  let unlistenFn: (() => void) | null = null;
  let unlistenSettled = false;
  const unlistenPromise = onFsChange(onChange).then(fn => {
    unlistenSettled = true;
    if (stopped) {
      // Cleanup ran before subscription resolved — tear down immediately.
      try { fn(); } catch { /* ignore */ }
      return;
    }
    unlistenFn = fn;
  });

  return () => {
    stopped = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (unlistenSettled && unlistenFn) {
      try { unlistenFn(); } catch { /* ignore */ }
      unlistenFn = null;
    }
    // Fire-and-forget the unwatch — failure here is non-fatal.
    void unwatchDirectory(dir).catch(() => { /* ignore */ });
    // Defensively await the unlisten resolution (ignored by the caller).
    void unlistenPromise;
  };
}
