/**
 * Phase 3c.7 — trust-telemetry events.
 *
 * Five new TelemetryEvent variants surface the trust-related decisions a
 * run made (complexity routing, uncertainty escalation, dual-reviewer
 * disagreement, tiebreaker invocation, red-team findings). These tests
 * verify each event fires from the correct emission site with the right
 * fields. The reducer behavior is covered by state-machine.test.ts;
 * here we only assert on the telemetry channel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  usePipelineStore,
  setPipelineTelemetryEmitter,
  setPipelineLifecycleEmitter,
  type TelemetryEvent,
} from '@/stores/pipelineStore';
import {
  ingestPtyChunk,
  ingestOneshotResult,
  resetIngestionBuffersForTest,
} from './controller-runtime';
import {
  handleDualReviewerLifecycle,
  resetDualReviewerDispatcherForTest,
  type DualReviewerDeps,
} from './dual-reviewer-dispatcher';
import type {
  PipelineRun,
  RunFingerprint,
  ReviewVerdict,
  RedTeamReport,
} from '@/types';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

function captureTelemetry(): { events: TelemetryEvent[]; unsub: () => void } {
  const events: TelemetryEvent[] = [];
  const unsub = setPipelineTelemetryEmitter(ev => { events.push(ev); });
  return { events, unsub };
}

function makeDualRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'r-dual',
    templateId: 'tx.hello',
    projectId: 'p1',
    worktreePath: '/tmp/wt/r-dual',
    branch: 'feat/r1',
    baseBranch: 'main',
    state: 'awaiting_tiebreaker',
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

describe('trust telemetry (Phase 3c.7)', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    resetIngestionBuffersForTest();
    resetDualReviewerDispatcherForTest();
    setPipelineLifecycleEmitter(null);
  });
  afterEach(() => {
    setPipelineTelemetryEmitter(null);
  });

  it('complexity_routed fires on planner_done with the stamped routing flags', () => {
    const { events, unsub } = captureTelemetry();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-complex', templateId: 't', projectId: 'proj-A',
        worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: 'b', specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha-c',
          confidence: 'verified',
          complexity: 'complex',
        },
      });

      const ev = events.find(e => e.event === 'complexity_routed');
      expect(ev).toBeDefined();
      expect(ev).toMatchObject({
        event: 'complexity_routed',
        runId,
        projectId: 'proj-A',
        complexity: 'complex',
        autoApprovePlan: false,
        useDualReviewer: true,
        runRedTeam: true,
      });
    } finally {
      unsub();
    }
  });

  it('complexity_routed: trivial plan stamps autoApprovePlan=true and skips dual/red-team', () => {
    const { events, unsub } = captureTelemetry();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-trivial', templateId: 't', projectId: 'proj-T',
        worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: 'b', specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha-t',
          confidence: 'verified',
          complexity: 'trivial',
        },
      });

      const ev = events.find(e => e.event === 'complexity_routed');
      expect(ev).toMatchObject({
        complexity: 'trivial',
        autoApprovePlan: true,
        useDualReviewer: false,
        runRedTeam: false,
      });
    } finally {
      unsub();
    }
  });

  it('confidence_uncertain_escalated fires when Builder reports uncertain + non-trivial diff', () => {
    const { events, unsub } = captureTelemetry();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-uncertain', templateId: 't', projectId: 'proj-U',
        worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: 'b', specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha',
          confidence: 'verified',
        },
      });
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

      // Builder DONE with uncertain confidence + 5 filesChanged. The
      // controller's maybeEscalateUncertainty should fire question_raised
      // AND emit confidence_uncertain_escalated.
      const sentinel = '<<<TX_STAGE_DONE>>>' + JSON.stringify({
        stage: 'builder', branch: 'b', headSha: 'a', round: 1,
        commits: [],
        filesChanged: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        testsAdded: [], ciStatus: 'green',
        confidence: 'uncertain',
        uncertaintyDrivers: ['unstable test', 'flaky CI'],
      }) + '\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      const ev = events.find(e => e.event === 'confidence_uncertain_escalated');
      expect(ev).toBeDefined();
      expect(ev).toMatchObject({
        event: 'confidence_uncertain_escalated',
        runId,
        projectId: 'proj-U',
        role: 'builder',
        filesChanged: 5,
        commits: 0,
        uncertaintyDrivers: ['unstable test', 'flaky CI'],
      });
    } finally {
      unsub();
    }
  });

  it('confidence_uncertain_escalated does NOT fire when diff is trivial (≤4 files, ≤2 commits)', () => {
    const { events, unsub } = captureTelemetry();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-uncertain-trivial', templateId: 't', projectId: 'proj-U2',
        worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: 'b', specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha',
          confidence: 'verified',
        },
      });
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

      // Only 2 files, 1 commit — below the non-trivial threshold.
      const sentinel = '<<<TX_STAGE_DONE>>>' + JSON.stringify({
        stage: 'builder', branch: 'b', headSha: 'a', round: 1,
        commits: [{ sha: 'aaa', subject: 's', stage: 'builder' }],
        filesChanged: ['a.ts', 'b.ts'],
        testsAdded: [], ciStatus: 'green',
        confidence: 'uncertain',
      }) + '\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      const ev = events.find(e => e.event === 'confidence_uncertain_escalated');
      expect(ev).toBeUndefined();
    } finally {
      unsub();
    }
  });

  it('dual_reviewer_disagreement fires on awaiting_dual_reviewer → awaiting_tiebreaker transition', () => {
    const { events, unsub } = captureTelemetry();
    try {
      // Build up a complex run that's parked at awaiting_dual_reviewer.
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-disagree', templateId: 't', projectId: 'proj-D',
        worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: 'b', specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha',
          confidence: 'verified',
          complexity: 'complex',
        },
      });
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'builder_done',
        build: {
          stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
          filesChanged: [], testsAdded: [], ciStatus: 'green',
          confidence: 'verified',
        },
      });
      // Sanity: complex runs route through dual-reviewer.
      expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_dual_reviewer');

      // Opus approve, Codex reject → reducer routes to awaiting_tiebreaker.
      const opusVerdict: ReviewVerdict = {
        stage: 'reviewer', reviewer: 'opus', verdict: 'approve', round: 1,
        comments: [], summary: 'lgtm', confidence: 'verified',
      };
      const codexVerdict: ReviewVerdict = {
        stage: 'reviewer', reviewer: 'codex', verdict: 'reject', round: 1,
        comments: [], summary: 'concerns', confidence: 'verified',
      };
      usePipelineStore.getState().dispatch(runId, { type: 'reviewer_done', verdict: opusVerdict });
      usePipelineStore.getState().dispatch(runId, { type: 'reviewer_done', verdict: codexVerdict });

      expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_tiebreaker');
      const ev = events.find(e => e.event === 'dual_reviewer_disagreement');
      expect(ev).toBeDefined();
      expect(ev).toMatchObject({
        event: 'dual_reviewer_disagreement',
        runId,
        projectId: 'proj-D',
        opusVerdict: 'approve',
        codexVerdict: 'reject',
      });
    } finally {
      unsub();
    }
  });

  it('tiebreaker_invoked fires from the dispatcher on awaiting_tiebreaker entry', () => {
    const { events, unsub } = captureTelemetry();
    try {
      // Seed the store with a run already parked at awaiting_tiebreaker.
      const run = makeDualRun({ id: 'r-tie', projectId: 'proj-TB' });
      usePipelineStore.setState((s) => ({
        ...s,
        runs: { ...s.runs, [run.id]: run },
      }));
      const fire = vi.fn();
      const deps: DualReviewerDeps = { runOneShotReviewer: fire };

      handleDualReviewerLifecycle({
        runId: run.id,
        projectId: run.projectId,
        worktreePath: run.worktreePath,
        from: 'awaiting_dual_reviewer',
        to: 'awaiting_tiebreaker',
        trigger: 'reviewer_done',
      }, deps);

      // Dispatcher fires gemini and emits the telemetry event.
      expect(fire).toHaveBeenCalledTimes(1);
      expect(fire).toHaveBeenCalledWith({ runId: 'r-tie', role: 'reviewer', provider: 'gemini' });
      const ev = events.find(e => e.event === 'tiebreaker_invoked');
      expect(ev).toBeDefined();
      expect(ev).toMatchObject({
        event: 'tiebreaker_invoked',
        runId: 'r-tie',
        projectId: 'proj-TB',
        provider: 'gemini',
      });
    } finally {
      unsub();
    }
  });

  it('red_team_finding fires once per finding (per-finding semantics)', () => {
    const { events, unsub } = captureTelemetry();
    try {
      // Build up a complex run, push through reviewer approval, and reach
      // awaiting_red_team. Then ingest a red-team sentinel with 3 findings.
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-rt', templateId: 't', projectId: 'proj-RT',
        worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: 'b', specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha',
          confidence: 'verified',
          complexity: 'complex',
        },
      });
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'builder_done',
        build: {
          stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
          filesChanged: [], testsAdded: [], ciStatus: 'green',
          confidence: 'verified',
        },
      });
      // Both reviewers approve so we pass through to awaiting_red_team.
      usePipelineStore.getState().dispatch(runId, {
        type: 'reviewer_done',
        verdict: {
          stage: 'reviewer', reviewer: 'opus', verdict: 'approve', round: 1,
          comments: [], summary: 'ok', confidence: 'verified',
        },
      });
      usePipelineStore.getState().dispatch(runId, {
        type: 'reviewer_done',
        verdict: {
          stage: 'reviewer', reviewer: 'codex', verdict: 'approve', round: 1,
          comments: [], summary: 'ok', confidence: 'verified',
        },
      });
      expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_red_team');

      const report: RedTeamReport = {
        stage: 'red-team',
        findings: [
          { severity: 'concern', category: 'prompt-injection', description: 'untrusted input echoed', file: 'a.ts', line: 12 },
          { severity: 'nit', category: 'edge-case', description: 'off-by-one in loop' },
          { severity: 'concern', category: 'race-condition', description: 'shared mutable map' },
        ],
        summary: 'three issues',
        confidence: 'verified',
      };
      const sentinel = '<<<TX_REDTEAM_DONE>>>' + JSON.stringify(report) + '\n';
      ingestOneshotResult({ runId, role: 'red-team', stdout: sentinel, exitCode: 0 });

      const findings = events.filter(e => e.event === 'red_team_finding');
      expect(findings).toHaveLength(3);
      expect(findings[0]).toMatchObject({
        event: 'red_team_finding',
        runId,
        projectId: 'proj-RT',
        severity: 'concern',
        category: 'prompt-injection',
        file: 'a.ts',
        line: 12,
      });
      expect(findings[1]).toMatchObject({ severity: 'nit', category: 'edge-case' });
      expect(findings[2]).toMatchObject({ severity: 'concern', category: 'race-condition' });
    } finally {
      unsub();
    }
  });

  it('red_team_finding fires zero events when the report has zero findings', () => {
    const { events, unsub } = captureTelemetry();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-rt-clean', templateId: 't', projectId: 'proj-RT2',
        worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: 'b', specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha',
          confidence: 'verified',
          complexity: 'complex',
        },
      });
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
      usePipelineStore.getState().dispatch(runId, {
        type: 'builder_done',
        build: {
          stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
          filesChanged: [], testsAdded: [], ciStatus: 'green',
          confidence: 'verified',
        },
      });
      usePipelineStore.getState().dispatch(runId, {
        type: 'reviewer_done',
        verdict: {
          stage: 'reviewer', reviewer: 'opus', verdict: 'approve', round: 1,
          comments: [], summary: 'ok', confidence: 'verified',
        },
      });
      usePipelineStore.getState().dispatch(runId, {
        type: 'reviewer_done',
        verdict: {
          stage: 'reviewer', reviewer: 'codex', verdict: 'approve', round: 1,
          comments: [], summary: 'ok', confidence: 'verified',
        },
      });

      const report: RedTeamReport = {
        stage: 'red-team', findings: [], summary: 'clean', confidence: 'verified',
      };
      const sentinel = '<<<TX_REDTEAM_DONE>>>' + JSON.stringify(report) + '\n';
      ingestOneshotResult({ runId, role: 'red-team', stdout: sentinel, exitCode: 0 });

      const findings = events.filter(e => e.event === 'red_team_finding');
      expect(findings).toHaveLength(0);
    } finally {
      unsub();
    }
  });
});
