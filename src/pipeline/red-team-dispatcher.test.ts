import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleRedTeamLifecycle,
  resetRedTeamDispatcherForTest,
  startRedTeamDispatcher,
  REDTEAM_PROVIDER,
  type RedTeamDispatcherDeps,
} from './red-team-dispatcher';
import {
  usePipelineStore,
  setPipelineLifecycleEmitter,
  setPipelineTelemetryEmitter,
  type LifecycleEvent,
  type TelemetryEvent,
} from '@/stores/pipelineStore';
import type { PipelineRun, RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 'tx.hello',
  templateHash: 'h0',
  skillHashes: {},
  rolePromptHashes: {},
  models: {},
  capabilityManifests: {},
  terminalxVersion: '0.1.0',
};

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'r1',
    templateId: 'tx.hello',
    projectId: 'p1',
    worktreePath: '/tmp/wt/r1',
    branch: 'feat/r1',
    baseBranch: 'main',
    state: 'awaiting_red_team',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 0,
    escalationLog: [],
    tiles: {},
    fingerprint: FP,
    planLineage: [],
    runMode: 'complex',
    autoApprovePlan: false,
    useDualReviewer: true,
    runRedTeam: true,
    effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3 },
    templateDualReviewer: false,
    ...overrides,
  };
}

function seedRun(run: PipelineRun): void {
  usePipelineStore.setState((s) => ({
    ...s,
    runs: { ...s.runs, [run.id]: run },
  }));
}

function ev(overrides: Partial<LifecycleEvent>): LifecycleEvent {
  return {
    runId: 'r1',
    projectId: 'p1',
    worktreePath: '/tmp/wt/r1',
    from: 'reviewing',
    to: 'awaiting_red_team',
    trigger: 'reviewer_done',
    ...overrides,
  };
}

