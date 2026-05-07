import type {
  PipelineRun,
  PipelineState,
  PlanArtifact,
  BuildArtifact,
  ReviewVerdict,
  CIResult,
  QuestionArtifact,
  RunFingerprint,
} from '@/types';

const REVIEWER_REJECT_BUDGET = 3;
const CI_FAIL_BUDGET = 3;

export const TERMINAL_STATES: ReadonlySet<PipelineState> = new Set(['done', 'failed', 'escalated']);

/**
 * Active in-flight stages — used to gate `question_raised` (only fires from an
 * active stage) and to validate the `priorActiveState` we resume into when a
 * `clarification_received` event lands.
 */
export const ACTIVE_STAGES: ReadonlySet<PipelineState> = new Set([
  'planning',
  'building',
  'reviewing',
  'merging',
]);

export function isTerminalState(state: PipelineState): boolean {
  return TERMINAL_STATES.has(state);
}

export type PipelineEvent =
  | { type: 'start' }
  | { type: 'planner_done'; plan: PlanArtifact }
  | { type: 'planner_failed'; reason: string }
  | { type: 'approve_plan' }
  | { type: 'builder_done'; build: BuildArtifact }
  | { type: 'reviewer_done'; verdict: ReviewVerdict }
  | { type: 'ci_fail'; result: CIResult }
  | { type: 'ci_pass'; result: CIResult }
  | { type: 'question_raised'; question: QuestionArtifact }
  | { type: 'clarification_received'; answer?: string }
  | { type: 'approve_merge' }
  | { type: 'reject_merge' }
  | { type: 'merge_done' }
  | { type: 'merge_failed'; reason: string }
  | { type: 'replan_requested'; reason: string }
  | { type: 'heartbeat' }
  | { type: 'abort'; reason: string };

export interface InitialRunInputs {
  runId: string;
  templateId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  /**
   * The fork point the run merges back into. Defaults to `'main'` when not
   * provided so existing call sites stay green; production callers should
   * resolve this from preflight (`PreflightResult.main_branch`) before
   * passing it in.
   */
  baseBranch?: string;
  fingerprint: RunFingerprint;
}

export function initialRunState(input: InitialRunInputs): PipelineRun {
  return {
    id: input.runId,
    templateId: input.templateId,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseBranch: input.baseBranch ?? 'main',
    state: 'idle',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: Date.now(),
    escalationLog: [],
    tiles: {},
    fingerprint: input.fingerprint,
    planLineage: [],
  };
}

