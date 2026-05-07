/**
 * Phase 3c end-to-end smoke test.
 *
 * Sister to `phase3a-smoke.test.tsx` and `phase3b-smoke.test.tsx`. Phase 3c
 * shipped the trust layer:
 *   - 3c.1: plan complexity gate (trivial/standard/complex routing)
 *   - 3c.2: required `confidence` on every DONE sentinel
 *   - 3c.3: uncertain + non-trivial diff → synthetic clarification
 *   - 3c.4: dual-reviewer reconciliation + tiebreaker
 *   - 3c.5: diff-aware reviewer chunking guidance (no test surface)
 *   - 3c.6: red-team role for `complex` runs
 *   - 3c.7: trust telemetry — five new event variants
 *
 * Mocks the IPC boundary only — reducer + dual-reviewer-dispatcher +
 * controller-runtime + telemetry plumbing all run real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// IPC mock — spread real module, override the surface the controller +
// watchers touch. Match the pattern in phase3a/3b smoke.
vi.mock('@/utils/ipc', async (importActual) => {
  const real = await importActual<typeof import('@/utils/ipc')>();
  return {
    ...real,
    ptyWrite: vi.fn().mockResolvedValue(undefined),
    readFileText: vi.fn().mockResolvedValue(''),
    writeFileText: vi.fn().mockResolvedValue(undefined),
    readFileMtime: vi.fn().mockResolvedValue(null),
    pipelineReadRolePrompt: vi.fn().mockResolvedValue(null),
    onPtyOutput: vi.fn().mockResolvedValue(() => {}),
    pipelineTelemetryLog: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  usePipelineStore,
  setPipelineTelemetryEmitter,
  setPipelineLifecycleEmitter,
  type TelemetryEvent,
} from '@/stores/pipelineStore';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  ingestPtyChunk,
  resetIngestionBuffersForTest,
} from './controller-runtime';
import { resetScratchpadStateForTest } from './scratchpad-watcher';
import { resetCompactionStateForTest } from './compaction-watcher';
import {
  handleDualReviewerLifecycle,
  resetDualReviewerDispatcherForTest,
  TIEBREAKER_PROVIDER,
  type DualReviewerDeps,
  type RunOneShotReviewerInput,
} from './dual-reviewer-dispatcher';
import type {
  PipelineRun,
  RunFingerprint,
  PipelineState,
  ReviewVerdict,
  RedTeamReport,
  RedTeamFinding,
  BuildArtifact,
  PlanArtifact,
} from '@/types';

const PROJECT_ID = 'proj-3c';
const RUN_ID = 'run-3c';
const WORKTREE = '/tmp/wt-3c';

const FP: RunFingerprint = {
  templateId: 't',
  templateHash: 'h',
  skillHashes: {},
  rolePromptHashes: {},
  models: {},
  capabilityManifests: {},
  terminalxVersion: '0.1.0',
};

function makeRun(
  state: PipelineState = 'planning',
  overrides: Partial<PipelineRun> = {},
): PipelineRun {
  return {
    id: RUN_ID,
    templateId: 'tmpl-3c',
    projectId: PROJECT_ID,
    worktreePath: WORKTREE,
    branch: 'feat/3c',
    baseBranch: 'main',
    state,
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: Date.now(),
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

function seedRun(run: PipelineRun): void {
  usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
}

function plan(complexity: 'trivial' | 'standard' | 'complex', extra: Partial<PlanArtifact> = {}): PlanArtifact {
  return {
    stage: 'planner',
    branch: 'feat/3c',
    specPath: 'spec.md',
    planPath: 'plan.md',
    tasks: [],
    summary: 's',
    planCommitSha: `sha-${complexity}`,
    complexity,
    confidence: 'verified',
    ...extra,
  };
}

function build(extra: Partial<BuildArtifact> = {}): BuildArtifact {
  return {
    stage: 'builder',
    branch: 'feat/3c',
    headSha: 'h0',
    round: 1,
    commits: [],
    filesChanged: [],
    testsAdded: [],
    ciStatus: 'green',
    confidence: 'verified',
    ...extra,
  };
}

function verdict(reviewer: 'opus' | 'codex' | 'merged', v: 'approve' | 'reject', round = 1): ReviewVerdict {
  return {
    stage: 'reviewer',
    reviewer,
    verdict: v,
    round,
    comments: [],
    summary: `${reviewer} ${v}`,
    confidence: 'verified',
  };
}

function clean(): void {
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  useCanvasStore.setState({ tiles: {}, activeProject: '' });
  resetIngestionBuffersForTest();
  resetScratchpadStateForTest();
  resetCompactionStateForTest();
  resetDualReviewerDispatcherForTest();
  setPipelineTelemetryEmitter(null);
  setPipelineLifecycleEmitter(null);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('Phase 3c smoke: complexity gate + dual-reviewer + tiebreaker + red-team + trust telemetry', () => {
  beforeEach(() => clean());
  afterEach(() => clean());

  // 1. Complex plan stamps useDualReviewer + runRedTeam + doubled budgets,
  //    and emits `complexity_routed` telemetry.
  it('complex plan: stamps dual-reviewer + red-team + doubled budgets and emits complexity_routed', () => {
    seedRun(makeRun('planning'));
    const captured: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));

    usePipelineStore.getState().dispatch(RUN_ID, {
      type: 'planner_done',
      plan: plan('complex'),
    });

    const run = usePipelineStore.getState().runs[RUN_ID];
    expect(run.runMode).toBe('complex');
    expect(run.useDualReviewer).toBe(true);
    expect(run.runRedTeam).toBe(true);
    // Doubled from default 3.
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 6, ciFail: 6 });
    // Complex doesn't auto-approve — operator still confirms.
    expect(run.state).toBe('awaiting_plan_approval');
    expect(run.autoApprovePlan).toBe(false);

    const routed = captured.find(e => e.event === 'complexity_routed');
    expect(routed).toBeDefined();
    expect(routed).toMatchObject({
      event: 'complexity_routed',
      runId: RUN_ID,
      projectId: PROJECT_ID,
      complexity: 'complex',
      autoApprovePlan: false,
      useDualReviewer: true,
      runRedTeam: true,
    });

    // Ordering: state_change before complexity_routed (the trust event is
    // emitted after the state-change event by pipelineStore.dispatch).
    const stateIdx = captured.findIndex(e => e.event === 'state_change');
    const routedIdx = captured.findIndex(e => e.event === 'complexity_routed');
    expect(stateIdx).toBeLessThan(routedIdx);
  });

  // 2. Trivial plan auto-approves — state goes straight to building, skipping
  //    awaiting_plan_approval. autoApprovePlan flag is the audit trail.
  it('trivial plan: auto-skips awaiting_plan_approval and halves budgets', () => {
    seedRun(makeRun('planning'));

    usePipelineStore.getState().dispatch(RUN_ID, {
      type: 'planner_done',
      plan: plan('trivial'),
    });

    const run = usePipelineStore.getState().runs[RUN_ID];
    expect(run.state).toBe('building');
    expect(run.autoApprovePlan).toBe(true);
    expect(run.useDualReviewer).toBe(false);
    expect(run.runRedTeam).toBe(false);
    // Halved from default 3 → 1 (floor + min-1).
    expect(run.effectiveRetryBudgets).toEqual({ reviewerReject: 1, ciFail: 1 });
  });

  // 3. Uncertain confidence + non-trivial diff (≥5 files) → synthetic
  //    `question_raised` after the normal builder_done transition. Resume
  //    point captured as priorActiveState.
  it('uncertain builder + non-trivial diff escalates to awaiting_clarification with telemetry', async () => {
    // Builder runs after the plan is approved.
    seedRun(makeRun('building'));
    const captured: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));

    // 7 files changed → >= 5 threshold. Confidence uncertain.
    const filesChanged = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const builderJson = JSON.stringify(build({
      confidence: 'uncertain',
      uncertaintyDrivers: ['didn’t re-run tests'],
      filesChanged,
    }));
    ingestPtyChunk({
      runId: RUN_ID,
      role: 'builder',
      chunk: `<<<TX_STAGE_DONE>>>${builderJson}\n`,
    });
    await flushMicrotasks();

    const run = usePipelineStore.getState().runs[RUN_ID];
    expect(run.state).toBe('awaiting_clarification');
    expect(run.priorActiveState).toBe('reviewing');
    expect(run.artifacts.questions).toHaveLength(1);
    expect(run.artifacts.questions[0].stage).toBe('builder');
    expect(run.artifacts.questions[0].blocking).toBe(true);

    const escalated = captured.find(e => e.event === 'confidence_uncertain_escalated');
    expect(escalated).toBeDefined();
    expect(escalated).toMatchObject({
      event: 'confidence_uncertain_escalated',
      runId: RUN_ID,
      projectId: PROJECT_ID,
      role: 'builder',
      filesChanged: 7,
      uncertaintyDrivers: ['didn’t re-run tests'],
    });
  });

  // 4. Dual-reviewer disagreement (opus approve, codex reject) routes to
  //    awaiting_tiebreaker and emits `dual_reviewer_disagreement` telemetry.
  it('dual-reviewer disagreement: opus approve + codex reject → awaiting_tiebreaker + telemetry', () => {
    seedRun(makeRun('awaiting_dual_reviewer', {
      runMode: 'complex',
      useDualReviewer: true,
      runRedTeam: true,
      effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6 },
    }));
    const captured: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));

    // First verdict — opus approves; reducer holds in awaiting_dual_reviewer.
    usePipelineStore.getState().dispatch(RUN_ID, {
      type: 'reviewer_done',
      verdict: verdict('opus', 'approve'),
    });
    expect(usePipelineStore.getState().runs[RUN_ID].state).toBe('awaiting_dual_reviewer');

    // Second verdict — codex rejects → disagreement → awaiting_tiebreaker.
    usePipelineStore.getState().dispatch(RUN_ID, {
      type: 'reviewer_done',
      verdict: verdict('codex', 'reject'),
    });

    const run = usePipelineStore.getState().runs[RUN_ID];
    expect(run.state).toBe('awaiting_tiebreaker');
    // No counter bump on disagreement — tiebreaker decides.
    expect(run.retryCounters.reviewerReject).toBe(0);

    const disagree = captured.find(e => e.event === 'dual_reviewer_disagreement');
    expect(disagree).toBeDefined();
    expect(disagree).toMatchObject({
      event: 'dual_reviewer_disagreement',
      runId: RUN_ID,
      projectId: PROJECT_ID,
      opusVerdict: 'approve',
      codexVerdict: 'reject',
    });
  });

  // 5. Tiebreaker dispatcher fires the third (gemini) provider when the run
  //    enters awaiting_tiebreaker, AND emits `tiebreaker_invoked` telemetry.
  //
  //    Note: production wires `startDualReviewerDispatcher` into the
  //    lifecycle emitter at App boot, but pipelineStore only exposes one
  //    lifecycle emitter slot at a time and the smoke run doesn't boot
  //    the App. We register `handleDualReviewerLifecycle` directly via
  //    `setPipelineLifecycleEmitter` — the same call path
  //    `startDualReviewerDispatcher` makes internally — so the dispatcher
  //    sees real lifecycle events as the reducer transitions the run.
  it('tiebreaker dispatcher: fires gemini provider on awaiting_tiebreaker + telemetry', () => {
    seedRun(makeRun('awaiting_dual_reviewer', {
      runMode: 'complex',
      useDualReviewer: true,
      runRedTeam: true,
      effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6 },
    }));

    const fire = vi.fn<(input: RunOneShotReviewerInput) => Promise<void>>()
      .mockResolvedValue(undefined);
    const deps: DualReviewerDeps = { runOneShotReviewer: fire };
    setPipelineLifecycleEmitter((ev) => handleDualReviewerLifecycle(ev, deps));

    const captured: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));

    // Drive a disagreement to flip the run into awaiting_tiebreaker.
    usePipelineStore.getState().dispatch(RUN_ID, {
      type: 'reviewer_done',
      verdict: verdict('opus', 'approve'),
    });
    usePipelineStore.getState().dispatch(RUN_ID, {
      type: 'reviewer_done',
      verdict: verdict('codex', 'reject'),
    });

    expect(usePipelineStore.getState().runs[RUN_ID].state).toBe('awaiting_tiebreaker');

    // Dispatcher invoked the third reviewer with the gemini provider.
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith({
      runId: RUN_ID,
      role: 'reviewer',
      provider: TIEBREAKER_PROVIDER,
    });

    const tb = captured.find(e => e.event === 'tiebreaker_invoked');
    expect(tb).toBeDefined();
    expect(tb).toMatchObject({
      event: 'tiebreaker_invoked',
      runId: RUN_ID,
      projectId: PROJECT_ID,
      provider: 'gemini',
    });
  });

  // 6. Tiebreaker approve on a complex (runRedTeam=true) run routes through
  //    awaiting_red_team — the post-reviewer-approval routing helper detects
  //    runRedTeam and inserts the red-team gate before merge approval.
  it('tiebreaker approve on complex run → awaiting_red_team (not awaiting_merge_approval)', () => {
    seedRun(makeRun('awaiting_tiebreaker', {
      runMode: 'complex',
      useDualReviewer: true,
      runRedTeam: true,
      effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6 },
      // Pre-existing dual verdicts (opus approve, codex reject) for realism.
      artifacts: {
        builds: [],
        reviews: [verdict('opus', 'approve'), verdict('codex', 'reject')],
        ciResults: [],
        questions: [],
        redTeamReports: [],
      },
    }));

    usePipelineStore.getState().dispatch(RUN_ID, {
      type: 'reviewer_done',
      verdict: verdict('merged', 'approve'),
    });

    expect(usePipelineStore.getState().runs[RUN_ID].state).toBe('awaiting_red_team');
  });

  // 7. Red-team blocker → run fails with failureClass='red_team_blocker'.
  //    Per-finding telemetry fires BEFORE the dispatch (so events describe
  //    findings even when the run routes to failed).
  it('red-team blocker finding: run fails with red_team_blocker class + per-finding telemetry', async () => {
    seedRun(makeRun('awaiting_red_team', {
      runMode: 'complex',
      useDualReviewer: true,
      runRedTeam: true,
      effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6 },
    }));
    const captured: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));

    const findings: RedTeamFinding[] = [
      {
        severity: 'blocker',
        category: 'secret-exposure',
        description: 'API key committed to source',
        file: 'src/cfg.ts',
        line: 42,
      },
      {
        severity: 'concern',
        category: 'race-condition',
        description: 'Read-modify-write without lock',
      },
    ];
    const report: RedTeamReport = {
      stage: 'red-team',
      findings,
      summary: '1 blocker, 1 concern',
      confidence: 'verified',
    };

    ingestPtyChunk({
      runId: RUN_ID,
      role: 'red-team',
      chunk: `<<<TX_REDTEAM_DONE>>>${JSON.stringify(report)}\n`,
    });
    await flushMicrotasks();

    const run = usePipelineStore.getState().runs[RUN_ID];
    expect(run.state).toBe('failed');
    expect(run.failureClass).toBe('red_team_blocker');
    expect(run.artifacts.redTeamReports).toHaveLength(1);

    // One telemetry event per finding (regardless of severity).
    const findingEvents = captured.filter(e => e.event === 'red_team_finding');
    expect(findingEvents).toHaveLength(2);
    expect(findingEvents.map(e => (e as { severity: string }).severity).sort())
      .toEqual(['blocker', 'concern']);
    expect(findingEvents[0]).toMatchObject({
      event: 'red_team_finding',
      runId: RUN_ID,
      projectId: PROJECT_ID,
      severity: 'blocker',
      category: 'secret-exposure',
      file: 'src/cfg.ts',
      line: 42,
    });
  });

  // 8. Red-team with concerns only → awaiting_merge_approval; concerns
  //    surface in artifacts.redTeamReports for the merger modal.
  it('red-team concerns only → awaiting_merge_approval + concerns in artifacts', async () => {
    seedRun(makeRun('awaiting_red_team', {
      runMode: 'complex',
      useDualReviewer: true,
      runRedTeam: true,
      effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6 },
    }));

    const findings: RedTeamFinding[] = [
      {
        severity: 'concern',
        category: 'edge-case',
        description: 'Possible null deref on empty input',
      },
      {
        severity: 'nit',
        category: 'other',
        description: 'Comment typo',
      },
    ];
    const report: RedTeamReport = {
      stage: 'red-team',
      findings,
      summary: '0 blockers, 1 concern, 1 nit',
      confidence: 'likely',
    };

    ingestPtyChunk({
      runId: RUN_ID,
      role: 'red-team',
      chunk: `<<<TX_REDTEAM_DONE>>>${JSON.stringify(report)}\n`,
    });
    await flushMicrotasks();

    const run = usePipelineStore.getState().runs[RUN_ID];
    expect(run.state).toBe('awaiting_merge_approval');
    expect(run.failureClass).toBeUndefined();
    expect(run.artifacts.redTeamReports).toHaveLength(1);
    expect(run.artifacts.redTeamReports[0].findings).toHaveLength(2);
    // Findings preserved verbatim for the merger modal to render.
    expect(run.artifacts.redTeamReports[0].findings[0].severity).toBe('concern');
    expect(run.artifacts.redTeamReports[0].findings[1].severity).toBe('nit');
  });
});
