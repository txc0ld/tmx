import { useEffect, useRef } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useToastStore } from '@/stores/toastStore';
import { ptyWrite } from '@/utils/ipc';
import { isAgentTile, hasPty } from '@/utils/tileTypeGuards';
import { sendNotification } from '@tauri-apps/plugin-notification';
import type { Wire, Tile } from '@/types';

const EMPTY_WIRES: Wire[] = [];
const EMPTY_TILES: Tile[] = [];

/**
 * Wiring engine: watches wireData changes and activates wires
 * when data flows from source to destination tiles.
 *
 * Wire types:
 *  - context-pipe (terminal->agent): accumulate terminal output as context
 *  - refresh-trigger (agent->browser): when agent completes, notify
 *  - agent-chain (agent->agent): pipe output summary as task to destination agent
 *  - task-assign / diff-feed: future
 */
export function useWiringEngine() {
  const prevWireDataRef = useRef<Record<string, string>>({});
  const prevAgentStatusRef = useRef<Record<string, string>>({});
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const pendingTimers = useRef(new Set<number>()); // used in effect cleanup

  // Re-entry guard: when handlers call setWireActive / updateTile, Zustand
  // notifies subscribers synchronously — without this flag we'd recurse
  // into ourselves before prevAgentStatusRef has been committed, and fire
  // the same transition handler repeatedly (infinite loop).
  const reentryGuard = useRef(false);

  useEffect(() => {
    const unsub = useCanvasStore.subscribe((state, prev) => {
      // Engine only cares about data/wire/tile-shape changes. Focus,
      // selection, bookmarks, transforms — not us. Cheap ref-check lets
      // those pass through without paying for a full O(wires × tiles) pass.
      // This alone shaves ~50-70% of engine invocations in typical use
      // (every focus/hover/selection update would otherwise fire one).
      if (
        state.wireData === prev.wireData &&
        state.tiles === prev.tiles &&
        state.wires === prev.wires &&
        state.activeProject === prev.activeProject
      ) {
        return;
      }
      if (reentryGuard.current) return;
      reentryGuard.current = true;
      try {
        runEngine(state);
      } finally {
        reentryGuard.current = false;
      }
    });

    function runEngine(state: ReturnType<typeof useCanvasStore.getState>) {
      const pid = state.activeProject;
      if (!pid) return;

      const wires = state.wires[pid] ?? EMPTY_WIRES;
      if (wires.length === 0) return;

      const wireData = state.wireData;
      const prevWireData = prevWireDataRef.current;

      const tiles = state.tiles[pid] ?? EMPTY_TILES;
      const tileById = new Map(tiles.map(t => [t.id, t]));

      // Track agent status changes for chain/trigger wires
      const prevStatuses = prevAgentStatusRef.current;
      const nextStatuses: Record<string, string> = {};

      for (const tile of tiles) {
        if (isAgentTile(tile)) {
          nextStatuses[tile.id] = tile.status;
        }
      }

      // Commit prevStatuses IMMEDIATELY so any re-entrant subscriber fires
      // (from setWireActive/updateTile below) see the already-processed
      // transitions as "previous" and don't replay the same handler.
      prevAgentStatusRef.current = nextStatuses;

      for (const wire of wires) {
        const fromTile = tileById.get(wire.fromTile);
        const toTile = tileById.get(wire.toTile);
        if (!fromTile || !toTile) continue;

        // ─── Data flow activation (context-pipe) ─────────
        const fromPtyId = hasPty(fromTile) ? fromTile.ptyId : undefined;
        if (fromPtyId) {
          const currentData = wireData[fromPtyId] || '';
          const prevData = prevWireData[fromPtyId] || '';

          if (currentData !== prevData && currentData.length > prevData.length) {
            if (!wire.active) {
              state.setWireActive(wire.id, true);
              const timerId = window.setTimeout(() => {
                pendingTimers.current.delete(timerId);
                useCanvasStore.getState().setWireActive(wire.id, false);
              }, 2000);
              pendingTimers.current.add(timerId);
            }
          }
        }

        // ─── Agent chain (agent->agent) ──────────────────
        if (wire.wireType === 'agent-chain' && isAgentTile(fromTile) && isAgentTile(toTile)) {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = fromTile.status;

          // Agent just completed
          if (prevStatus && prevStatus !== 'done' && currStatus === 'done') {
            const toPtyId = toTile.ptyId;
            if (toPtyId) {
              // Collect wireData from the source agent
              const sourceData = wireData[fromPtyId || ''] || '';
              const lines = sourceData.split('\n');
              const last50 = lines.slice(-50).join('\n');
              const payload = `\n--- Context from previous agent (${fromTile.title || fromTile.id}) ---\n${last50}\n--- End context ---\n`;

              ptyWrite(toPtyId, payload).catch(() => {});

              // Activate wire for animation
              state.setWireActive(wire.id, true);
              const chainTimerId = window.setTimeout(() => {
                pendingTimers.current.delete(chainTimerId);
                useCanvasStore.getState().setWireActive(wire.id, false);
              }, 3000);
              pendingTimers.current.add(chainTimerId);
            }
          }
        }

        // ─── Refresh trigger (agent->browser) ────────────
        if (wire.wireType === 'refresh-trigger' && isAgentTile(fromTile)) {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = fromTile.status;

          if (prevStatus && prevStatus !== 'done' && currStatus === 'done') {
            // Show a notification since we can't actually refresh a webview
            useToastStore.getState().addToast(
              `Agent completed — browser tile "${toTile.title || toTile.id}" would refresh`,
              'info',
            );

            state.setWireActive(wire.id, true);
            const refreshTimerId = window.setTimeout(() => {
              pendingTimers.current.delete(refreshTimerId);
              useCanvasStore.getState().setWireActive(wire.id, false);
            }, 2000);
            pendingTimers.current.add(refreshTimerId);
          }
        }

        // ─── Context pipe: auto-pipe on agent completion ──
        if (wire.wireType === 'context-pipe' && isAgentTile(fromTile)) {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = fromTile.status;

          if (prevStatus && prevStatus !== 'done' && currStatus === 'done') {
            const toPtyId = hasPty(toTile) ? toTile.ptyId : undefined;
            if (toPtyId) {
              const sourceData = wireData[fromPtyId || ''] || '';
              const lines = sourceData.split('\n');
              const last50 = lines.slice(-50).join('\n');
              const payload = `\n--- Context from ${fromTile.title || fromTile.id} ---\n${last50}\n--- End context ---\n`;
              ptyWrite(toPtyId, payload).catch(() => {});

              state.setWireActive(wire.id, true);
              const pipeTimerId = window.setTimeout(() => {
                pendingTimers.current.delete(pipeTimerId);
                useCanvasStore.getState().setWireActive(wire.id, false);
              }, 2500);
              pendingTimers.current.add(pipeTimerId);
            }
          }
        }

        // ─── Task assign (agent->todo) ───────────────────
        if (wire.wireType === 'task-assign' && isAgentTile(fromTile) && toTile.type === 'todo') {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = fromTile.status;

          if (prevStatus && prevStatus !== 'done' && currStatus === 'done') {
            const sourceData = wireData[fromPtyId || ''] || '';
            const lastLine = sourceData.trim().split('\n').pop() || 'Task from agent';
            const todoTile = toTile as import('@/types').TodoTile;
            const newItems = [...(todoTile.items ?? []), {
              id: crypto.randomUUID(),
              text: lastLine.slice(0, 200),
              done: false,
              assignedAgent: fromTile.title || fromTile.id,
            }];
            state.updateTile(toTile.id, { items: newItems } as Partial<import('@/types').Tile>);

            state.setWireActive(wire.id, true);
            const taskTimerId = window.setTimeout(() => {
              pendingTimers.current.delete(taskTimerId);
              useCanvasStore.getState().setWireActive(wire.id, false);
            }, 2000);
            pendingTimers.current.add(taskTimerId);
          }
        }

        // ─── Diff feed (agent->diff) ─────────────────────
        if (wire.wireType === 'diff-feed' && isAgentTile(fromTile) && toTile.type === 'diff') {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = fromTile.status;

          if (prevStatus && prevStatus !== 'done' && currStatus === 'done') {
            // Notify that diff should be refreshed
            useToastStore.getState().addToast(
              `Agent completed — diff tile "${toTile.title || toTile.id}" should be refreshed`,
              'info',
            );

            state.setWireActive(wire.id, true);
            const diffTimerId = window.setTimeout(() => {
              pendingTimers.current.delete(diffTimerId);
              useCanvasStore.getState().setWireActive(wire.id, false);
            }, 2000);
            pendingTimers.current.add(diffTimerId);
          }
        }
      }

      // Auto-recovery: if a runner tile fails, dispatch error to connected agent
      for (const tile of tiles) {
        if (tile.type !== 'runner') continue;
        const runner = tile as import('@/types').RunnerTile;
        if (runner.status !== 'fail') continue;
        // Check if there's a wire from this runner to an agent
        const wire = wires.find(w => w.fromTile === runner.id);
        if (!wire) continue;
        const targetTile = tileById.get(wire.toTile);
        if (!targetTile || !isAgentTile(targetTile)) continue;
        const agentPty = targetTile.ptyId;
        if (!agentPty) continue;
        const output = wireData[runner.ptyId || ''] || '';
        if (!output) continue;
        // Only auto-recover once per failure (check if we already sent)
        const recoveryKey = `recovery-${runner.id}-${runner.status}`;
        if (prevWireDataRef.current[recoveryKey]) continue;
        prevWireDataRef.current[recoveryKey] = 'sent';
        const errorLines = output.split('\n').slice(-30).join('\n');
        ptyWrite(agentPty, `Build/test failed. Fix this error:\n${errorLines}`).catch(() => {});
        setTimeout(() => ptyWrite(agentPty, '\r').catch(() => {}), 500);
        state.setWireActive(wire.id, true);
        const rid = window.setTimeout(() => {
          pendingTimers.current.delete(rid);
          useCanvasStore.getState().setWireActive(wire.id, false);
        }, 3000);
        pendingTimers.current.add(rid);
      }

      // Desktop notification when any agent completes
      for (const tileId of Object.keys(nextStatuses)) {
        const prev = prevStatuses[tileId];
        const curr = nextStatuses[tileId];
        if (prev && prev !== 'done' && prev !== 'error' && (curr === 'done' || curr === 'error')) {
          const agentTile = tileById.get(tileId);
          const name = agentTile?.title || agentTile?.type || 'Agent';
          try { sendNotification({ title: 'TerminalX', body: `${name} ${curr === 'done' ? 'completed' : 'failed'}` }); } catch { /* ignore */ }
        }
      }

      prevWireDataRef.current = { ...wireData };
      // prevAgentStatusRef was already committed at top of runEngine
    }

    return () => {
      unsub();
      // scheduled microtask can still fire after unmount — the `scheduled`
      // variable is captured in closure so it won't try to run once this
      // effect's locals are gone, but the reentryGuard ref is still alive.
      // Clearing pending timers is enough; the microtask harmlessly sees
      // a finished state and returns.
      pendingTimers.current.forEach(id => window.clearTimeout(id));
      pendingTimers.current.clear();
    };
  }, []);
}