export function reducer(run: PipelineRun, ev: PipelineEvent): PipelineRun {
  if (ev.type === 'abort') {
    if (TERMINAL_STATES.has(run.state)) return run;
    return { ...run, state: 'failed', failureReason: ev.reason, failureClass: 'unknown', endedAt: Date.now() };
  }
  // Terminal-state carve-out: `replan_requested` is the ONLY event that may
  // re-enter the run from `escalated`. Every other event hitting a terminal
  // state is a no-op (idempotency / late-arriving sentinels). The actual
  // state-specific gating for replan_requested lives in its case below.
  if (TERMINAL_STATES.has(run.state) && ev.type !== 'replan_requested') return run;

  switch (ev.type) {
    case 'start':
      if (run.state === 'idle') return { ...run, state: 'planning' };
      return run;

    case 'planner_done':
      return {
        ...run,
        state: 'awaiting_plan_approval',
        artifacts: { ...run.artifacts, plan: ev.plan },
        planLineage: [...run.planLineage, ev.plan.planCommitSha],
      };

    case 'planner_failed':
      return { ...run, state: 'failed', failureReason: ev.reason, failureClass: 'planner_refused', endedAt: Date.now() };

    case 'approve_plan':
      if (run.state === 'awaiting_plan_approval') return { ...run, state: 'building' };
      return run;

    case 'builder_done':
      if (run.state !== 'building') return run;
      return {
        ...run,
        state: 'reviewing',
        artifacts: { ...run.artifacts, builds: [...run.artifacts.builds, ev.build] },
      };

    case 'reviewer_done': {
      if (run.state !== 'reviewing') return run;
      const reviews = [...run.artifacts.reviews, ev.verdict];
      if (ev.verdict.verdict === 'approve') {
        return {
          ...run,
          state: 'awaiting_merge_approval',
          artifacts: { ...run.artifacts, reviews },
        };
      }
      const next = run.retryCounters.reviewerReject + 1;
      if (next > REVIEWER_REJECT_BUDGET) {
        return {
          ...run,
          state: 'escalated',
          retryCounters: { ...run.retryCounters, reviewerReject: next },
          artifacts: { ...run.artifacts, reviews },
          failureClass: 'reviewer_irreconcilable',
          endedAt: Date.now(),
        };
      }
      return {
        ...run,
        state: 'building',
        retryCounters: { ...run.retryCounters, reviewerReject: next },
        artifacts: { ...run.artifacts, reviews },
      };
    }

    case 'ci_pass':
      return {
        ...run,
        artifacts: { ...run.artifacts, ciResults: [...run.artifacts.ciResults, ev.result] },
      };

    case 'ci_fail': {
      const next = run.retryCounters.ciFail + 1;
      const ciResults = [...run.artifacts.ciResults, ev.result];
      if (next > CI_FAIL_BUDGET) {
        return {
          ...run,
          state: 'escalated',
          retryCounters: { ...run.retryCounters, ciFail: next },
          artifacts: { ...run.artifacts, ciResults },
          failureClass: 'builder_loop',
          endedAt: Date.now(),
        };
      }
      return {
        ...run,
        state: 'building',
        retryCounters: { ...run.retryCounters, ciFail: next },
        artifacts: { ...run.artifacts, ciResults },
      };
    }

    case 'question_raised':
      if (!ACTIVE_STAGES.has(run.state)) return run;
      return {
        ...run,
        state: 'awaiting_clarification',
        // Remember which active stage we left so `clarification_received`
        // resumes to the same place without the caller telling us.
        priorActiveState: run.state,
        artifacts: { ...run.artifacts, questions: [...run.artifacts.questions, ev.question] },
      };

    case 'clarification_received': {
      // Only resume from awaiting_clarification.
      if (run.state !== 'awaiting_clarification') return run;
      const resumeTo = run.priorActiveState;
      // Defensive: priorActiveState should always be set when we're in
      // awaiting_clarification (only path in is `question_raised`, which sets
      // it). If it's missing or somehow not an active stage, fail the run
      // rather than silently lose work.
      if (!resumeTo || !ACTIVE_STAGES.has(resumeTo)) {
        return {
          ...run,
          state: 'failed',
          failureReason: 'clarification_received without prior active state',
          failureClass: 'unknown',
          endedAt: Date.now(),
          priorActiveState: undefined,
        };
      }
      return { ...run, state: resumeTo, priorActiveState: undefined };
    }

    case 'approve_merge':
      if (run.state === 'awaiting_merge_approval') return { ...run, state: 'merging' };
      return run;

    case 'reject_merge':
      if (run.state === 'awaiting_merge_approval') return { ...run, state: 'failed', failureReason: 'merge_rejected', failureClass: 'unknown', endedAt: Date.now() };
      return run;

    case 'merge_done':
      if (run.state !== 'merging') return run;
      return { ...run, state: 'done', endedAt: Date.now() };

    case 'merge_failed':
      if (run.state !== 'merging') return run;
      return { ...run, state: 'failed', failureReason: ev.reason, failureClass: 'unknown', endedAt: Date.now() };

    case 'heartbeat':
      // Terminal states already filtered above. Just stamp the wall clock —
      // the stuck-detector reads this to decide when a run has gone silent.
      return { ...run, lastHeartbeatAt: Date.now() };

    case 'replan_requested': {
      // Narrow re-entry: only `escalated` may be re-planned. From any other
      // state this is a no-op (we don't want a misclick mid-build to nuke
      // ongoing work, and we don't want to "re-plan" a successful done run).
      if (run.state !== 'escalated') return run;
      return {
        ...run,
        state: 'planning',
        // Clear endedAt so the run is "live" again; failureReason/Class stay
        // for audit. The next planner_done will append a fresh SHA to
        // planLineage so v2 plan files don't collide with v1.
        endedAt: undefined,
        escalationLog: [
          ...run.escalationLog,
          { at: Date.now(), reason: ev.reason, decision: 'replan' },
        ],
      };
    }

    default: {
      // Compile-time exhaustiveness: adding a PipelineEvent variant without
      // handling it here will trigger a TS error that points at this line.
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}
