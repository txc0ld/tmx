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

/** Active in-flight stages — used for `clarification_received.resumeTo` and `question_raised` gating. */
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
  | { type: 'clarification_received'; resumeTo: PipelineState }
  | { type: 'approve_merge' }
  | { type: 'reject_merge' }
  | { type: 'merge_done' }
  | { type: 'merge_failed'; reason: string }
  | { type: 'abort'; reason: string };

export interface InitialRunInputs {
  runId: string;
  templateId: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  fingerprint: RunFingerprint;
}

export function initialRunState(input: InitialRunInputs): PipelineRun {
  return {
    id: input.runId,
    templateId: input.templateId,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    state: 'idle',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: Date.now(),
    escalationLog: [],
    tiles: {},
    fingerprint: input.fingerprint,
  };
}

export function reducer(run: PipelineRun, ev: PipelineEvent): PipelineRun {
  if (ev.type === 'abort') {
    if (TERMINAL_STATES.has(run.state)) return run;
    return { ...run, state: 'failed', failureReason: ev.reason, failureClass: 'unknown', endedAt: Date.now() };
  }
  if (TERMINAL_STATES.has(run.state)) return run;

  switch (ev.type) {
    case 'start':
      if (run.state === 'idle') return { ...run, state: 'planning' };
      return run;

    case 'planner_done':
      return {
        ...run,
        state: 'awaiting_plan_approval',
        artifacts: { ...run.artifacts, plan: ev.plan },
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
        artifacts: { ...run.artifacts, questions: [...run.artifacts.questions, ev.question] },
      };

    case 'clarification_received':
      // Only resume from awaiting_clarification, and only into an active
      // stage. Resuming to a terminal/awaiting state would silently end or
      // corrupt the run.
      if (run.state !== 'awaiting_clarification') return run;
      if (!ACTIVE_STAGES.has(ev.resumeTo)) return run;
      return { ...run, state: ev.resumeTo };

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

    default: {
      // Compile-time exhaustiveness: adding a PipelineEvent variant without
      // handling it here will trigger a TS error that points at this line.
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}
