/**
 * Planner re-run kick — handoff prompt sent to the Planner PTY when a run
 * loops `awaiting_plan_approval → planning` after a `reject_plan` event.
 *
 * Unlike `replan_requested` (which fires from `escalated` and re-spawns the
 * full pipeline through the run-factory), `reject_plan` keeps the live
 * Planner tile mounted and re-uses its PTY. The state machine bumps
 * `retryCounters.planReject` and pushes the user's feedback onto
 * `artifacts.questions`, but the Planner agent itself doesn't see anything
 * unless we explicitly write to its PTY. This lifecycle handler closes
 * that gap: on every transition INTO `planning` whose `from` was
 * `awaiting_plan_approval`, we resolve the latest rejection feedback from
 * `artifacts.questions` and write a short instruction telling the Planner
 * to revise the plan addressing that feedback.
 *
 * Sibling to `builder-kick-lifecycle.ts` — same canvas-store walk to
 * resolve the role's PTY, same fire-and-forget swallow-error pattern,
 * same `agentsDisconnected` short-circuit for runs restored after reload.
 */

import { useCanvasStore } from '@/stores/canvasStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import { ptyWrite } from '@/utils/ipc';
import type { LifecycleEvent } from '@/stores/pipelineStore';
import type { AgentTile, Tile } from '@/types';

interface RerunDeps {
  /** Inject for tests. Defaults to the production canvasStore lookup. */
  resolvePlannerPty?: (runId: string) => string | undefined;
  /** Inject for tests. Defaults to the production PTY write IPC. */
  write?: typeof ptyWrite;
  /**
   * Inject for tests. Defaults to a `pipelineStore.runs[runId]` lookup of
   * the most-recent `artifacts.questions` entry whose `stage === 'planner'`.
   */
  getLatestRejectionFeedback?: (runId: string) => string | undefined;
  /**
   * Inject for tests. Defaults to a `pipelineStore.runs[runId]` lookup —
   * mirrors builder-kick-lifecycle so restored-after-reload runs short-circuit.
   */
  isAgentsDisconnected?: (runId: string) => boolean;
}

function defaultResolvePlannerPty(runId: string): string | undefined {
  const run = usePipelineStore.getState().runs[runId];
  if (!run) return undefined;
  const tileId = run.tiles.planner;
  if (!tileId) return undefined;
  const projectTiles = useCanvasStore.getState().tiles;
  for (const list of Object.values(projectTiles)) {
    const arr = list as Tile[] | undefined;
    if (!arr) continue;
    const found = arr.find((t) => t.id === tileId);
    if (found && found.type === 'agent') return (found as AgentTile).ptyId;
  }
  return undefined;
}

function defaultGetLatestRejectionFeedback(runId: string): string | undefined {
  const run = usePipelineStore.getState().runs[runId];
  if (!run) return undefined;
  // Walk backward — the most recently appended planner-stage question is
  // the rejection that caused this transition.
  for (let i = run.artifacts.questions.length - 1; i >= 0; i--) {
    const q = run.artifacts.questions[i];
    if (q.stage === 'planner') return q.context;
  }
  return undefined;
}

function defaultIsAgentsDisconnected(runId: string): boolean {
  const run = usePipelineStore.getState().runs[runId];
  return run?.agentsDisconnected === true;
}

/**
 * Lifecycle handler factory. Receives a `LifecycleEvent` and acts only on
 * `awaiting_plan_approval → planning` transitions, which are uniquely
 * produced by the `reject_plan` reducer case (the only other path into
 * `planning` is `idle → planning` from `start`, which doesn't need a kick).
 */
export function makePlannerRerunLifecycle(deps: RerunDeps = {}) {
  const resolvePlannerPty = deps.resolvePlannerPty ?? defaultResolvePlannerPty;
  const write = deps.write ?? ptyWrite;
  const getLatestRejectionFeedback = deps.getLatestRejectionFeedback ?? defaultGetLatestRejectionFeedback;
  const isAgentsDisconnected = deps.isAgentsDisconnected ?? defaultIsAgentsDisconnected;

  return function handlePlannerRerunLifecycle(ev: LifecycleEvent): void {
    if (ev.to !== 'planning') return;
    if (ev.from !== 'awaiting_plan_approval') return;

    if (isAgentsDisconnected(ev.runId)) {
      console.info(`[pipeline] planner-rerun skipped for ${ev.runId}: agents disconnected (run restored after reload)`);
      return;
    }

    const feedback = getLatestRejectionFeedback(ev.runId);
    if (!feedback) {
      // Defensive: the reducer always appends a planner-stage question on
      // `reject_plan`, so this branch should be unreachable. Log + skip
      // rather than corrupting the Planner with a half-formed prompt.
      console.warn(`[pipeline] planner-rerun: no rejection feedback found for ${ev.runId}; skipping kick`);
      return;
    }

    const ptyId = resolvePlannerPty(ev.runId);
    if (!ptyId) return;

    const message = [
      'The previous plan was rejected. Reason:',
      feedback,
      '',
      'Read the feedback carefully and produce a revised plan addressing it. Same artifacts (spec + plan), new commit, fresh DONE sentinel.',
      '',
    ].join('\n');

    // Fire-and-forget. Same shape as builder-kick-lifecycle.
    (async () => {
      try {
        await write(ptyId, message);
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        await write(ptyId, '\r');
      } catch (err) {
        console.warn(`[pipeline] planner-rerun PTY write failed for ${ev.runId}:`, err);
      }
    })();
  };
}

/** Default exported handler — what App.tsx wires. Production deps. */
export const handlePlannerRerunLifecycle = makePlannerRerunLifecycle();
