import { useEffect, useRef } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useToastStore } from '@/stores/toastStore';
import { ptyWrite } from '@/utils/ipc';
import { sendNotification } from '@tauri-apps/plugin-notification';
import type { Wire, Tile, AgentTile } from '@/types';

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

  useEffect(() => {
    const unsub = useCanvasStore.subscribe((state) => {
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
        if (tile.type === 'agent') {
          nextStatuses[tile.id] = (tile as AgentTile).status;
        }
      }

      for (const wire of wires) {
        const fromTile = tileById.get(wire.fromTile);
        const toTile = tileById.get(wire.toTile);
        if (!fromTile || !toTile) continue;

        // ─── Data flow activation (context-pipe) ─────────
        const fromPtyId = 'ptyId' in fromTile ? (fromTile as { ptyId?: string }).ptyId : undefined;
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
        if (wire.wireType === 'agent-chain' && fromTile.type === 'agent' && toTile.type === 'agent') {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = (fromTile as AgentTile).status;

          // Agent just completed
          if (prevStatus && prevStatus !== 'done' && currStatus === 'done') {
            const toPtyId = (toTile as AgentTile).ptyId;
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
        if (wire.wireType === 'refresh-trigger' && fromTile.type === 'agent') {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = (fromTile as AgentTile).status;

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
        if (wire.wireType === 'context-pipe' && fromTile.type === 'agent') {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = (fromTile as AgentTile).status;

          if (prevStatus && prevStatus !== 'done' && currStatus === 'done') {
            const toPtyId = 'ptyId' in toTile ? (toTile as { ptyId?: string }).ptyId : undefined;
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
        if (wire.wireType === 'task-assign' && fromTile.type === 'agent' && toTile.type === 'todo') {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = (fromTile as AgentTile).status;

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
        if (wire.wireType === 'diff-feed' && fromTile.type === 'agent' && toTile.type === 'diff') {
          const prevStatus = prevStatuses[fromTile.id];
          const currStatus = (fromTile as AgentTile).status;

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
        if (!targetTile || targetTile.type !== 'agent') continue;
        const agentPty = (targetTile as AgentTile).ptyId;
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
      prevAgentStatusRef.current = nextStatuses;
    });

    return () => {
      unsub();
      pendingTimers.current.forEach(id => window.clearTimeout(id));
      pendingTimers.current.clear();
    };
  }, []);
}
