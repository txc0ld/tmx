/**
 * Global PTY → controller-runtime router.
 *
 * Closes the runtime gap that left `ingestPtyChunk` test-only: agents
 * spawned by `launchPipelineRun` carry `pipelineRunId` + `pipelineRole`
 * on their `AgentTile`. We maintain a `ptyId → { runId, role }` map by
 * subscribing to `canvasStore`, then forward every matching `pty-output`
 * event into `ingestPtyChunk`. Without this the controller-runtime
 * sentinel parser never sees the agents' output and the state machine
 * never advances past `planning`.
 *
 * Headless / DI'd so the smoke tests can drive it with mocked IPC + a
 * fake canvas store.
 */

import { onPtyOutput } from '@/utils/ipc';
import { useCanvasStore } from '@/stores/canvasStore';
import { ingestPtyChunk } from './controller-runtime';
import type { AgentTile, Tile } from '@/types';

type PipelineAgentRole = 'planner' | 'builder' | 'reviewer';

interface RouteEntry {
  runId: string;
  role: PipelineAgentRole;
}

/**
 * Walk every project's tile array and emit the current ptyId → binding
 * map. Bound at canvasStore-subscription time, so this re-runs only
 * when the tile list mutates (add / remove / update).
 */
function buildRouteMap(tiles: Record<string, Tile[]>): Map<string, RouteEntry> {
  const map = new Map<string, RouteEntry>();
  for (const list of Object.values(tiles)) {
    if (!list) continue;
    for (const t of list) {
      if (t.type !== 'agent') continue;
      const a = t as AgentTile;
      if (!a.ptyId || !a.pipelineRunId || !a.pipelineRole) continue;
      map.set(a.ptyId, { runId: a.pipelineRunId, role: a.pipelineRole });
    }
  }
  return map;
}

export interface PipelinePtyRouterDeps {
  /** Inject for tests. Defaults to the real Tauri IPC listener. */
  listen?: typeof onPtyOutput;
  /** Inject for tests. Defaults to the production canvasStore. */
  subscribeTiles?: (cb: (tiles: Record<string, Tile[]>) => void) => () => void;
  /** Inject for tests. Defaults to the production controller-runtime ingest. */
  ingest?: typeof ingestPtyChunk;
}

/**
 * Start the router. Returns a stop function that detaches both the PTY
 * listener and the canvas-store subscription.
 *
 * Idempotent at the call-site level only — if you call this twice you
 * get two listeners. Wire it once at App mount.
 */
export function startPipelinePtyRouter(deps: PipelinePtyRouterDeps = {}): () => void {
  const listen = deps.listen ?? onPtyOutput;
  const ingest = deps.ingest ?? ingestPtyChunk;
  const subscribeTiles =
    deps.subscribeTiles ??
    ((cb) =>
      useCanvasStore.subscribe((s, prev) => {
        if (s.tiles !== prev.tiles) cb(s.tiles);
      }));

  let routeMap = buildRouteMap(useCanvasStore.getState().tiles);

  const offSub = subscribeTiles((tiles) => {
    routeMap = buildRouteMap(tiles);
  });

  let detachListener: (() => void) | null = null;
  let stopped = false;

  // `onPtyOutput` is async; the unlisten fn lands later. Guard against
  // a stop() call that races the resolution by setting a flag.
  void listen((evt) => {
    if (stopped) return;
    const entry = routeMap.get(evt.id);
    if (!entry) return;
    ingest({ runId: entry.runId, role: entry.role, chunk: evt.data });
  })
    .then((un) => {
      if (stopped) {
        un();
        return;
      }
      detachListener = un;
    })
    .catch((err) => {
      console.warn('[pipeline] PTY router listen failed:', err);
    });

  return () => {
    stopped = true;
    offSub();
    detachListener?.();
  };
}
