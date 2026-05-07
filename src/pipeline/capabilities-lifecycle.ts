/**
 * Capabilities lifecycle (Phase 2c-ii.4).
 *
 * Subscribes to pipelineStore state transitions and maintains the worktree's
 * `.claude/settings.json` `permissions.allow` / `permissions.deny` arrays so
 * file-writes, shell verbs, network egress, and MCP tools are scoped per
 * agent role *before* the agent process spawns.
 *
 * Lifecycle:
 *   - Transition INTO `planning`  → install planner caps
 *   - Transition INTO `building`  → uninstall any previously-installed role,
 *                                   install builder caps
 *   - Transition INTO `reviewing` → uninstall any previously-installed role,
 *                                   install reviewer caps (read-only)
 *   - Transition INTO any terminal state → uninstall whichever role is
 *                                          currently installed for the run
 *
 * Per spec §17.1 the manifest must be installed *before* the agent process
 * spawns; the controller-runtime spawns the live PTY (or the one-shot
 * Reviewer) only after this lifecycle handler has run synchronously, so the
 * settings.json is on disk by the time Claude Code starts. The Rust IPCs
 * are themselves idempotent so a duplicate call is a no-op.
 *
 * Errors are logged but never rethrown — install/uninstall failures must
 * not block run progression. (A failed install means the agent runs with
 * the worktree's pre-existing scopes, not zero scopes.)
 */

import { isTerminalState } from './state-machine';
import { defaultRoleCapabilities } from './role-capabilities';
import {
  pipelineCapabilitiesInstall,
  pipelineCapabilitiesUninstall,
} from '@/utils/ipc';
import { emitTelemetry, type LifecycleEvent } from '@/stores/pipelineStore';
import type { PipelineRole, PipelineState } from '@/types';

/** Truncate `error` strings before they hit the JSONL line. */
const ERROR_MAX = 500;
function truncErr(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > ERROR_MAX ? s.slice(0, ERROR_MAX) : s;
}

/**
 * Map a pipeline state to the role whose capabilities should be active
 * during that state. Returns null for non-active states (terminal,
 * awaiting_*, idle) — those mean "no role currently scoped".
 */
export function activeRoleForState(state: PipelineState): PipelineRole | null {
  switch (state) {
    case 'planning':
      return 'planner';
    case 'building':
      return 'builder';
    case 'reviewing':
      return 'reviewer';
    default:
      return null;
  }
}

interface RunBookkeeping {
  /** Role whose caps are currently installed in this run's worktree, or null. */
  installedRole: PipelineRole | null;
}

const bookkeeping = new Map<string, RunBookkeeping>();

function track(runId: string): RunBookkeeping {
  let entry = bookkeeping.get(runId);
  if (!entry) {
    entry = { installedRole: null };
    bookkeeping.set(runId, entry);
  }
  return entry;
}

/**
 * Lifecycle handler — wire this via `setPipelineLifecycleEmitter` (composed
 * with the guardrails handler) at app boot.
 */
export function handleCapabilitiesLifecycle(ev: LifecycleEvent): void {
  if (!ev.worktreePath) return;

  const entry = track(ev.runId);
  const nextRole = activeRoleForState(ev.to as PipelineState);
  const reachedTerminal = isTerminalState(ev.to as PipelineState);

  // 1. If the role is changing (or the run is leaving an active stage),
  //    uninstall whatever was previously installed.
  if (entry.installedRole && entry.installedRole !== nextRole) {
    const previous = entry.installedRole;
    entry.installedRole = null;
    pipelineCapabilitiesUninstall({
      worktreeDir: ev.worktreePath,
      role: previous,
    }).then(
      () => {
        emitTelemetry({
          at: Date.now(),
          event: 'capability_uninstall',
          runId: ev.runId,
          projectId: ev.projectId,
          role: previous,
          ok: true,
        });
      },
      (err) => {
        console.warn(`[pipeline] capabilities uninstall failed for ${previous}:`, err);
        emitTelemetry({
          at: Date.now(),
          event: 'capability_uninstall',
          runId: ev.runId,
          projectId: ev.projectId,
          role: previous,
          ok: false,
          error: truncErr(err),
        });
      },
    );
  }

  // 2. If the new state has an active role, install its caps.
  //    Skip if the same role is already marked installed (idempotent fast-path).
  if (nextRole && entry.installedRole !== nextRole) {
    entry.installedRole = nextRole;
    const installRole = nextRole;
    const caps = defaultRoleCapabilities(installRole);
    pipelineCapabilitiesInstall({
      worktreeDir: ev.worktreePath,
      role: installRole,
      capabilities: caps,
    }).then(
      () => {
        emitTelemetry({
          at: Date.now(),
          event: 'capability_install',
          runId: ev.runId,
          projectId: ev.projectId,
          role: installRole,
          ok: true,
        });
      },
      (err) => {
        console.warn(`[pipeline] capabilities install failed for ${installRole}:`, err);
        emitTelemetry({
          at: Date.now(),
          event: 'capability_install',
          runId: ev.runId,
          projectId: ev.projectId,
          role: installRole,
          ok: false,
          error: truncErr(err),
        });
      },
    );
  }

  // 3. Terminal state: bookkeeping cleanup. Uninstall already happened
  //    above (entry.installedRole !== null && nextRole === null hits step 1).
  if (reachedTerminal) {
    bookkeeping.delete(ev.runId);
  }
}

/** Test helper — purge per-run bookkeeping between vitest cases. */
export function resetCapabilitiesLifecycleForTest(): void {
  bookkeeping.clear();
}
