import { create } from 'zustand';
import type { PipelineRun } from '@/types';
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
 */
export interface TelemetryEvent {
  at: number;
  event: 'state_change';
  runId: string;
  projectId: string;
  from: string;
  to: string;
  trigger: string;
}
type TelemetryEmitter = (event: TelemetryEvent) => void;
let telemetryEmitter: TelemetryEmitter | null = null;

export function setPipelineTelemetryEmitter(fn: TelemetryEmitter | null): void {
  telemetryEmitter = fn;
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
    let pendingTelemetry: TelemetryEvent | null = null;
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
  },

  removeRun: (runId) => {
    set(s => {
      const { [runId]: _gone, ...rest } = s.runs;
      return { runs: rest, activeRunIds: deriveActive(rest) };
    });
  },
}));
