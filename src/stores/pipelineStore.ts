import { create } from 'zustand';
import type { PipelineRole, PipelineRun } from '@/types';
import {
  reducer,
  initialRunState,
  isTerminalState,
  type PipelineEvent,
  type InitialRunInputs,
} from '@/pipeline/state-machine';

/**
 * Telemetry emitter — registered at app boot via `setPipelineTelemetryEmitter`
 * so this module stays free of IPC concerns. Tests leave it unset (no-op).
 *
 * `TelemetryEvent` is a discriminated union over `event`. The Rust IPC
 * (`pipeline_telemetry_log`) writes `JSON.stringify(ev)` as one JSONL line and
 * is agnostic to the exact shape — every variant carries `runId` + `projectId`
 * which is all App.tsx's wiring needs.
 */
export interface StateChangeTelemetryEvent {
  at: number;
  event: 'state_change';
  runId: string;
  projectId: string;
  from: string;
  to: string;
  trigger: string;
}

/** Capability/guardrails install/uninstall outcome. (Phase 2c-ii.7) */
export interface LifecycleTelemetryEvent {
  at: number;
  event:
    | 'capability_install'
    | 'capability_uninstall'
    | 'guardrails_install'
    | 'guardrails_uninstall';
  runId: string;
  projectId: string;
  /**
   * Role on capability events; undefined on guardrails (worktree-wide).
   * Typed as `PipelineRole` for ergonomics — `controller` never reaches the
   * capability install/uninstall path (filtered by `activeRoleForState`).
   */
  role?: PipelineRole;
  /** True when the IPC call succeeded; false on failure. */
  ok: boolean;
  /** Optional failure detail (truncated to ~500 chars). */
  error?: string;
}

/** Merger invocation outcome. (Phase 2c-ii.7) */
export interface MergerTelemetryEvent {
  at: number;
  event: 'merger_invoked' | 'merger_completed';
  runId: string;
  projectId: string;
  /** On merger_completed: the result.status field. */
  status?: 'success' | 'failure' | 'invalid_token';
  /** On merger_completed: the result.mode field. */
  mode?: 'pr' | 'local' | 'unknown';
  /** Optional detail when not success (truncated to ~500 chars). */
  detail?: string;
}

export type TelemetryEvent =
  | StateChangeTelemetryEvent
  | LifecycleTelemetryEvent
  | MergerTelemetryEvent;

type TelemetryEmitter = (event: TelemetryEvent) => void;
let telemetryEmitter: TelemetryEmitter | null = null;

export function setPipelineTelemetryEmitter(fn: TelemetryEmitter | null): void {
  telemetryEmitter = fn;
}

/**
 * Emit a telemetry event from outside the store reducer. Used by the
 * lifecycle handlers (capabilities/guardrails) and the MergerConfirmModal
 * to record outcomes that aren't tied to a state-machine transition.
 *
 * Safe no-op when no emitter is registered (e.g. vitest jsdom).
 */
export function emitTelemetry(event: TelemetryEvent): void {
  if (!telemetryEmitter) return;
  try {
    telemetryEmitter(event);
  } catch (err) {
    console.warn('[pipeline] telemetry emitter threw:', err);
  }
}

/**
 * Lifecycle emitter — fires once per state transition. App.tsx wires it
 * to the guardrails install/uninstall IPCs (Phase 2c-ii.3) so the
 * worktree's `.claude/settings.json` PreToolUse hook list is maintained
 * for the active run window only. Tests leave it unset (no-op).
 *
 * Distinct from `TelemetryEmitter`: telemetry is fire-and-forget JSONL
 * persistence; lifecycle hooks may need to dedupe (multiple transitions
 * within `idle → planning → … → done` should install once, uninstall once)
 * and the consumer owns that bookkeeping.
 */
export interface LifecycleEvent {
  runId: string;
  projectId: string;
  worktreePath: string;
  from: string;
  to: string;
  trigger: string;
}
type LifecycleEmitter = (event: LifecycleEvent) => void;
let lifecycleEmitter: LifecycleEmitter | null = null;

export function setPipelineLifecycleEmitter(fn: LifecycleEmitter | null): void {
  lifecycleEmitter = fn;
}

interface PipelineStoreShape {
  runs: Record<string, PipelineRun>;
  activeRunIds: string[];
  createRun(input: InitialRunInputs): string;
  dispatch(runId: string, ev: PipelineEvent): void;
  removeRun(runId: string): void;
}

function deriveActive(runs: Record<string, PipelineRun>): string[] {
  return Object.values(runs)
    .filter(r => !isTerminalState(r.state))
    .map(r => r.id);
}

export const usePipelineStore = create<PipelineStoreShape>((set) => ({
  runs: {},
  activeRunIds: [],

  createRun: (input) => {
    const run = initialRunState(input);
    set(s => {
      if (s.runs[run.id]) return s;
      const runs = { ...s.runs, [run.id]: run };
      return { runs, activeRunIds: deriveActive(runs) };
    });
    return run.id;
  },

  dispatch: (runId, ev) => {
    let pendingTelemetry: StateChangeTelemetryEvent | null = null;
    let pendingLifecycle: LifecycleEvent | null = null;
    set(s => {
      const existing = s.runs[runId];
      if (!existing) return s;
      const next = reducer(existing, ev);
      if (next === existing) return s;

      if (existing.state !== next.state) {
        pendingTelemetry = {
          at: Date.now(),
          event: 'state_change',
          runId,
          projectId: existing.projectId,
          from: existing.state,
          to: next.state,
          trigger: ev.type,
        };
        pendingLifecycle = {
          runId,
          projectId: existing.projectId,
          worktreePath: existing.worktreePath,
          from: existing.state,
          to: next.state,
          trigger: ev.type,
        };
      }

      // activeRunIds membership only changes when a run crosses the terminal
      // boundary; otherwise reuse the prior reference so subscribers selecting
      // `activeRunIds` don't re-render needlessly.
      const terminalBoundaryCrossed =
        isTerminalState(existing.state) !== isTerminalState(next.state);
      const runs = { ...s.runs, [runId]: next };
      const activeRunIds = terminalBoundaryCrossed ? deriveActive(runs) : s.activeRunIds;
      return { runs, activeRunIds };
    });

    if (pendingTelemetry && telemetryEmitter) {
      try {
        telemetryEmitter(pendingTelemetry);
      } catch (err) {
        console.warn('[pipeline] telemetry emitter threw:', err);
      }
    }
    if (pendingLifecycle && lifecycleEmitter) {
      try {
        lifecycleEmitter(pendingLifecycle);
      } catch (err) {
        console.warn('[pipeline] lifecycle emitter threw:', err);
      }
    }
  },

  removeRun: (runId) => {
    set(s => {
      const { [runId]: _gone, ...rest } = s.runs;
      return { runs: rest, activeRunIds: deriveActive(rest) };
    });
  },
}));
