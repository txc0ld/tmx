/**
 * Failure-bundle lifecycle (Phase 2c-iii.7).
 *
 * Subscribes to pipelineStore state transitions and writes a single
 * tar.gz failure bundle on the first crossing into a terminal-FAILURE
 * state (`failed` or `escalated`). Successful runs (`done`) don't get
 * a bundle — there's nothing to post-mortem.
 *
 * The bundle path is `<projectDir>/.terminalx/failure-bundles/<run-id>.tar.gz`
 * and the contents (telemetry, artifacts, preflight, git status/diff,
 * versions) are described in `commands/failure_bundle.rs`. Every text
 * artifact is masked through `secretsMask` server-side before
 * tar-archiving — a forgotten frontend-side mask call cannot leak.
 *
 * Bookkeeping note
 * ────────────────
 * One bundle per run id. `bookkeeping` tracks whether we've already
 * generated for a run so re-entries (`escalated → planning` via replan,
 * then `failed` again) get a second bundle (the prior one would be
 * overwritten by the Rust IPC's `File::create`, which is the right
 * behavior — the latest failure context is what's interesting).
 *
 * Errors are swallowed (logged via `console.warn`). A failed bundle
 * write must not block the run's terminal-state cleanup.
 */

import { isTerminalState } from './state-machine';
import { useProjectStore } from '@/stores/projectStore';
import { usePipelineStore, type LifecycleEvent } from '@/stores/pipelineStore';
import { pipelineFailureBundleGenerate } from '@/utils/ipc';
import type { PipelineState } from '@/types';

const TERMINALX_VERSION = '0.1.0';

/** States that warrant a bundle. `done` is a successful terminal state. */
const FAILURE_STATES: ReadonlySet<PipelineState> = new Set<PipelineState>([
  'failed',
  'escalated',
]);

interface RunBookkeeping {
  generated: boolean;
}

const bookkeeping = new Map<string, RunBookkeeping>();

function track(runId: string): RunBookkeeping {
  let entry = bookkeeping.get(runId);
  if (!entry) {
    entry = { generated: false };
    bookkeeping.set(runId, entry);
  }
  return entry;
}

/**
 * Resolve the project's source-of-truth `cwd` from `projectStore`. The
 * pipeline run's `worktreePath` is a derived sibling — bundles must land
 * in the canonical project dir so they survive worktree teardown.
 */
function resolveProjectCwd(projectId: string): string | null {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  return project?.cwd ?? null;
}

/**
 * Lifecycle handler — composed alongside guardrails / capabilities at
 * app boot. Pure side effects; safe to call repeatedly with the same
 * event shape.
 */
export function handleFailureBundleLifecycle(ev: LifecycleEvent): void {
  if (!isTerminalState(ev.to as PipelineState)) return;
  if (!FAILURE_STATES.has(ev.to as PipelineState)) return;

  const entry = track(ev.runId);
  if (entry.generated) return;
  entry.generated = true;

  const run = usePipelineStore.getState().runs[ev.runId];
  if (!run) {
    console.warn('[pipeline] failure-bundle: run not found in store:', ev.runId);
    return;
  }

  const projectCwd = resolveProjectCwd(ev.projectId);
  if (!projectCwd) {
    console.warn(
      '[pipeline] failure-bundle: no project cwd for projectId:',
      ev.projectId,
    );
    return;
  }

  // Serialize artifacts inline. The reducer guarantees `run.artifacts`
  // is the full `PipelineRunArtifacts` so JSON.stringify is total.
  let artifactsJson: string;
  try {
    artifactsJson = JSON.stringify(run.artifacts);
  } catch (e) {
    console.warn('[pipeline] failure-bundle: artifacts serialize failed:', e);
    artifactsJson = '{}';
  }

  // Preflight is not on the run shape today (Phase 1 ran preflight at
  // start but did not persist the result onto the run). Send an empty
  // object — the bundle still includes the entry so consumers can
  // distinguish "no preflight" from "preflight missing".
  const preflightJson = '{}';

  pipelineFailureBundleGenerate({
    runId: ev.runId,
    projectDir: projectCwd,
    branch: run.branch,
    baseBranch: run.baseBranch,
    artifactsJson,
    preflightJson,
    terminalxVersion: run.fingerprint.terminalxVersion || TERMINALX_VERSION,
    claudeVersion: run.fingerprint.claudeVersion,
    codexVersion: run.fingerprint.codexVersion,
  })
    .then((res) => {
      console.info(
        `[pipeline] failure bundle: ${res.bundle_path} (${res.size_bytes}B, ${res.entries.length} entries)`,
      );
    })
    .catch((err) => {
      console.warn('[pipeline] failure bundle generate failed:', err);
    });
}

/** Test helper — purge the per-run bookkeeping map between vitest cases. */
export function resetFailureBundleLifecycleForTest(): void {
  bookkeeping.clear();
}
