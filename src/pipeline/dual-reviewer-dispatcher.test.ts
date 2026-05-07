import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleDualReviewerLifecycle,
  resetDualReviewerDispatcherForTest,
  startDualReviewerDispatcher,
  TIEBREAKER_PROVIDER,
  type DualReviewerDeps,
} from './dual-reviewer-dispatcher';
import {
  usePipelineStore,
  setPipelineLifecycleEmitter,
  type LifecycleEvent,
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
    state: 'awaiting_dual_reviewer',
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
  // Inject the run into the live store so the dispatcher can read it.
  usePipelineStore.setState((s) => ({
    ...s,
    runs: { ...s.runs, [run.id]: run },
  }));
}

function ev(overrides: Partial<LifecycleEvent>): LifecycleEvent {
  return {
    runId: 'r1', projectId: 'p1', worktreePath: '/tmp/wt/r1',
    from: 'building', to: 'awaiting_dual_reviewer', trigger: 'builder_done',
    ...overrides,
  };
}

describe('dual-reviewer dispatcher (Phase 3c.4)', () => {
  beforeEach(() => {
    resetDualReviewerDispatcherForTest();
    setPipelineLifecycleEmitter(null);
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('fires both reviewers on awaiting_dual_reviewer entry', () => {
    seedRun(makeRun());
    const fire = vi.fn();
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    handleDualReviewerLifecycle(ev({ to: 'awaiting_dual_reviewer' }), deps);

    expect(fire).toHaveBeenCalledTimes(2);
    expect(fire).toHaveBeenCalledWith({ runId: 'r1', role: 'reviewer', provider: 'opus' });
    expect(fire).toHaveBeenCalledWith({ runId: 'r1', role: 'reviewer-codex', provider: 'codex' });
  });

  it('fires gemini tiebreaker on awaiting_tiebreaker entry', () => {
    seedRun(makeRun({ state: 'awaiting_tiebreaker' }));
    const fire = vi.fn();
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    handleDualReviewerLifecycle(
      ev({ from: 'awaiting_dual_reviewer', to: 'awaiting_tiebreaker', trigger: 'reviewer_done' }),
      deps,
    );

    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith({ runId: 'r1', role: 'reviewer', provider: TIEBREAKER_PROVIDER });
  });

  it('does not re-fire on duplicate same-round transitions', () => {
    seedRun(makeRun());
    const fire = vi.fn();
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    handleDualReviewerLifecycle(ev({ to: 'awaiting_dual_reviewer' }), deps);
    handleDualReviewerLifecycle(ev({ to: 'awaiting_dual_reviewer' }), deps);

    expect(fire).toHaveBeenCalledTimes(2); // 2 from the first event, 0 from the second
  });

  it('re-fires on a new round (counter changed → new dual gate)', () => {
    seedRun(makeRun({ retryCounters: { reviewerReject: 0, ciFail: 0 } }));
    const fire = vi.fn();
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    handleDualReviewerLifecycle(ev({ to: 'awaiting_dual_reviewer' }), deps);
    expect(fire).toHaveBeenCalledTimes(2);

    // Round increments after a both-reject + retry.
    seedRun(makeRun({ retryCounters: { reviewerReject: 1, ciFail: 0 } }));
    handleDualReviewerLifecycle(ev({ from: 'building', to: 'awaiting_dual_reviewer' }), deps);
    expect(fire).toHaveBeenCalledTimes(4);
  });

  it('does not re-fire tiebreaker on duplicate same-round transitions', () => {
    seedRun(makeRun({ state: 'awaiting_tiebreaker' }));
    const fire = vi.fn();
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    handleDualReviewerLifecycle(
      ev({ from: 'awaiting_dual_reviewer', to: 'awaiting_tiebreaker' }),
      deps,
    );
    handleDualReviewerLifecycle(
      ev({ from: 'awaiting_dual_reviewer', to: 'awaiting_tiebreaker' }),
      deps,
    );

    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated transitions', () => {
    seedRun(makeRun({ state: 'building' }));
    const fire = vi.fn();
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    handleDualReviewerLifecycle(
      ev({ from: 'awaiting_plan_approval', to: 'building', trigger: 'approve_plan' }),
      deps,
    );
    handleDualReviewerLifecycle(
      ev({ from: 'building', to: 'reviewing', trigger: 'builder_done' }),
      deps,
    );
    handleDualReviewerLifecycle(
      ev({ from: 'reviewing', to: 'awaiting_merge_approval', trigger: 'reviewer_done' }),
      deps,
    );

    expect(fire).not.toHaveBeenCalled();
  });

  it('isolates bookkeeping between runs', () => {
    seedRun(makeRun({ id: 'r1' }));
    seedRun(makeRun({ id: 'r2' }));
    const fire = vi.fn();
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    handleDualReviewerLifecycle(ev({ runId: 'r1' }), deps);
    handleDualReviewerLifecycle(ev({ runId: 'r2' }), deps);

    expect(fire).toHaveBeenCalledTimes(4);
  });

  it('survives a throwing dependency (logs, does not propagate)', () => {
    seedRun(makeRun());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fire = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    expect(() =>
      handleDualReviewerLifecycle(ev({ to: 'awaiting_dual_reviewer' }), deps),
    ).not.toThrow();
    expect(fire).toHaveBeenCalledTimes(2); // both attempts fired despite first throw
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives a rejected promise from runOneShotReviewer', async () => {
    seedRun(makeRun());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fire = vi.fn().mockResolvedValue(undefined).mockRejectedValueOnce(new Error('async-boom'));
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    handleDualReviewerLifecycle(ev({ to: 'awaiting_dual_reviewer' }), deps);
    // Allow the rejection microtask to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('Audit fix: prunes bookkeeping on terminal-state transition', () => {
    seedRun(makeRun());
    const fire = vi.fn();
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };

    // Round 1: dual-reviewer fires, bookkeeping records dualFired=true.
    handleDualReviewerLifecycle(ev({ to: 'awaiting_dual_reviewer' }), deps);
    expect(fire).toHaveBeenCalledTimes(2);

    // Run reaches terminal state — bookkeeping should be pruned.
    handleDualReviewerLifecycle(ev({ from: 'awaiting_dual_reviewer', to: 'failed' }), deps);

    // Re-entry on a fresh round-0 should re-fire (proves the entry was pruned;
    // otherwise dualFired would still be true at reject=0 and the guard
    // `entry.dualFired && entry.dualLastReject === reject` would silently skip).
    handleDualReviewerLifecycle(ev({ from: 'building', to: 'awaiting_dual_reviewer' }), deps);
    expect(fire).toHaveBeenCalledTimes(4);
  });

  it('startDualReviewerDispatcher returns an unsubscribe fn', () => {
    seedRun(makeRun());
    const fire = vi.fn();
    const unsubscribe = startDualReviewerDispatcher({ runOneShotReviewer: fire });
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    // After unsubscribe, dispatching shouldn't reach our handler.
    usePipelineStore.getState().dispatch('r1', { type: 'heartbeat' });
    // (No assertion on `fire`: heartbeat doesn't transition state, so the
    // dispatcher would skip anyway. The point is `unsubscribe()` doesn't throw.)
  });
});
