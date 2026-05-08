import { describe, it, expect, vi } from 'vitest';
import { makePlannerRerunLifecycle } from './planner-rerun-lifecycle';
import type { LifecycleEvent } from '@/stores/pipelineStore';

function ev(partial: Partial<LifecycleEvent>): LifecycleEvent {
  return {
    runId: 'run-1',
    projectId: 'proj-1',
    worktreePath: '/wt',
    from: 'awaiting_plan_approval',
    to: 'planning',
    trigger: 'reject_plan',
    ...partial,
  };
}

describe('planner-rerun lifecycle', () => {
  it('writes the rejection feedback + carriage return on awaiting_plan_approval → planning', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handler = makePlannerRerunLifecycle({
      resolvePlannerPty: () => 'pty-planner',
      getLatestRejectionFeedback: () => 'Scope too broad — focus on auth only.',
      write,
    });
    handler(ev({}));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));

    const [pty, body] = write.mock.calls[0];
    expect(pty).toBe('pty-planner');
    expect(body).toContain('previous plan was rejected');
    expect(body).toContain('Scope too broad — focus on auth only.');
    expect(body).toContain('revised plan');
    expect(write.mock.calls[1]).toEqual(['pty-planner', '\r']);
  });

  it('skips transitions that are not awaiting_plan_approval → planning', async () => {
    const write = vi.fn();
    const handler = makePlannerRerunLifecycle({
      resolvePlannerPty: () => 'pty-planner',
      getLatestRejectionFeedback: () => 'feedback',
      write,
    });
    // initial start: idle → planning (no rerun kick — this is the first plan)
    handler(ev({ from: 'idle', trigger: 'start' }));
    // unrelated: planning → awaiting_plan_approval
    handler(ev({ from: 'planning', to: 'awaiting_plan_approval', trigger: 'planner_done' }));
    // unrelated: building → reviewing
    handler(ev({ from: 'building', to: 'reviewing', trigger: 'builder_done' }));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it('skips when there is no rejection feedback (defensive)', async () => {
    const write = vi.fn();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = makePlannerRerunLifecycle({
      resolvePlannerPty: () => 'pty-planner',
      getLatestRejectionFeedback: () => undefined,
      write,
    });
    handler(ev({}));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('no rejection feedback'),
    );
    consoleSpy.mockRestore();
  });

  it('skips when the Planner PTY is not resolvable', async () => {
    const write = vi.fn();
    const handler = makePlannerRerunLifecycle({
      resolvePlannerPty: () => undefined,
      getLatestRejectionFeedback: () => 'feedback',
      write,
    });
    handler(ev({}));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it('skips when agents are disconnected (run restored after reload)', async () => {
    const write = vi.fn();
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = makePlannerRerunLifecycle({
      resolvePlannerPty: () => 'pty-planner',
      getLatestRejectionFeedback: () => 'feedback',
      isAgentsDisconnected: () => true,
      write,
    });
    handler(ev({}));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('agents disconnected'),
    );
    consoleSpy.mockRestore();
  });

  it('swallows write errors without throwing', async () => {
    const write = vi.fn().mockRejectedValue(new Error('PTY closed'));
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = makePlannerRerunLifecycle({
      resolvePlannerPty: () => 'pty-planner',
      getLatestRejectionFeedback: () => 'feedback',
      write,
    });
    handler(ev({})); // sync — must not throw
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    consoleSpy.mockRestore();
  });
});