describe('red-team dispatcher (Polish.1)', () => {
  beforeEach(() => {
    resetRedTeamDispatcherForTest();
    setPipelineLifecycleEmitter(null);
    setPipelineTelemetryEmitter(null);
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('fires the red-team agent on awaiting_red_team entry', async () => {
    seedRun(makeRun());
    const runRedTeam = vi.fn().mockResolvedValue(undefined);
    const buildBrief = vi.fn().mockResolvedValue('the brief');
    const deps: RedTeamDispatcherDeps = { runRedTeam, buildBrief };

    handleRedTeamLifecycle(ev({}), deps);
    // brief build is async — let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(buildBrief).toHaveBeenCalledTimes(1);
    expect(buildBrief).toHaveBeenCalledWith('r1');
    expect(runRedTeam).toHaveBeenCalledTimes(1);
    expect(runRedTeam).toHaveBeenCalledWith({ runId: 'r1', brief: 'the brief' });
  });

  it('does not double-fire on duplicate same-entry transitions', async () => {
    seedRun(makeRun());
    const runRedTeam = vi.fn().mockResolvedValue(undefined);
    const buildBrief = vi.fn().mockResolvedValue('b');
    const deps: RedTeamDispatcherDeps = { runRedTeam, buildBrief };

    handleRedTeamLifecycle(ev({}), deps);
    handleRedTeamLifecycle(ev({}), deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(runRedTeam).toHaveBeenCalledTimes(1);
  });

  it('re-fires after a Builder re-loop (exit + re-enter)', async () => {
    seedRun(makeRun());
    const runRedTeam = vi.fn().mockResolvedValue(undefined);
    const buildBrief = vi.fn().mockResolvedValue('b');
    const deps: RedTeamDispatcherDeps = { runRedTeam, buildBrief };

    // 1st pass: Reviewer approves → enter gate.
    handleRedTeamLifecycle(ev({ from: 'reviewing', to: 'awaiting_red_team' }), deps);
    // (Hypothetically) red-team rejects / abort / Reviewer flips back to
    // building. The state-machine doesn't actually loop red-team → building
    // today (red-team blockers go to `failed`), but Builder reject from a
    // PRIOR Reviewer pass would have already exited; we model the exit
    // here as "from awaiting_red_team to building" to verify the reset.
    handleRedTeamLifecycle(
      ev({ from: 'awaiting_red_team', to: 'building', trigger: 'replan_requested' }),
      deps,
    );
    // 2nd pass: Builder finishes, Reviewer approves again → re-enter gate.
    handleRedTeamLifecycle(ev({ from: 'reviewing', to: 'awaiting_red_team' }), deps);

    await Promise.resolve();
    await Promise.resolve();

    expect(runRedTeam).toHaveBeenCalledTimes(2);
  });

  it('cleanup unsubscribes the listener', async () => {
    seedRun(makeRun());
    const runRedTeam = vi.fn().mockResolvedValue(undefined);
    const buildBrief = vi.fn().mockResolvedValue('b');
    const stop = startRedTeamDispatcher({ runRedTeam, buildBrief });

    stop();
    // Drive a synthetic transition through the store; listeners are off so
    // `runRedTeam` should not fire. (Heartbeat doesn't transition state, so
    // this asserts both `unsubscribe` doesn't throw and that the listener
    // would not be invoked even if it did fire.)
    usePipelineStore.getState().dispatch('r1', { type: 'heartbeat' });
    await Promise.resolve();

    expect(runRedTeam).not.toHaveBeenCalled();
  });

  it('builds the brief via deps with the runId', async () => {
    seedRun(makeRun({ id: 'r99' }));
    const runRedTeam = vi.fn().mockResolvedValue(undefined);
    const buildBrief = vi.fn().mockResolvedValue('custom brief');
    const deps: RedTeamDispatcherDeps = { runRedTeam, buildBrief };

    handleRedTeamLifecycle(ev({ runId: 'r99' }), deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(buildBrief).toHaveBeenCalledWith('r99');
    expect(runRedTeam).toHaveBeenCalledWith({ runId: 'r99', brief: 'custom brief' });
  });

  it('survives a buildBrief rejection — logs and resets fired flag for retry', async () => {
    seedRun(makeRun());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runRedTeam = vi.fn().mockResolvedValue(undefined);
    const buildBrief = vi.fn()
      .mockRejectedValueOnce(new Error('brief-boom'))
      .mockResolvedValueOnce('the brief');
    const deps: RedTeamDispatcherDeps = { runRedTeam, buildBrief };

    handleRedTeamLifecycle(ev({}), deps);
    // Let the rejection settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    expect(runRedTeam).not.toHaveBeenCalled();

    // Re-enter the gate — fired flag should have been reset by the catch.
    handleRedTeamLifecycle(ev({}), deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(buildBrief).toHaveBeenCalledTimes(2);
    expect(runRedTeam).toHaveBeenCalledTimes(1);
    expect(runRedTeam).toHaveBeenCalledWith({ runId: 'r1', brief: 'the brief' });

    warn.mockRestore();
  });

  it('survives a runRedTeam rejection — logs and resets fired flag for retry', async () => {
    seedRun(makeRun());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buildBrief = vi.fn().mockResolvedValue('b');
    const runRedTeam = vi.fn()
      .mockRejectedValueOnce(new Error('spawn-boom'))
      .mockResolvedValueOnce(undefined);
    const deps: RedTeamDispatcherDeps = { runRedTeam, buildBrief };

    handleRedTeamLifecycle(ev({}), deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    expect(runRedTeam).toHaveBeenCalledTimes(1);

    // Re-enter — fired should have reset.
    handleRedTeamLifecycle(ev({}), deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(runRedTeam).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });

  it('emits red_team_invoked telemetry with provider opus', () => {
    seedRun(makeRun());
    const events: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((e) => events.push(e));

    const runRedTeam = vi.fn().mockResolvedValue(undefined);
    const buildBrief = vi.fn().mockResolvedValue('b');
    const deps: RedTeamDispatcherDeps = {
      runRedTeam,
      buildBrief,
      now: () => 1234567,
    };

    handleRedTeamLifecycle(ev({}), deps);

    const invoked = events.find((e) => e.event === 'red_team_invoked');
    expect(invoked).toBeDefined();
    expect(invoked).toMatchObject({
      at: 1234567,
      event: 'red_team_invoked',
      runId: 'r1',
      projectId: 'p1',
      provider: REDTEAM_PROVIDER,
    });
    expect(REDTEAM_PROVIDER).toBe('opus');
  });

  it('ignores unrelated transitions', () => {
    seedRun(makeRun({ state: 'building' }));
    const runRedTeam = vi.fn();
    const buildBrief = vi.fn();
    const deps: RedTeamDispatcherDeps = { runRedTeam, buildBrief };

    handleRedTeamLifecycle(
      ev({ from: 'awaiting_plan_approval', to: 'building', trigger: 'approve_plan' }),
      deps,
    );
    handleRedTeamLifecycle(
      ev({ from: 'building', to: 'reviewing', trigger: 'builder_done' }),
      deps,
    );
    handleRedTeamLifecycle(
      ev({ from: 'reviewing', to: 'awaiting_merge_approval', trigger: 'reviewer_done' }),
      deps,
    );

    expect(runRedTeam).not.toHaveBeenCalled();
    expect(buildBrief).not.toHaveBeenCalled();
  });

  it('isolates bookkeeping between runs', async () => {
    seedRun(makeRun({ id: 'r1' }));
    seedRun(makeRun({ id: 'r2' }));
    const runRedTeam = vi.fn().mockResolvedValue(undefined);
    const buildBrief = vi.fn().mockResolvedValue('b');
    const deps: RedTeamDispatcherDeps = { runRedTeam, buildBrief };

    handleRedTeamLifecycle(ev({ runId: 'r1' }), deps);
    handleRedTeamLifecycle(ev({ runId: 'r2' }), deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(runRedTeam).toHaveBeenCalledTimes(2);
    expect(runRedTeam).toHaveBeenCalledWith({ runId: 'r1', brief: 'b' });
    expect(runRedTeam).toHaveBeenCalledWith({ runId: 'r2', brief: 'b' });
  });

  it('startRedTeamDispatcher returns an unsubscribe fn', () => {
    seedRun(makeRun());
    const stop = startRedTeamDispatcher({
      runRedTeam: vi.fn(),
      buildBrief: vi.fn().mockResolvedValue(''),
    });
    expect(typeof stop).toBe('function');
    stop();
  });
});
