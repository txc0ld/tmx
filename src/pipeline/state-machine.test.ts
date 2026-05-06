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
    state: 'idle',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 0,
    escalationLog: [],
    tiles: {},
    fingerprint: FP,
    planLineage: [],
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
        tasks: [], summary: 's', commitSha: 'sha-v1',
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

  it('any non-terminal state + question_raised → awaiting_clarification', () => {
    const run = makeRun({ state: 'building' });
    const ev: PipelineEvent = {
      type: 'question_raised',
      question: { stage: 'builder', question: 'q?', context: 'c', blocking: true },
    };
    const next = reducer(run, ev);
    expect(next.state).toBe('awaiting_clarification');
    expect(next.artifacts.questions.length).toBe(1);
  });

  it('awaiting_clarification + clarification_received → resumes prior state', () => {
    const run = makeRun({ state: 'awaiting_clarification' });
    const ev: PipelineEvent = { type: 'clarification_received', resumeTo: 'building' };
    expect(reducer(run, ev).state).toBe('building');
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

  it('planner_done appends plan.commitSha to planLineage', () => {
    const run = makeRun({ state: 'planning' });
    const ev: PipelineEvent = {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r1', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', commitSha: 'abc123',
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
        tasks: [], summary: 's', commitSha: 'sha-v1',
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
        tasks: [], summary: 's2', commitSha: 'sha-v2',
      },
    });
    expect(run.planLineage).toEqual(['sha-v1', 'sha-v2']);
    expect(run.escalationLog).toHaveLength(1);
    expect(run.escalationLog[0].decision).toBe('replan');
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
      },
    })).toBe(run);
  });
});
