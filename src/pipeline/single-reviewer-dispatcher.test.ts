import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleSingleReviewerLifecycle,
  resetSingleReviewerDispatcherForTest,
  startSingleReviewerDispatcher,
  type SingleReviewerDeps,
} from './single-reviewer-dispatcher';
import {
  usePipelineStore,
  setPipelineLifecycleEmitter,
  type LifecycleEvent,
} from '@/stores/pipelineStore';
import type { PipelineRun, RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 'tx.trio',
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
    templateId: 'tx.trio',
    projectId: 'p1',
    worktreePath: '/tmp/wt/r1',
    branch: 'feat/r1',
    baseBranch: 'main',
    state: 'reviewing',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 },
    startedAt: 0,
    escalationLog: [],
    tiles: {},
    fingerprint: FP,
    planLineage: [],
    runMode: 'standard',
    autoApprovePlan: false,
    useDualReviewer: false,
    runRedTeam: false,
    effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3, planReject: 3 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3, planReject: 3 },
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
    runId: 'r1', projectId: 'p1', worktreePath: '/tmp/wt/r1',
    from: 'building', to: 'reviewing', trigger: 'builder_done',
    ...overrides,
  };
}

describe('single-reviewer dispatcher', () => {
  beforeEach(() => {
    resetSingleReviewerDispatcherForTest();
    setPipelineLifecycleEmitter(null);
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('fires reviewer one-shot on building→reviewing transition', () => {
    seedRun(makeRun());
    const fire = vi.fn();
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps);

    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith({ runId: 'r1' });
  });

  it('skips when useDualReviewer=true (dual dispatcher owns it)', () => {
    seedRun(makeRun({ useDualReviewer: true }));
    const fire = vi.fn();
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps);

    expect(fire).not.toHaveBeenCalled();
  });

  it('does not re-fire on duplicate same-round transitions', () => {
    seedRun(makeRun());
    const fire = vi.fn();
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps);
    handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps);

    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('re-fires on a new round (reviewerReject counter bumped)', () => {
    seedRun(makeRun({ retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 } }));
    const fire = vi.fn();
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps);
    expect(fire).toHaveBeenCalledTimes(1);

    // Reviewer rejects → counter bumps → run re-enters reviewing on next builder_done.
    seedRun(makeRun({ retryCounters: { reviewerReject: 1, ciFail: 0, planReject: 1 } }));
    handleSingleReviewerLifecycle(ev({ from: 'building', to: 'reviewing' }), deps);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('ignores transitions that do not enter reviewing', () => {
    seedRun(makeRun({ state: 'building' }));
    const fire = vi.fn();
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(
      ev({ from: 'awaiting_plan_approval', to: 'building', trigger: 'approve_plan' }),
      deps,
    );
    handleSingleReviewerLifecycle(
      ev({ from: 'reviewing', to: 'awaiting_merge_approval', trigger: 'reviewer_done' }),
      deps,
    );

    expect(fire).not.toHaveBeenCalled();
  });

  it('prunes bookkeeping on terminal-state transition', () => {
    seedRun(makeRun());
    const fire = vi.fn();
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps);
    expect(fire).toHaveBeenCalledTimes(1);

    handleSingleReviewerLifecycle(ev({ from: 'reviewing', to: 'failed' }), deps);

    // Re-entry on a fresh round-0 should re-fire (proves bookkeeping was pruned).
    handleSingleReviewerLifecycle(ev({ from: 'building', to: 'reviewing' }), deps);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('isolates bookkeeping between runs', () => {
    seedRun(makeRun({ id: 'r1' }));
    seedRun(makeRun({ id: 'r2' }));
    const fire = vi.fn();
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(ev({ runId: 'r1' }), deps);
    handleSingleReviewerLifecycle(ev({ runId: 'r2' }), deps);

    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('survives a throwing dependency (logs, does not propagate)', () => {
    seedRun(makeRun());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fire = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    expect(() =>
      handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps),
    ).not.toThrow();
    expect(fire).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives a rejected promise from runOneShotReviewer', async () => {
    seedRun(makeRun());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fire = vi.fn().mockRejectedValueOnce(new Error('async-boom'));
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('startSingleReviewerDispatcher returns an unsubscribe fn', () => {
    seedRun(makeRun());
    const fire = vi.fn();
    const unsubscribe = startSingleReviewerDispatcher({ runOneShotReviewer: fire });
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    // After unsubscribe, dispatching shouldn't reach our handler (no throw).
    usePipelineStore.getState().dispatch('r1', { type: 'heartbeat' });
  });

  it('skips when run is missing from store', () => {
    // No seed.
    const fire = vi.fn();
    const deps: SingleReviewerDeps = { runOneShotReviewer: fire };

    handleSingleReviewerLifecycle(ev({ to: 'reviewing' }), deps);

    expect(fire).not.toHaveBeenCalled();
  });
});
