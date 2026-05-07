import { describe, it, expect } from 'vitest';
import { reducer, initialRunState, type PipelineEvent } from './state-machine';
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
    state: 'idle',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 0,
    escalationLog: [],
    tiles: {},
    fingerprint: FP,
    planLineage: [],
    runMode: 'standard',
    autoApprovePlan: false,
    useDualReviewer: false,
    runRedTeam: false,
    effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3 },
    templateDualReviewer: false,
    ...overrides,
  };
}

describe('pipeline state machine', () => {
  it('idle + start → planning', () => {
    const run = makeRun();
    const ev: PipelineEvent = { type: 'start' };
    expect(reducer(run, ev).state).toBe('planning');
  });

  it('planning + planner_done → awaiting_plan_approval', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-v1',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('awaiting_plan_approval');
    expect(next.artifacts.plan).toBeDefined();
  });

  it('awaiting_plan_approval + approve_plan → building', () => {
    const run = makeRun({ state: 'awaiting_plan_approval' });
    const ev: PipelineEvent = { type: 'approve_plan' };
    expect(reducer(run, ev).state).toBe('building');
  });

  it('building + builder_done → reviewing', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'builder_done',
      build: {
        stage: 'builder', branch: 'feat/r1', headSha: 'a', round: 1,
        commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('reviewing');
    expect(next.artifacts.builds.length).toBe(1);
  });

  it('reviewing + reviewer approve → awaiting_merge_approval', () => {
    const run = makeRun({ state: 'reviewing' });
    const ev: PipelineEvent = {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'approve',
        round: 1, comments: [], summary: 'lgtm',
        confidence: 'verified',
      },
    };
    expect(reducer(run, ev).state).toBe('awaiting_merge_approval');
  });

  it('reviewing + reviewer reject within budget → building', () => {
    const run = makeRun({ state: 'reviewing' });
    const ev: PipelineEvent = {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
        round: 1, comments: [], summary: 'no',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('building');
    expect(next.retryCounters.reviewerReject).toBe(1);
  });

  it('reviewing + reviewer reject exceeds budget → escalated', () => {
    const run = makeRun({
      state: 'reviewing',
      retryCounters: { reviewerReject: 3, ciFail: 0 },
    });
    const ev: PipelineEvent = {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
        round: 4, comments: [], summary: 'still no',
        confidence: 'verified',
      },
    };
    expect(reducer(run, ev).state).toBe('escalated');
  });

  it('any state + abort → failed', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = { type: 'abort', reason: 'user' };
    const next = reducer(run, ev);
    expect(next.state).toBe('failed');
    expect(next.failureReason).toBe('user');
  });

  it('any active state + ci_fail within budget → building', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'ci_fail',
      result: { sha: 'a', status: 'fail', step: 'test', command: 'npm test', durationMs: 1, failures: [] },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('building');
    expect(next.retryCounters.ciFail).toBe(1);
  });

  it('any active state + ci_fail exceeds budget → escalated', () => {
    const run = makeRun({
      state: 'building',
      retryCounters: { reviewerReject: 0, ciFail: 3 },
    });
    const ev: PipelineEvent = {
      type: 'ci_fail',
      result: { sha: 'a', status: 'fail', step: 'test', command: 'npm test', durationMs: 1, failures: [] },
    };
    expect(reducer(run, ev).state).toBe('escalated');
  });

  it('any non-terminal state + question_raised → awaiting_clarification (captures priorActiveState)', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'question_raised',
      question: { stage: 'builder', question: 'q?', context: 'c', blocking: true },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('awaiting_clarification');
    expect(next.artifacts.questions.length).toBe(1);
    expect(next.priorActiveState).toBe('building');
  });

  it('awaiting_clarification + clarification_received → resumes priorActiveState (and clears it)', () => {
    const run = makeRun({ state: 'awaiting_clarification', priorActiveState: 'building' });
    const ev: PipelineEvent = { type: 'clarification_received', answer: 'pick option A' };
    const next = reducer(run, ev);
    expect(next.state).toBe('building');
    expect(next.priorActiveState).toBeUndefined();
  });

  it('clarification_received with missing priorActiveState → failed (defensive)', () => {
    const run = makeRun({ state: 'awaiting_clarification' });
    const ev: PipelineEvent = { type: 'clarification_received' };
    const next = reducer(run, ev);
    expect(next.state).toBe('failed');
    expect(next.failureReason).toBe('clarification_received without prior active state');
    expect(next.priorActiveState).toBeUndefined();
  });

  it('awaiting_merge_approval + approve_merge → merging', () => {
    const run = makeRun({ state: 'awaiting_merge_approval' });
    const ev: PipelineEvent = { type: 'approve_merge' };
    expect(reducer(run, ev).state).toBe('merging');
  });

  it('merging + merge_done → done', () => {
    const run = makeRun({ state: 'merging' });
    const ev: PipelineEvent = { type: 'merge_done' };
    const next = reducer(run, ev);
    expect(next.state).toBe('done');
    expect(next.endedAt).toBeGreaterThan(0);
  });

  it('terminal states are sticky (done + start = done)', () => {
    const run = makeRun({ state: 'done' });
    const ev: PipelineEvent = { type: 'start' };
    expect(reducer(run, ev).state).toBe('done');
  });

  it('initialRunState produces a valid idle run', () => {
    const run = initialRunState({
      runId: 'r1',
      templateId: 'tx.hello',
      projectId: 'p1',
      worktreePath: '/tmp/wt/r1',
      branch: 'feat/r1',
      fingerprint: FP,
    });
    expect(run.state).toBe('idle');
    expect(run.artifacts.builds).toEqual([]);
    expect(run.retryCounters).toEqual({ reviewerReject: 0, ciFail: 0 });
  });

  it('planner_failed → failed with planner_refused class', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = { type: 'planner_failed', reason: 'cannot resolve plan' };
    const next = reducer(run, ev);
    expect(next.state).toBe('failed');
    expect(next.failureClass).toBe('planner_refused');
    expect(next.failureReason).toBe('cannot resolve plan');
    expect(next.endedAt).toBeGreaterThan(0);
  });

  it('ci_pass appends to ciResults without changing state', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'ci_pass',
      result: { sha: 'a', status: 'pass', step: 'all', command: 'npm test', durationMs: 1, failures: [] },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('building');
    expect(next.artifacts.ciResults.length).toBe(1);
  });

  it('awaiting_merge_approval + reject_merge → failed', () => {
    const run = makeRun({ state: 'awaiting_merge_approval' });
    const ev: PipelineEvent = { type: 'reject_merge' };
    const next = reducer(run, ev);
    expect(next.state).toBe('failed');
    expect(next.failureReason).toBe('merge_rejected');
    expect(next.endedAt).toBeGreaterThan(0);
  });

  it('merging + merge_failed → failed', () => {
    const run = makeRun({ state: 'merging' });
    const ev: PipelineEvent = { type: 'merge_failed', reason: 'gh push rejected' };
    const next = reducer(run, ev);
    expect(next.state).toBe('failed');
    expect(next.failureReason).toBe('gh push rejected');
    expect(next.endedAt).toBeGreaterThan(0);
  });

  it('abort is a no-op when already in a terminal state (idempotent)', () => {
    const run = makeRun({ state: 'failed', failureReason: 'first abort', endedAt: 100 });
    const ev: PipelineEvent = { type: 'abort', reason: 'second abort' };
    const next = reducer(run, ev);
    expect(next).toBe(run);
  });

  it('non-terminal transition does not set endedAt', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'builder_done',
      build: {
        stage: 'builder', branch: 'feat/r1', headSha: 'a', round: 1,
        commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('reviewing');
    expect(next.endedAt).toBeUndefined();
  });

  it('reviewer reject exceeds budget sets retryCounter to 4', () => {
    const run = makeRun({
      state: 'reviewing',
      retryCounters: { reviewerReject: 3, ciFail: 0 },
    });
    const ev: PipelineEvent = {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
        round: 4, comments: [], summary: 'no',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.retryCounters.reviewerReject).toBe(4);
  });

  // ─── planLineage + replan_requested ──────────────────────────────────────

  it('initialRunState: planLineage starts empty', () => {
    const run = initialRunState({
      runId: 'r-lin', templateId: 'tx.hello', projectId: 'p1',
      worktreePath: '/tmp/wt/r-lin', branch: 'feat/r-lin', fingerprint: FP,
    });
    expect(run.planLineage).toEqual([]);
  });

  it('planner_done appends plan.planCommitSha to planLineage', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'abc123',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.planLineage).toEqual(['abc123']);
  });

  it('replan_requested: escalated → planning + appends EscalationEntry(decision=replan)', () => {
    const run = makeRun({
      state: 'escalated',
      failureClass: 'reviewer_irreconcilable',
      endedAt: 12345,
    });
    const ev: PipelineEvent = { type: 'replan_requested', reason: 'human override after review deadlock' };
    const next = reducer(run, ev);
    expect(next.state).toBe('planning');
    // endedAt must clear so the run is "live" again under isTerminalState/etc.
    expect(next.endedAt).toBeUndefined();
    expect(next.escalationLog).toHaveLength(1);
    expect(next.escalationLog[0].decision).toBe('replan');
    expect(next.escalationLog[0].reason).toBe('human override after review deadlock');
  });

  it('replan_requested from non-escalated states is a no-op', () => {
    for (const state of ['building', 'reviewing', 'done', 'failed', 'idle'] as const) {
      const run = makeRun({ state });
      const ev: PipelineEvent = { type: 'replan_requested', reason: 'misclick' };
      const next = reducer(run, ev);
      expect(next).toBe(run); // identity preserved (no spurious re-renders)
    }
  });

  it('replan_requested + planner_done → planLineage length 2 (v1 SHA + v2 SHA)', () => {
    let run = makeRun({ state: 'planning' });
    run = reducer(run, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-v1',
        confidence: 'verified',
      },
    });
    expect(run.planLineage).toEqual(['sha-v1']);

    // Force into escalated terminal so replan_requested can fire.
    run = { ...run, state: 'escalated', failureClass: 'reviewer_irreconcilable', endedAt: 1 };
    run = reducer(run, { type: 'replan_requested', reason: 'try again' });
    expect(run.state).toBe('planning');

    run = reducer(run, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's-v2', planPath: 'p-v2',
        tasks: [], summary: 's2', planCommitSha: 'sha-v2',
        confidence: 'verified',
      },
    });
    expect(run.planLineage).toEqual(['sha-v1', 'sha-v2']);
    expect(run.escalationLog).toHaveLength(1);
    expect(run.escalationLog[0].decision).toBe('replan');
  });

  // ─── Complexity gate (Phase 3c.1) ─────────────────────────────────────

  it('complexity=trivial: planner_done auto-skips awaiting_plan_approval, halves budgets', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-trivial',
        complexity: 'trivial',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    // The whole point: trivial bypasses the human confirm gate.
    expect(next.state).toBe('building');
    expect(next.runMode).toBe('trivial');
    expect(next.autoApprovePlan).toBe(true);
    expect(next.useDualReviewer).toBe(false);
    expect(next.runRedTeam).toBe(false);
    // Halved with floor + min-1: 3 → 1.
    expect(next.effectiveRetryBudgets).toEqual({ reviewerReject: 1, ciFail: 1 });
  });

  it('complexity=standard: planner_done transitions to awaiting_plan_approval, budgets unchanged', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-std',
        complexity: 'standard',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('awaiting_plan_approval');
    expect(next.runMode).toBe('standard');
    expect(next.autoApprovePlan).toBe(false);
    expect(next.useDualReviewer).toBe(false);
    expect(next.runRedTeam).toBe(false);
    expect(next.effectiveRetryBudgets).toEqual({ reviewerReject: 3, ciFail: 3 });
  });

  it('complexity=standard but template.dualReviewer=true → useDualReviewer=true', () => {
    const run = makeRun({ state: 'planning', templateDualReviewer: true, useDualReviewer: true });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-std-dual',
        complexity: 'standard',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.useDualReviewer).toBe(true);
    expect(next.runRedTeam).toBe(false); // red-team is complex-only, even with dual template
  });

  it('complexity=complex: planner_done transitions to awaiting_plan_approval, stamps dual + redTeam, doubles budgets', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-complex',
        complexity: 'complex',
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('awaiting_plan_approval');
    expect(next.runMode).toBe('complex');
    expect(next.autoApprovePlan).toBe(false);
    expect(next.useDualReviewer).toBe(true);
    expect(next.runRedTeam).toBe(true);
    expect(next.effectiveRetryBudgets).toEqual({ reviewerReject: 6, ciFail: 6 });
  });

  it('complexity undefined: defaults to standard', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-undef',
        // complexity intentionally omitted,
        confidence: 'verified',
      },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('awaiting_plan_approval');
    expect(next.runMode).toBe('standard');
    expect(next.autoApprovePlan).toBe(false);
    expect(next.useDualReviewer).toBe(false);
    expect(next.runRedTeam).toBe(false);
    expect(next.effectiveRetryBudgets).toEqual({ reviewerReject: 3, ciFail: 3 });
  });

  it('replan re-stamps complexity from the new plan (full reset semantic)', () => {
    let run = makeRun({ state: 'planning' });
    // v1: trivial → halved, building.
    run = reducer(run, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-v1',
        complexity: 'trivial',
        confidence: 'verified',
      },
    });
    expect(run.runMode).toBe('trivial');
    expect(run.state).toBe('building');
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 1, ciFail: 1 });

    // Force escalated → replan_requested → planning.
    run = { ...run, state: 'escalated', failureClass: 'reviewer_irreconcilable', endedAt: 1 };
    run = reducer(run, { type: 'replan_requested', reason: 'human override' });
    expect(run.state).toBe('planning');
    // Note: runMode/effectiveRetryBudgets are not cleared by replan; they
    // get overwritten by the next planner_done. That's fine — no transitions
    // read them in 'planning'.

    // v2: complex → re-stamps from the *template* baseline (3,3), not from
    // the prior trivial-halved (1,1). So budgets should be 6/6.
    run = reducer(run, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's-v2', planPath: 'p-v2',
        tasks: [], summary: 's2', planCommitSha: 'sha-v2',
        complexity: 'complex',
        confidence: 'verified',
      },
    });
    expect(run.runMode).toBe('complex');
    expect(run.state).toBe('awaiting_plan_approval');
    expect(run.autoApprovePlan).toBe(false);
    expect(run.useDualReviewer).toBe(true);
    expect(run.runRedTeam).toBe(true);
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 6, ciFail: 6 });
  });

  it('reducer reads effectiveRetryBudgets (not the legacy constant)', () => {
    // Construct a complex run with doubled budgets (6/6) directly. Drive
    // 6 reviewer rejects — all should retry; the 7th should escalate.
    let run = makeRun({
      state: 'reviewing',
      runMode: 'complex',
      effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6 },
    });
    for (let i = 1; i <= 6; i++) {
      run = reducer(run, {
        type: 'reviewer_done',
        verdict: {
          stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
          round: i, comments: [], summary: `r${i}`,
          confidence: 'verified',
        },
      });
      expect(run.state).toBe('building'); // still in retry — would have escalated at >3 with the legacy constant
      run = { ...run, state: 'reviewing' }; // simulate builder→reviewer cycle for the next iteration
    }
    expect(run.retryCounters.reviewerReject).toBe(6);
    // The 7th rejection (next > 6) escalates.
    run = reducer(run, {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
        round: 7, comments: [], summary: 'r7',
        confidence: 'verified',
      },
    });
    expect(run.state).toBe('escalated');
  });

  it('initialRunState seeds complexity-gate defaults', () => {
    const run = initialRunState({
      runId: 'r-init',
      templateId: 'tx.hello',
      projectId: 'p1',
      worktreePath: '/tmp/wt/r-init',
      branch: 'feat/r-init',
      fingerprint: FP,
    });
    expect(run.runMode).toBe('standard');
    expect(run.autoApprovePlan).toBe(false);
    expect(run.useDualReviewer).toBe(false);
    expect(run.runRedTeam).toBe(false);
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 3, ciFail: 3 });
    expect(run.templateRetryBudget).toEqual({ reviewerReject: 3, ciFail: 3 });
    expect(run.templateDualReviewer).toBe(false);
  });

  it('initialRunState honors template-derived defaults', () => {
    const run = initialRunState({
      runId: 'r-tmpl',
      templateId: 'tx.custom',
      projectId: 'p1',
      worktreePath: '/tmp/wt/r-tmpl',
      branch: 'feat/r-tmpl',
      fingerprint: FP,
      templateRetryBudget: { reviewerReject: 5, ciFail: 4 },
      templateDualReviewer: true,
    });
    expect(run.useDualReviewer).toBe(true);
    expect(run.templateDualReviewer).toBe(true);
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 5, ciFail: 4 });
    expect(run.templateRetryBudget).toEqual({ reviewerReject: 5, ciFail: 4 });
  });

  it('escalated remains terminal for non-replan events (carve-out is narrow)', () => {
    const run = makeRun({ state: 'escalated', endedAt: 99 });
    // start, approve_plan, builder_done, ci_pass — all should be no-ops.
    expect(reducer(run, { type: 'start' })).toBe(run);
    expect(reducer(run, { type: 'approve_plan' })).toBe(run);
    expect(reducer(run, {
      type: 'builder_done',
      build: {
        stage: 'builder', branch: 'b', headSha: 'h', round: 1,
        commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
        confidence: 'verified',
      },
    })).toBe(run);
  });
});
