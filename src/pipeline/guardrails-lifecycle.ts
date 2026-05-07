/**
 * Guardrails lifecycle (Phase 2c-ii.3).
 *
 * Subscribes to pipelineStore state transitions and maintains the
 * worktree's `.claude/settings.json` PreToolUse hook list:
 *
 *   - On the FIRST transition out of `idle` (typically `idle → planning`),
 *     install a marked entry pointing at `git-guardrails-claude-code`'s
 *     block-dangerous-git.sh. The Rust IPC is itself idempotent, but we
 *     dedupe per run so we don't fire repeated IPCs on every later
 *     transition.
 *
 *   - On the FIRST transition into a terminal state (`done` / `failed` /
 *     `escalated`), uninstall the marked entry. Again deduped per run so
 *     a re-entry from `escalated → planning` (replan) re-installs cleanly.
 *
 * Errors are logged but never rethrown — a failed hook install can't block
 * the run from progressing, and a failed uninstall can't trap the run in
 * a non-terminal state.
 */

import { isTerminalState } from './state-machine';
import {
  pipelineGuardrailsInstall,
  pipelineGuardrailsUninstall,
} from '@/utils/ipc';
import { emitTelemetry, type LifecycleEvent } from '@/stores/pipelineStore';
import type { PipelineState } from '@/types';

/** Truncate `error` strings before they hit the JSONL line. */
const ERROR_MAX = 500;
function truncErr(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > ERROR_MAX ? s.slice(0, ERROR_MAX) : s;
}

interface RunBookkeeping {
  installed: boolean;
  uninstalled: boolean;
}

const bookkeeping = new Map<string, RunBookkeeping>();

/** Track install/uninstall idempotently per run id. */
function track(runId: string): RunBookkeeping {
  let entry = bookkeeping.get(runId);
  if (!entry) {
    entry = { installed: false, uninstalled: false };
    bookkeeping.set(runId, entry);
  }
  return entry;
}

/**
 * Lifecycle handler — wire this via `setPipelineLifecycleEmitter` at app
 * boot. Pure side effects; safe to call repeatedly with the same event
 * shape (the bookkeeping ensures one install + one uninstall per run).
 */
export function handleGuardrailsLifecycle(ev: LifecycleEvent): void {
  const entry = track(ev.runId);
  const reachedTerminal = isTerminalState(ev.to as PipelineState);

  // Install on the first transition out of `idle`.
  // Note: do NOT `return` here — a single transition can be both
  // "out of idle" AND "into terminal" (e.g. `idle → failed` via abort
  // during preflight). Both effects must fire so the hook gets cleaned up.
  if (!entry.installed && ev.from === 'idle' && ev.to !== 'idle') {
    entry.installed = true;
    if (ev.worktreePath) {
      pipelineGuardrailsInstall(ev.worktreePath).then(
        () => {
          emitTelemetry({
            at: Date.now(),
            event: 'guardrails_install',
            runId: ev.runId,
            projectId: ev.projectId,
            ok: true,
          });
        },
        (err) => {
          console.warn('[pipeline] guardrails install failed:', err);
          emitTelemetry({
            at: Date.now(),
            event: 'guardrails_install',
            runId: ev.runId,
            projectId: ev.projectId,
            ok: false,
            error: truncErr(err),
          });
        },
      );
    }
  }

  // Uninstall on the first crossing into a terminal state.
  if (!entry.uninstalled && reachedTerminal) {
    entry.uninstalled = true;
    if (ev.worktreePath) {
      pipelineGuardrailsUninstall(ev.worktreePath).then(
        () => {
          emitTelemetry({
            at: Date.now(),
            event: 'guardrails_uninstall',
            runId: ev.runId,
            projectId: ev.projectId,
            ok: true,
          });
        },
        (err) => {
          console.warn('[pipeline] guardrails uninstall failed:', err);
          emitTelemetry({
            at: Date.now(),
            event: 'guardrails_uninstall',
            runId: ev.runId,
            projectId: ev.projectId,
            ok: false,
            error: truncErr(err),
          });
        },
      );
    }
    return;
  }

  // Re-entry from terminal (e.g. `escalated → planning` via replan_requested):
  // reset the uninstall flag so the next terminal crossing fires uninstall
  // again. Don't re-install: replan keeps the same worktree, install IPC is
  // already idempotent on disk, and bookkeeping suppresses redundant calls.
  if (entry.uninstalled && !reachedTerminal) {
    entry.uninstalled = false;
  }
}

/** Test helper — purge the per-run bookkeeping map between vitest cases. */
export function resetGuardrailsLifecycleForTest(): void {
  bookkeeping.clear();
}
