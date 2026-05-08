import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilderKickLifecycle, _resetBuilderKickForTest } from './builder-kick-lifecycle';
import type { LifecycleEvent } from '@/stores/pipelineStore';

function ev(partial: Partial<LifecycleEvent>): LifecycleEvent {
  return {
    runId: 'run-1',
    projectId: 'proj-1',
    worktreePath: '/wt',
    from: 'planning',
    to: 'building',
    trigger: 'planner_done',
    ...partial,
  };
}

describe('builder-kick lifecycle', () => {
  beforeEach(() => {
    _resetBuilderKickForTest();
  });

  it('writes the handoff prompt + carriage return on entry into building', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handler = makeBuilderKickLifecycle({
      resolveBuilderPty: () => 'pty-builder',
      getLatestPlanPath: () => 'docs/superpowers/plans/2026-05-08-feature.md',
      write,
    });
    handler(ev({}));
    // The lifecycle handler is sync; the actual write is fire-and-forget.
    // Drain microtasks + the 300ms paste-settle delay before the CR fires.
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));

    const [pty, body] = write.mock.calls[0];
    expect(pty).toBe('pty-builder');
    expect(body).toContain('docs/superpowers/plans/2026-05-08-feature.md');
    expect(body).toContain('TX_STAGE_DONE');
    expect(write.mock.calls[1]).toEqual(['pty-builder', '\r']);
  });

  it('skips when the run has no plan yet', async () => {
    const write = vi.fn();
    const handler = makeBuilderKickLifecycle({
      resolveBuilderPty: () => 'pty-builder',
      getLatestPlanPath: () => undefined,
      write,
    });
    handler(ev({}));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it('skips when the Builder PTY has not spawned', async () => {
    const write = vi.fn();
    const handler = makeBuilderKickLifecycle({
      resolveBuilderPty: () => undefined,
      getLatestPlanPath: () => 'plan.md',
      write,
    });
    handler(ev({}));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it('skips transitions that are not entries into building', async () => {
    const write = vi.fn();
    const handler = makeBuilderKickLifecycle({
      resolveBuilderPty: () => 'pty-builder',
      getLatestPlanPath: () => 'plan.md',
      write,
    });
    handler(ev({ to: 'reviewing', from: 'building', trigger: 'builder_done' }));
    handler(ev({ to: 'planning', from: 'idle', trigger: 'start' }));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it('dedupes against the same plan path on a re-entry into building', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handler = makeBuilderKickLifecycle({
      resolveBuilderPty: () => 'pty-builder',
      getLatestPlanPath: () => 'plan.md',
      write,
    });
    handler(ev({}));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));

    // Reviewer rejected → loop back to building. Same plan.md still — should NOT re-kick.
    handler(ev({ from: 'reviewing', trigger: 'reviewer_reject' }));
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('re-kicks when the plan path changes (replan path)', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    let plan = 'plan.md';
    const handler = makeBuilderKickLifecycle({
      resolveBuilderPty: () => 'pty-builder',
      getLatestPlanPath: () => plan,
      write,
    });
    handler(ev({}));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));

    plan = 'plan-v2.md';
    handler(ev({ from: 'planning', trigger: 'planner_done' }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(4));

    expect(write.mock.calls[2][1]).toContain('plan-v2.md');
  });

  it('swallows write errors without throwing', async () => {
    const write = vi.fn().mockRejectedValue(new Error('PTY closed'));
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = makeBuilderKickLifecycle({
      resolveBuilderPty: () => 'pty-builder',
      getLatestPlanPath: () => 'plan.md',
      write,
    });
    handler(ev({}));  // sync — must not throw
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    consoleSpy.mockRestore();
  });
});
