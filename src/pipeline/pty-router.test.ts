import { describe, it, expect, vi } from 'vitest';
import { startPipelinePtyRouter } from './pty-router';
import type { Tile, AgentTile } from '@/types';

function agent(id: string, ptyId: string | undefined, runId?: string, role?: 'planner' | 'builder' | 'reviewer'): AgentTile {
  return {
    id,
    type: 'agent',
    x: 0, y: 0, w: 100, h: 100,
    agent: 'claude', model: 'opus-4-7', effort: 'high', mode: '',
    version: '', cwd: '', branch: '', status: 'idle', elapsed: 0,
    ptyId,
    pipelineRunId: runId,
    pipelineRole: role,
  };
}

describe('startPipelinePtyRouter', () => {
  it('routes chunks for tagged tiles to ingest with the correct run + role', async () => {
    const tiles = { p1: [agent('t1', 'pty-A', 'run-1', 'planner')] };
    const ingest = vi.fn();
    let listener: ((evt: { id: string; data: string }) => void) | null = null;
    const listen = vi.fn().mockImplementation((cb) => {
      listener = cb;
      return Promise.resolve(() => { /* unlisten */ });
    });
    const subscribeTiles = vi.fn().mockImplementation(() => () => {});

    const stop = startPipelinePtyRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listen: listen as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribeTiles: subscribeTiles as any,
      ingest,
    });
    // The router's getState() reads the real canvas store. Inject the
    // initial tile snapshot via the subscribeTiles callback.
    subscribeTiles.mock.calls[0][0](tiles);

    // Wait for listen() to resolve.
    await Promise.resolve();
    expect(listener).toBeTypeOf('function');

    listener!({ id: 'pty-A', data: 'hello\n' });
    expect(ingest).toHaveBeenCalledWith({ runId: 'run-1', role: 'planner', chunk: 'hello\n' });

    stop();
  });

  it('drops chunks for unmapped pty ids', async () => {
    const ingest = vi.fn();
    let listener: ((evt: { id: string; data: string }) => void) | null = null;
    const listen = vi.fn().mockImplementation((cb) => {
      listener = cb;
      return Promise.resolve(() => {});
    });
    const subscribeTiles = vi.fn().mockImplementation(() => () => {});

    const stop = startPipelinePtyRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listen: listen as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribeTiles: subscribeTiles as any,
      ingest,
    });
    subscribeTiles.mock.calls[0][0]({ p1: [agent('t1', 'pty-A', 'run-1', 'planner')] });
    await Promise.resolve();

    listener!({ id: 'pty-UNTAGGED', data: 'noise' });
    expect(ingest).not.toHaveBeenCalled();

    stop();
  });

  it('skips tiles without pipelineRunId / pipelineRole / ptyId', async () => {
    const ingest = vi.fn();
    let listener: ((evt: { id: string; data: string }) => void) | null = null;
    const listen = vi.fn().mockImplementation((cb) => {
      listener = cb;
      return Promise.resolve(() => {});
    });
    const subscribeTiles = vi.fn().mockImplementation(() => () => {});

    const tiles: Record<string, Tile[]> = {
      p1: [
        agent('t1', 'pty-A'),                                  // no run
        agent('t2', undefined, 'run-1', 'builder'),            // no pty
        agent('t3', 'pty-C', 'run-1'),                         // no role
        agent('t4', 'pty-D', 'run-2', 'reviewer'),             // valid
      ],
    };
    const stop = startPipelinePtyRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listen: listen as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribeTiles: subscribeTiles as any,
      ingest,
    });
    subscribeTiles.mock.calls[0][0](tiles);
    await Promise.resolve();

    listener!({ id: 'pty-A', data: 'x' });
    listener!({ id: 'pty-C', data: 'x' });
    listener!({ id: 'pty-D', data: 'x' });

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith({ runId: 'run-2', role: 'reviewer', chunk: 'x' });

    stop();
  });

  it('refreshes the route map when the canvas tile list changes', async () => {
    const ingest = vi.fn();
    let listener: ((evt: { id: string; data: string }) => void) | null = null;
    const listen = vi.fn().mockImplementation((cb) => {
      listener = cb;
      return Promise.resolve(() => {});
    });
    let subCb: ((tiles: Record<string, Tile[]>) => void) | null = null;
    const subscribeTiles = vi.fn().mockImplementation((cb) => {
      subCb = cb;
      return () => {};
    });

    const stop = startPipelinePtyRouter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listen: listen as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribeTiles: subscribeTiles as any,
      ingest,
    });
    subCb!({ p1: [agent('t1', 'pty-A', 'run-1', 'planner')] });
    await Promise.resolve();

    listener!({ id: 'pty-A', data: 'first' });
    expect(ingest).toHaveBeenLastCalledWith({ runId: 'run-1', role: 'planner', chunk: 'first' });

    // Builder spawns later (its ptyId arrives via canvasStore update).
    subCb!({ p1: [
      agent('t1', 'pty-A', 'run-1', 'planner'),
      agent('t2', 'pty-B', 'run-1', 'builder'),
    ]});

    listener!({ id: 'pty-B', data: 'second' });
    expect(ingest).toHaveBeenLastCalledWith({ runId: 'run-1', role: 'builder', chunk: 'second' });

    stop();
  });
});
