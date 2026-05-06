import { create } from 'zustand';
import type { PipelineRun } from '@/types';
import { pipelineTelemetryLog } from '@/utils/ipc';
import {
  reducer,
  initialRunState,
  isTerminalState,
  type PipelineEvent,
  type InitialRunInputs,
} from '@/pipeline/state-machine';

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
    let logLine: string | null = null;
    let projectId: string | null = null;
    set(s => {
      const existing = s.runs[runId];
      if (!existing) return s;
      const next = reducer(existing, ev);
      if (next === existing) return s;

      const stateChanged = existing.state !== next.state;
      if (stateChanged) {
        projectId = existing.projectId;
        logLine = JSON.stringify({
          at: Date.now(),
          event: 'state_change',
          runId,
          from: existing.state,
          to: next.state,
          trigger: ev.type,
        });
      }

      // activeRunIds membership only changes when a run crosses the
      // terminal boundary; otherwise reuse the prior reference so
      // subscribers selecting `activeRunIds` don't re-render needlessly.
      const terminalBoundaryCrossed =
        isTerminalState(existing.state) !== isTerminalState(next.state);
      const runs = { ...s.runs, [runId]: next };
      const activeRunIds = terminalBoundaryCrossed
        ? deriveActive(runs)
        : s.activeRunIds;
      return { runs, activeRunIds };
    });

    if (logLine && projectId) {
      pipelineTelemetryLog({ projectDir: projectId, runId, line: logLine })
        .catch(err => console.warn('[pipeline] telemetry log failed:', err));
    }
  },

  removeRun: (runId) => {
    set(s => {
      const { [runId]: _gone, ...rest } = s.runs;
      return { runs: rest, activeRunIds: deriveActive(rest) };
    });
  },
}));
