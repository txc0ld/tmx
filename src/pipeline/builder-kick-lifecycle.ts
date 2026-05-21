/**
 * Builder kick — handoff prompt sent on transition INTO `building`.
 *
 * The Planner's DONE sentinel carries a `planPath` artifact pointing at
 * `docs/superpowers/plans/<...>.md`. The agent-chain wire forwards the
 * Planner's tail output to the Builder when Planner goes idle, but the
 * wire fires asynchronously and may race with the state transition. The
 * lifecycle kick is the deterministic fallback: every entry into
 * `building` writes a short instruction to the Builder PTY pointing it
 * at the plan and telling it to begin executing.
 *
 * No-op for runs without a resolved Builder PTY (tile not yet spawned,
 * or test fixtures with no canvas). Per-run dedup so we don't double-fire
 * when (e.g.) a re-plan loops back into `building` with the same plan.
 */

import { useCanvasStore } from '@/stores/canvasStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import { ptyWrite } from '@/utils/ipc';
import type { LifecycleEvent } from '@/stores/pipelineStore';
import type { AgentTile, Tile } from '@/types';

interface KickDeps {
  /** Inject for tests. Defaults to the production canvasStore lookup. */
  resolveBuilderPty?: (runId: string) => string | undefined;
  /** Inject for tests. Defaults to the production PTY write IPC. */
  write?: typeof ptyWrite;
  /**
   * Inject for tests. Defaults to a lookup of the latest plan via
   * `pipelineStore.runs[runId].planLineage` (the source-of-truth chain
   * of commit SHAs and paths) plus the current `artifacts.plan` for the
   * actual `planPath`.
   */
  getLatestPlanPath?: (runId: string) => string | undefined;
  /**
   * Inject for tests. Defaults to a `pipelineStore.runs[runId]` lookup —
   * used to short-circuit when the run was restored from disk and has dead
   * PTYs (`agentsDisconnected === true`).
   */
  isAgentsDisconnected?: (runId: string) => boolean;
}

/**
 * Per-run set of plan paths we've already kicked the Builder for. Replans
 * write a new plan path (`-v2.md`, `-v3.md`) so the next kick fires; if
 * the plan path hasn't changed, we skip — avoids spamming the Builder if
 * the run loops `building → reviewing → building` from a reviewer reject.
 */
const kicked = new Map<string, string>();

function defaultResolveBuilderPty(runId: string): string | undefined {
  const run = usePipelineStore.getState().runs[runId];
  if (!run) return undefined;
  const tileId = run.tiles.builder;
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

function defaultGetLatestPlanPath(runId: string): string | undefined {
  const run = usePipelineStore.getState().runs[runId];
  return run?.artifacts.plan?.planPath;
}

function defaultIsAgentsDisconnected(runId: string): boolean {
  const run = usePipelineStore.getState().runs[runId];
  return run?.agentsDisconnected === true;
}

/**
 * Lifecycle handler signature matches the rest of the pipeline lifecycle
 * stack: receives a `TelemetryEvent` and acts on `state_change` events
 * with `to === 'building'`. Returns a Promise so the dispatcher can await
 * it for telemetry purposes — fire-and-forget callers can ignore.
 */
export function makeBuilderKickLifecycle(deps: KickDeps = {}) {
  const resolveBuilderPty = deps.resolveBuilderPty ?? defaultResolveBuilderPty;
  const write = deps.write ?? ptyWrite;
  const getLatestPlanPath = deps.getLatestPlanPath ?? defaultGetLatestPlanPath;
  const isAgentsDisconnected = deps.isAgentsDisconnected ?? defaultIsAgentsDisconnected;

  return function handleBuilderKickLifecycle(ev: LifecycleEvent): void {
    if (ev.to !== 'building') return;
    if (ev.from === 'building') return;

    // Restored-after-reload runs have dead PTYs. Writing to a stale id is a
    // silent no-op for the user; the controller banner already informs them
    // they need to launch a fresh run. Skip the kick.
    if (isAgentsDisconnected(ev.runId)) {
      console.info(`[pipeline] builder-kick skipped for ${ev.runId}: agents disconnected (run restored after reload)`);
      return;
    }

    const latestPlanPath = getLatestPlanPath(ev.runId);
    if (!latestPlanPath) return;

    if (kicked.get(ev.runId) === latestPlanPath) return;
    kicked.set(ev.runId, latestPlanPath);

    const ptyId = resolveBuilderPty(ev.runId);
    if (!ptyId) return;

    const message = [
      'The Planner has produced the plan and committed it to the run branch.',
      `Read \`${latestPlanPath}\` and begin executing the tasks in order.`,
      'Use the `superpowers:executing-plans` skill. Emit `<<<TX_STAGE_DONE>>>` per the `tx-pipeline-stage-handoff` protocol when the build is complete.',
      '',
    ].join('\n');

    // Fire-and-forget. Lifecycle handlers are sync (LifecycleEvent has no
    // event discriminator) so we kick off the write asynchronously and let
    // any failure log itself.
    (async () => {
      try {
        await write(ptyId, message);
        // Brief delay before the carriage return so the agent's input
        // field settles after the paste. Mirrors role-prompt-injection.
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        await write(ptyId, '\r');
      } catch (err) {
        console.warn(`[pipeline] builder-kick PTY write failed for ${ev.runId}:`, err);
      }
    })();
  };
}

/**
 * Test-only: clear the per-run kicked-plans bookkeeping. Production never
 * needs this (a run id is unique-per-launch and the entry GCs naturally
 * with `clearRunBuffers` on terminal). Tests reset between cases so we
 * expose the hook explicitly.
 */
export function _resetBuilderKickForTest(): void {
  kicked.clear();
}

/** Default exported handler — what App.tsx wires. Production deps. */
export const handleBuilderKickLifecycle = makeBuilderKickLifecycle();
