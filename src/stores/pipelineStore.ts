import { create } from 'zustand';
import type { PipelineRun } from '@/types';
import {
  reducer,
  initialRunState,
  type PipelineEvent,
  type InitialRunInputs,
} from '@/pipeline/state-machine';

const TERMINAL = new Set(['done', 'failed', 'escalated']);

interface PipelineStoreShape {
  runs: Record<string, PipelineRun>;
  activeRunIds: string[];
  createRun(input: InitialRunInputs): string;
  dispatch(runId: string, ev: PipelineEvent): void;
  removeRun(runId: string): void;
}

function deriveActive(runs: Record<string, PipelineRun>): string[] {
  return Object.values(runs)
    .filter(r => !TERMINAL.has(r.state))
    .map(r => r.id);
}

export const usePipelineStore = create<PipelineStoreShape>((set) => ({
  runs: {},
  activeRunIds: [],

  createRun: (input) => {
    const run = initialRunState(input);
    set(s => {
      if (s.runs[run.id]) return s;               // idempotent on collision
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

      // Capture telemetry payload for fire-and-forget log after state update
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

      const runs = { ...s.runs, [runId]: next };
      return { runs, activeRunIds: deriveActive(runs) };
    });

    // Fire-and-forget. projectId here is the project root path the run was
    // created with (PipelineRun.projectId stores a filesystem path).
    if (logLine && projectId) {
      void import('@/utils/ipc').then(({ pipelineTelemetryLog }) =>
        pipelineTelemetryLog({ projectDir: projectId!, runId, line: logLine! })
          .catch(err => console.warn('[pipeline] telemetry log failed:', err)),
      );
    }
  },

  removeRun: (runId) => {
    set(s => {
      const { [runId]: _gone, ...rest } = s.runs;
      return { runs: rest, activeRunIds: deriveActive(rest) };
    });
  },
}));
