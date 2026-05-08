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
      retryCounters: { reviewerReject: 3, ciFail: 0, planReject: 3 },
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
      retryCounters: { reviewerReject: 0, ciFail: 3, planReject: 0 },
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
    expect(run.retryCounters).toEqual({ reviewerReject: 0, ciFail: 0, planReject: 0 });
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
      retryCounters: { reviewerReject: 3, ciFail: 0, planReject: 3 },
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

  // ─── reject_plan (operator-driven plan rejection) ────────────────────

  it('reject_plan: awaiting_plan_approval → planning, increments planReject counter, appends rejection to questions', () => {
    const run = makeRun({
      state: 'awaiting_plan_approval',
      retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 },
    });
    const ev: PipelineEvent = { type: 'reject_plan', feedback: 'Scope is too broad — focus on auth only.' };
    const next = reducer(run, ev);
    expect(next.state).toBe('planning');
    expect(next.retryCounters.planReject).toBe(1);
    expect(next.artifacts.questions).toHaveLength(1);
    expect(next.artifacts.questions[0].stage).toBe('planner');
    expect(next.artifacts.questions[0].context).toContain('auth only');
    expect(next.endedAt).toBeUndefined();
  });

  it('reject_plan: exceeding planReject budget → escalated with plan_reject_exhausted', () => {
    const run = makeRun({
      state: 'awaiting_plan_approval',
      retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 3 },
      effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3, planReject: 3 },
    });
    const ev: PipelineEvent = { type: 'reject_plan', feedback: 'Still wrong direction' };
    const next = reducer(run, ev);
    expect(next.state).toBe('escalated');
    expect(next.failureClass).toBe('plan_reject_exhausted');
    expect(next.retryCounters.planReject).toBe(4);
    expect(next.endedAt).toBeDefined();
  });

  it('reject_plan from non-awaiting_plan_approval states is a no-op', () => {
    for (const state of ['planning', 'building', 'reviewing', 'idle', 'done', 'failed'] as const) {
      const run = makeRun({ state });
      const ev: PipelineEvent = { type: 'reject_plan', feedback: 'whatever' };
      const next = reducer(run, ev);
      expect(next).toBe(run);
    }
  });

  it('reject_plan + planner_done → run loops cleanly back through awaiting_plan_approval', () => {
    let run = makeRun({ state: 'awaiting_plan_approval' });
    run = reducer(run, { type: 'reject_plan', feedback: 'too vague' });
    expect(run.state).toBe('planning');
    run = reducer(run, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's-v2', planPath: 'p-v2',
        tasks: [], summary: 's2', planCommitSha: 'sha-v2',
        confidence: 'verified',
      },
    });
    expect(run.state).toBe('awaiting_plan_approval');
    expect(run.planLineage).toEqual(['sha-v2']);
    expect(run.retryCounters.planReject).toBe(1); // counter persists across the loop
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
    expect(next.effectiveRetryBudgets).toEqual({ reviewerReject: 1, ciFail: 1, planReject: 1 });
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
    expect(next.effectiveRetryBudgets).toEqual({ reviewerReject: 3, ciFail: 3, planReject: 3 });
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
    expect(next.effectiveRetryBudgets).toEqual({ reviewerReject: 6, ciFail: 6, planReject: 6 });
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
    expect(next.effectiveRetryBudgets).toEqual({ reviewerReject: 3, ciFail: 3, planReject: 3 });
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
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 1, ciFail: 1, planReject: 1 });

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
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 6, ciFail: 6, planReject: 6 });
  });

  it('reducer reads effectiveRetryBudgets (not the legacy constant)', () => {
    // Construct a complex run with doubled budgets (6/6) directly. Drive
    // 6 reviewer rejects — all should retry; the 7th should escalate.
    let run = makeRun({
      state: 'reviewing',
      runMode: 'complex',
      effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6, planReject: 6 },
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
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 3, ciFail: 3, planReject: 3 });
    expect(run.templateRetryBudget).toEqual({ reviewerReject: 3, ciFail: 3, planReject: 3 });
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
      templateRetryBudget: { reviewerReject: 5, ciFail: 4, planReject: 5 },
      templateDualReviewer: true,
    });
    expect(run.useDualReviewer).toBe(true);
    expect(run.templateDualReviewer).toBe(true);
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 5, ciFail: 4, planReject: 5 });
    expect(run.templateRetryBudget).toEqual({ reviewerReject: 5, ciFail: 4, planReject: 5 });
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

  // ─── Phase 3c.4: dual-reviewer reconciliation + tiebreaker ──────

  describe('dual-reviewer reconciliation (Phase 3c.4)', () => {
    const opusApprove = (round = 1) => ({
      stage: 'reviewer' as const, reviewer: 'opus' as const, verdict: 'approve' as const,
      round, comments: [], summary: 'lgtm-opus', confidence: 'verified' as const,
    });
    const opusReject = (round = 1) => ({
      stage: 'reviewer' as const, reviewer: 'opus' as const, verdict: 'reject' as const,
      round, comments: [], summary: 'no-opus', confidence: 'verified' as const,
    });
    const codexApprove = (round = 1) => ({
      stage: 'reviewer' as const, reviewer: 'codex' as const, verdict: 'approve' as const,
      round, comments: [], summary: 'lgtm-codex', confidence: 'verified' as const,
    });
    const codexReject = (round = 1) => ({
      stage: 'reviewer' as const, reviewer: 'codex' as const, verdict: 'reject' as const,
      round, comments: [], summary: 'no-codex', confidence: 'verified' as const,
    });
    // Tiebreaker uses the merged-style stamp (any reviewer slot will do; the
    // reducer doesn't care which `reviewer` field wins the tiebreaker, only
    // its `verdict`). Use 'merged' so the artifact log clearly marks it.
    const tiebreakerApprove = () => ({
      stage: 'reviewer' as const, reviewer: 'merged' as const, verdict: 'approve' as const,
      round: 1, comments: [], summary: 'lgtm-tiebreaker', confidence: 'verified' as const,
    });
    const tiebreakerReject = () => ({
      stage: 'reviewer' as const, reviewer: 'merged' as const, verdict: 'reject' as const,
      round: 1, comments: [], summary: 'no-tiebreaker', confidence: 'verified' as const,
    });

    it('non-dual run: builder_done → reviewing (legacy single-reviewer flow)', () => {
      const run = makeRun({ state: 'building', useDualReviewer: false });
      const next = reducer(run, {
        type: 'builder_done',
        build: {
          stage: 'builder', branch: 'feat/r1', headSha: 'a', round: 1,
          commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
          confidence: 'verified',
        },
      });
      expect(next.state).toBe('reviewing');
    });

    it('dual run: builder_done → awaiting_dual_reviewer', () => {
      const run = makeRun({ state: 'building', useDualReviewer: true });
      const next = reducer(run, {
        type: 'builder_done',
        build: {
          stage: 'builder', branch: 'feat/r1', headSha: 'a', round: 1,
          commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
          confidence: 'verified',
        },
      });
      expect(next.state).toBe('awaiting_dual_reviewer');
      expect(next.artifacts.builds.length).toBe(1);
    });

    it('first reviewer arrives alone → stays in awaiting_dual_reviewer', () => {
      const run = makeRun({ state: 'awaiting_dual_reviewer', useDualReviewer: true });
      const next = reducer(run, { type: 'reviewer_done', verdict: opusApprove() });
      expect(next.state).toBe('awaiting_dual_reviewer');
      expect(next.artifacts.reviews.length).toBe(1);
    });

    it('both approve → awaiting_merge_approval', () => {
      let run = makeRun({ state: 'awaiting_dual_reviewer', useDualReviewer: true });
      run = reducer(run, { type: 'reviewer_done', verdict: opusApprove() });
      expect(run.state).toBe('awaiting_dual_reviewer');
      run = reducer(run, { type: 'reviewer_done', verdict: codexApprove() });
      expect(run.state).toBe('awaiting_merge_approval');
      expect(run.artifacts.reviews.length).toBe(2);
      expect(run.retryCounters.reviewerReject).toBe(0);
    });

    it('both reject within budget → building (counter increments)', () => {
      let run = makeRun({ state: 'awaiting_dual_reviewer', useDualReviewer: true });
      run = reducer(run, { type: 'reviewer_done', verdict: opusReject() });
      run = reducer(run, { type: 'reviewer_done', verdict: codexReject() });
      expect(run.state).toBe('building');
      expect(run.retryCounters.reviewerReject).toBe(1);
      expect(run.artifacts.reviews.length).toBe(2);
    });

    it('both reject exceeds budget → escalated (reviewer_irreconcilable)', () => {
      let run = makeRun({
        state: 'awaiting_dual_reviewer',
        useDualReviewer: true,
        retryCounters: { reviewerReject: 3, ciFail: 0, planReject: 3 },
      });
      run = reducer(run, { type: 'reviewer_done', verdict: opusReject(4) });
      run = reducer(run, { type: 'reviewer_done', verdict: codexReject(4) });
      expect(run.state).toBe('escalated');
      expect(run.failureClass).toBe('reviewer_irreconcilable');
      expect(run.endedAt).toBeGreaterThan(0);
    });

    it('disagree (opus approve, codex reject) → awaiting_tiebreaker, NO counter bump', () => {
      let run = makeRun({ state: 'awaiting_dual_reviewer', useDualReviewer: true });
      run = reducer(run, { type: 'reviewer_done', verdict: opusApprove() });
      run = reducer(run, { type: 'reviewer_done', verdict: codexReject() });
      expect(run.state).toBe('awaiting_tiebreaker');
      expect(run.retryCounters.reviewerReject).toBe(0);
      expect(run.artifacts.reviews.length).toBe(2);
    });

    it('disagree (opus reject, codex approve) → awaiting_tiebreaker (order independent)', () => {
      let run = makeRun({ state: 'awaiting_dual_reviewer', useDualReviewer: true });
      run = reducer(run, { type: 'reviewer_done', verdict: codexApprove() });
      run = reducer(run, { type: 'reviewer_done', verdict: opusReject() });
      expect(run.state).toBe('awaiting_tiebreaker');
      expect(run.retryCounters.reviewerReject).toBe(0);
    });

    it('tiebreaker approves → awaiting_merge_approval', () => {
      let run = makeRun({
        state: 'awaiting_dual_reviewer',
        useDualReviewer: true,
        artifacts: {
          builds: [], reviews: [opusApprove(), codexReject()], ciResults: [], questions: [], redTeamReports: [],
        },
      });
      // First, get into the tiebreaker state (the test prepares that with
      // pre-seeded artifacts by re-issuing one of them and letting the
      // reducer reconcile). Simpler: jump straight to awaiting_tiebreaker.
      run = makeRun({
        state: 'awaiting_tiebreaker',
        useDualReviewer: true,
        artifacts: {
          builds: [], reviews: [opusApprove(), codexReject()], ciResults: [], questions: [], redTeamReports: [],
        },
      });
      run = reducer(run, { type: 'reviewer_done', verdict: tiebreakerApprove() });
      expect(run.state).toBe('awaiting_merge_approval');
      expect(run.retryCounters.reviewerReject).toBe(0);
      expect(run.artifacts.reviews.length).toBe(3);
    });

    it('tiebreaker rejects within budget → building (counter NOW increments)', () => {
      let run = makeRun({
        state: 'awaiting_tiebreaker',
        useDualReviewer: true,
        artifacts: {
          builds: [], reviews: [opusApprove(), codexReject()], ciResults: [], questions: [], redTeamReports: [],
        },
      });
      run = reducer(run, { type: 'reviewer_done', verdict: tiebreakerReject() });
      expect(run.state).toBe('building');
      expect(run.retryCounters.reviewerReject).toBe(1);
      expect(run.artifacts.reviews.length).toBe(3);
    });

    it('tiebreaker rejects at budget threshold → escalated', () => {
      let run = makeRun({
        state: 'awaiting_tiebreaker',
        useDualReviewer: true,
        retryCounters: { reviewerReject: 3, ciFail: 0, planReject: 3 },
        artifacts: {
          builds: [], reviews: [opusApprove(), codexReject()], ciResults: [], questions: [], redTeamReports: [],
        },
      });
      run = reducer(run, { type: 'reviewer_done', verdict: tiebreakerReject() });
      expect(run.state).toBe('escalated');
      expect(run.failureClass).toBe('reviewer_irreconcilable');
      expect(run.endedAt).toBeGreaterThan(0);
    });

    it('end-to-end: complex run loops through dual + tiebreaker + retry', () => {
      let run = makeRun({
        state: 'planning',
        useDualReviewer: true,
        templateDualReviewer: true,
        runMode: 'complex',
        effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6, planReject: 6 },
      });
      // planner_done → awaiting_plan_approval
      run = reducer(run, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
          tasks: [], summary: 's', planCommitSha: 'sha-v1',
          complexity: 'complex', confidence: 'verified',
        },
      });
      expect(run.state).toBe('awaiting_plan_approval');
      expect(run.useDualReviewer).toBe(true);
      // approve → building → builder_done → awaiting_dual_reviewer
      run = reducer(run, { type: 'approve_plan' });
      expect(run.state).toBe('building');
      run = reducer(run, {
        type: 'builder_done',
        build: {
          stage: 'builder', branch: 'feat/r1', headSha: 'a', round: 1,
          commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
          confidence: 'verified',
        },
      });
      expect(run.state).toBe('awaiting_dual_reviewer');
      // Disagree → awaiting_tiebreaker (no counter bump)
      run = reducer(run, { type: 'reviewer_done', verdict: opusApprove() });
      run = reducer(run, { type: 'reviewer_done', verdict: codexReject() });
      expect(run.state).toBe('awaiting_tiebreaker');
      expect(run.retryCounters.reviewerReject).toBe(0);
      // Tiebreaker rejects → building (counter NOW = 1)
      run = reducer(run, { type: 'reviewer_done', verdict: tiebreakerReject() });
      expect(run.state).toBe('building');
      expect(run.retryCounters.reviewerReject).toBe(1);
    });

    it('reviewer_done in unrelated state is no-op', () => {
      const run = makeRun({ state: 'building', useDualReviewer: true });
      const next = reducer(run, { type: 'reviewer_done', verdict: opusApprove() });
      expect(next).toBe(run);
    });
  });

  // ─── Phase 3c.6: red-team role ──────────────────────────────────────

  describe('red-team role (Phase 3c.6)', () => {
    const reviewApprove = () => ({
      stage: 'reviewer' as const, reviewer: 'opus' as const, verdict: 'approve' as const,
      round: 1, comments: [], summary: 'lgtm', confidence: 'verified' as const,
    });
    const codexApproveLocal = () => ({
      stage: 'reviewer' as const, reviewer: 'codex' as const, verdict: 'approve' as const,
      round: 1, comments: [], summary: 'lgtm-codex', confidence: 'verified' as const,
    });
    const tiebreakerApproveLocal = () => ({
      stage: 'reviewer' as const, reviewer: 'merged' as const, verdict: 'approve' as const,
      round: 1, comments: [], summary: 'lgtm-tb', confidence: 'verified' as const,
    });
    const cleanReport = (): import('@/types').RedTeamReport => ({
      stage: 'red-team',
      findings: [],
      summary: 'no findings',
      confidence: 'verified',
    });
    const concernReport = (): import('@/types').RedTeamReport => ({
      stage: 'red-team',
      findings: [{
        severity: 'concern',
        category: 'supply-chain',
        description: 'new dep not pinned',
        file: 'package.json',
        line: 42,
      }],
      summary: 'one supply-chain concern',
      confidence: 'verified',
    });
    const blockerReport = (): import('@/types').RedTeamReport => ({
      stage: 'red-team',
      findings: [{
        severity: 'blocker',
        category: 'secret-exposure',
        description: 'API key written to log on error path',
        file: 'src/auth.ts',
        line: 88,
      }],
      summary: 'secret leaks under error',
      confidence: 'verified',
    });

    it('reviewer approve + runRedTeam=false → awaiting_merge_approval (control)', () => {
      const run = makeRun({ state: 'reviewing', runRedTeam: false });
      const next = reducer(run, { type: 'reviewer_done', verdict: reviewApprove() });
      expect(next.state).toBe('awaiting_merge_approval');
    });

    it('reviewer approve + runRedTeam=true → awaiting_red_team (new branch)', () => {
      const run = makeRun({ state: 'reviewing', runRedTeam: true });
      const next = reducer(run, { type: 'reviewer_done', verdict: reviewApprove() });
      expect(next.state).toBe('awaiting_red_team');
    });

    it('dual-reviewer both approve + runRedTeam=true → awaiting_red_team', () => {
      let run = makeRun({
        state: 'awaiting_dual_reviewer',
        useDualReviewer: true,
        runRedTeam: true,
      });
      run = reducer(run, { type: 'reviewer_done', verdict: reviewApprove() });
      expect(run.state).toBe('awaiting_dual_reviewer'); // first arrives alone
      run = reducer(run, { type: 'reviewer_done', verdict: codexApproveLocal() });
      expect(run.state).toBe('awaiting_red_team');
    });

    it('tiebreaker approve + runRedTeam=true → awaiting_red_team', () => {
      const codexRejectLocal = () => ({
        stage: 'reviewer' as const, reviewer: 'codex' as const, verdict: 'reject' as const,
        round: 1, comments: [], summary: 'no-codex', confidence: 'verified' as const,
      });
      const run = makeRun({
        state: 'awaiting_tiebreaker',
        useDualReviewer: true,
        runRedTeam: true,
        artifacts: {
          builds: [], reviews: [reviewApprove(), codexRejectLocal()], ciResults: [], questions: [], redTeamReports: [],
        },
      });
      const next = reducer(run, { type: 'reviewer_done', verdict: tiebreakerApproveLocal() });
      expect(next.state).toBe('awaiting_red_team');
    });

    it('red_team_done with no findings → awaiting_merge_approval', () => {
      const run = makeRun({ state: 'awaiting_red_team', runRedTeam: true });
      const next = reducer(run, { type: 'red_team_done', report: cleanReport() });
      expect(next.state).toBe('awaiting_merge_approval');
      expect(next.artifacts.redTeamReports).toHaveLength(1);
    });

    it('red_team_done with concerns only → awaiting_merge_approval (concerns surface, do not block)', () => {
      const run = makeRun({ state: 'awaiting_red_team', runRedTeam: true });
      const next = reducer(run, { type: 'red_team_done', report: concernReport() });
      expect(next.state).toBe('awaiting_merge_approval');
      expect(next.artifacts.redTeamReports).toHaveLength(1);
      expect(next.artifacts.redTeamReports[0].findings[0].severity).toBe('concern');
    });

    it('red_team_done with blocker → failed (failureClass=red_team_blocker)', () => {
      const run = makeRun({ state: 'awaiting_red_team', runRedTeam: true });
      const next = reducer(run, { type: 'red_team_done', report: blockerReport() });
      expect(next.state).toBe('failed');
      expect(next.failureClass).toBe('red_team_blocker');
      expect(next.failureReason).toContain('blocker');
      expect(next.endedAt).toBeGreaterThan(0);
      expect(next.artifacts.redTeamReports).toHaveLength(1);
    });

    it('red_team_done with mixed severities (1 blocker + 2 concerns) → failed', () => {
      const run = makeRun({ state: 'awaiting_red_team', runRedTeam: true });
      const mixed: import('@/types').RedTeamReport = {
        stage: 'red-team',
        findings: [
          { severity: 'concern', category: 'edge-case', description: 'unicode boundary' },
          { severity: 'blocker', category: 'race-condition', description: 'lock released early' },
          { severity: 'concern', category: 'supply-chain', description: 'unpinned dep' },
        ],
        summary: 'mixed',
        confidence: 'verified',
      };
      const next = reducer(run, { type: 'red_team_done', report: mixed });
      expect(next.state).toBe('failed');
      expect(next.failureClass).toBe('red_team_blocker');
    });

    it('red_team_failed → failed with role reason', () => {
      const run = makeRun({ state: 'awaiting_red_team', runRedTeam: true });
      const next = reducer(run, { type: 'red_team_failed', reason: 'red-team: env broken' });
      expect(next.state).toBe('failed');
      expect(next.failureClass).toBe('red_team_blocker');
      expect(next.failureReason).toBe('red-team: env broken');
    });

    it('red_team_done from non-awaiting_red_team state is no-op', () => {
      for (const state of ['building', 'reviewing', 'awaiting_merge_approval', 'merging'] as const) {
        const run = makeRun({ state, runRedTeam: true });
        const next = reducer(run, { type: 'red_team_done', report: blockerReport() });
        expect(next).toBe(run);
      }
    });

    it('approve_merge from awaiting_red_team is a no-op (must clear red-team first)', () => {
      const run = makeRun({ state: 'awaiting_red_team', runRedTeam: true });
      const next = reducer(run, { type: 'approve_merge' });
      expect(next).toBe(run);
    });

    it('end-to-end complex flow: reviewer approve → red-team clean → merge_approval → done', () => {
      let run = makeRun({
        state: 'reviewing',
        runMode: 'complex',
        runRedTeam: true,
        effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6, planReject: 6 },
      });
      run = reducer(run, { type: 'reviewer_done', verdict: reviewApprove() });
      expect(run.state).toBe('awaiting_red_team');
      run = reducer(run, { type: 'red_team_done', report: cleanReport() });
      expect(run.state).toBe('awaiting_merge_approval');
      run = reducer(run, { type: 'approve_merge' });
      expect(run.state).toBe('merging');
      run = reducer(run, { type: 'merge_done' });
      expect(run.state).toBe('done');
    });
  });
});
