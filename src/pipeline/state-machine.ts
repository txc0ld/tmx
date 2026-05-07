import type {
  PipelineRun,
  PipelineState,
  PlanArtifact,
  BuildArtifact,
  ReviewVerdict,
  CIResult,
  QuestionArtifact,
  RedTeamReport,
  RunFingerprint,
} from '@/types';

/**
 * Default per-run retry budgets when no template-derived values are passed
 * to `initialRunState`. These match the legacy hardcoded constants so
 * existing call sites that don't yet thread template config through stay
 * green. Per-run effective budgets live on `PipelineRun.effectiveRetryBudgets`
 * and are scaled by the complexity gate at `planner_done` (see `scaleBudgets`).
 */
export const DEFAULT_RETRY_BUDGETS = { reviewerReject: 3, ciFail: 3 } as const;

/**
 * Complexity scaling for retry budgets:
 *  - trivial: halved (min 1) — small changes shouldn't loop forever
 *  - standard: unchanged
 *  - complex: doubled — architectural work earns more retries
 */
function scaleBudgets(
  base: { reviewerReject: number; ciFail: number },
  mode: 'trivial' | 'standard' | 'complex',
): { reviewerReject: number; ciFail: number } {
  switch (mode) {
    case 'trivial':
      return {
        reviewerReject: Math.max(1, Math.floor(base.reviewerReject / 2)),
        ciFail: Math.max(1, Math.floor(base.ciFail / 2)),
      };
    case 'complex':
      return {
        reviewerReject: base.reviewerReject * 2,
        ciFail: base.ciFail * 2,
      };
    case 'standard':
    default:
      return { ...base };
  }
}

export const TERMINAL_STATES: ReadonlySet<PipelineState> = new Set(['done', 'failed', 'escalated']);

/**
 * Phase 3c.6: when a reviewer-approve transition fires (single, dual-both,
 * or tiebreaker), the run normally heads to `awaiting_merge_approval`.
 * For `complex`-complexity runs the complexity gate stamped
 * `runRedTeam = true`; in that case we route through `awaiting_red_team`
 * first so the red-team one-shot has a chance to surface findings.
 *
 * Concerns surface in `artifacts.redTeamReports` for the merger modal but
 * don't block; blockers transition the run to `failed` with
 * `failureClass: 'red_team_blocker'`. See `red_team_done` reducer case.
 */
function postReviewerApprovalState(run: PipelineRun): PipelineState {
  return run.runRedTeam ? 'awaiting_red_team' : 'awaiting_merge_approval';
}

/**
 * Active in-flight stages — used to validate the `priorActiveState` we resume
 * into when a `clarification_received` event lands (and historically to gate
 * `question_raised`, but see `QUESTIONABLE_STATES` for the broader set that
 * Phase 3c.3 unlocked).
 */
export const ACTIVE_STAGES: ReadonlySet<PipelineState> = new Set([
  'planning',
  'building',
  'reviewing',
  'awaiting_dual_reviewer',
  'awaiting_tiebreaker',
  'awaiting_red_team',
  'merging',
]);

/**
 * States from which `question_raised` may fire. Phase 3c.3 added the
 * post-stage holding states (`awaiting_plan_approval` /
 * `awaiting_merge_approval`) so the controller can synthesize an
 * uncertainty-driven question AFTER the role's normal transition. The
 * resume target (`priorActiveState`) gets validated against this same set,
 * so we can correctly land back on a holding state when the user
 * acknowledges the question — at which point their natural next action
 * (approve_plan / approve_merge) advances the run forward, instead of
 * looping back into a stage that already finished its work.
 */
export const QUESTIONABLE_STATES: ReadonlySet<PipelineState> = new Set([
  'planning',
  'building',
  'reviewing',
  'awaiting_dual_reviewer',
  'awaiting_tiebreaker',
  'awaiting_red_team',
  'merging',
  'awaiting_plan_approval',
  'awaiting_merge_approval',
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
  | { type: 'red_team_done'; report: RedTeamReport }
  | { type: 'red_team_failed'; reason: string }
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
  /**
   * Template-derived defaults for the complexity-gate routing fields.
   * Optional so test fixtures + legacy callers stay green. When omitted,
   * `initialRunState` falls back to `DEFAULT_RETRY_BUDGETS` and
   * `templateDualReviewer = false`. The reducer's `planner_done` case
   * re-stamps these with complexity-scaled values once the planner reports.
   */
  templateRetryBudget?: { reviewerReject: number; ciFail: number };
  templateDualReviewer?: boolean;
}

export function initialRunState(input: InitialRunInputs): PipelineRun {
  const baseBudgets = input.templateRetryBudget ?? DEFAULT_RETRY_BUDGETS;
  const templateDualReviewer = input.templateDualReviewer ?? false;
  return {
    id: input.runId,
    templateId: input.templateId,
    projectId: input.projectId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseBranch: input.baseBranch ?? 'main',
    state: 'idle',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: Date.now(),
    escalationLog: [],
    tiles: {},
    fingerprint: input.fingerprint,
    planLineage: [],
    runMode: 'standard',
    autoApprovePlan: false,
    useDualReviewer: templateDualReviewer,
    runRedTeam: false,
    effectiveRetryBudgets: { ...baseBudgets },
    templateRetryBudget: { ...baseBudgets },
    templateDualReviewer,
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

    case 'planner_done': {
      // Complexity gate (Phase 3c.1): the planner self-classifies each plan
      // as trivial/standard/complex via `plan.complexity`. We re-stamp the
      // run-level routing fields here so subsequent transitions read the
      // correct budgets and post-build flags. Missing field → 'standard'
      // (the safe default).
      //
      // Re-stamping uses the immutable `templateRetryBudget` /
      // `templateDualReviewer` baselines captured at run creation, so a
      // replan from complex→trivial correctly halves the *standard*
      // template baseline, not the prior complex-doubled value. This
      // honors the addendum §A4 "re-plans are full resets" rule.
      //
      // For 'trivial' we *skip* awaiting_plan_approval and transition
      // straight to 'building'. This deliberately bypasses the human
      // confirm gate — the trade-off is faster turnaround on small,
      // unambiguous changes (typos, dep bumps, doc updates) at the cost
      // of forfeiting the operator's chance to redirect the plan. The
      // planner role-prompt sets honest expectations about what counts
      // as trivial; understating complexity for a security-sensitive fix
      // would skip not just this gate but also the dual-reviewer + red-team
      // safety nets, so the calibration matters. `autoApprovePlan` stays
      // true on the run as an audit trail.
      //
      // For 'complex' we stamp dual-reviewer + red-team flags (consumed
      // by 3c.4 + 3c.6 respectively).
      const mode: 'trivial' | 'standard' | 'complex' = ev.plan.complexity ?? 'standard';
      const effectiveRetryBudgets = scaleBudgets(run.templateRetryBudget, mode);
      const autoApprovePlan = mode === 'trivial';
      const useDualReviewer = mode === 'complex' || run.templateDualReviewer;
      const runRedTeam = mode === 'complex';
      const nextState: PipelineState = autoApprovePlan ? 'building' : 'awaiting_plan_approval';
      return {
        ...run,
        state: nextState,
        artifacts: { ...run.artifacts, plan: ev.plan },
        planLineage: [...run.planLineage, ev.plan.planCommitSha],
        runMode: mode,
        autoApprovePlan,
        useDualReviewer,
        runRedTeam,
        effectiveRetryBudgets,
      };
    }

    case 'planner_failed':
      return { ...run, state: 'failed', failureReason: ev.reason, failureClass: 'planner_refused', endedAt: Date.now() };

    case 'approve_plan':
      if (run.state === 'awaiting_plan_approval') return { ...run, state: 'building' };
      return run;

    case 'builder_done':
      if (run.state !== 'building') return run;
      return {
        ...run,
        // Phase 3c.4: dual-reviewer runs fan out to BOTH `reviewer` (Opus)
        // and `reviewer-codex` after each build. The reducer routes through
        // `awaiting_dual_reviewer` so the controller's lifecycle dispatcher
        // can spawn the second one-shot. Single-reviewer flow (default) keeps
        // the legacy `reviewing` transition.
        state: run.useDualReviewer ? 'awaiting_dual_reviewer' : 'reviewing',
        artifacts: { ...run.artifacts, builds: [...run.artifacts.builds, ev.build] },
      };

    case 'reviewer_done': {
      // Single-reviewer flow (legacy / non-dual templates / non-complex runs).
      if (run.state === 'reviewing') {
        const reviews = [...run.artifacts.reviews, ev.verdict];
        if (ev.verdict.verdict === 'approve') {
          return {
            ...run,
            state: postReviewerApprovalState(run),
            artifacts: { ...run.artifacts, reviews },
          };
        }
        const next = run.retryCounters.reviewerReject + 1;
        if (next > run.effectiveRetryBudgets.reviewerReject) {
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

      // Phase 3c.4: dual-reviewer flow.
      //
      // Both `reviewer` (Opus) + `reviewer-codex` are in flight after
      // `builder_done`. We hold in `awaiting_dual_reviewer` until BOTH
      // verdicts have arrived, then reconcile:
      //   - Both approve → awaiting_merge_approval (synthesize a 'merged'
      //     verdict that records both source reviewers' confidence).
      //   - Both reject → building (counter increments; budget-respecting).
      //   - Disagree → awaiting_tiebreaker, NO counter increment yet — the
      //     third (gemini) provider's vote breaks the tie.
      //
      // Late/duplicate verdicts from the same reviewer are appended to the
      // artifacts list but don't double-count for reconciliation; we match
      // by `reviewer` key (opus / codex) on every reconciliation pass.
      if (run.state === 'awaiting_dual_reviewer') {
        const reviews = [...run.artifacts.reviews, ev.verdict];
        // Pull the most-recent verdict from each reviewer this round (search
        // backwards so a defensive duplicate sentinel from the same reviewer
        // doesn't shadow the other one's verdict).
        let opusVerdict: ReviewVerdict | undefined;
        let codexVerdict: ReviewVerdict | undefined;
        for (let i = reviews.length - 1; i >= 0; i--) {
          const r = reviews[i];
          if (!opusVerdict && r.reviewer === 'opus') opusVerdict = r;
          else if (!codexVerdict && r.reviewer === 'codex') codexVerdict = r;
          if (opusVerdict && codexVerdict) break;
        }
        if (!opusVerdict || !codexVerdict) {
          // First of two — keep waiting. State unchanged but artifacts grow.
          return { ...run, artifacts: { ...run.artifacts, reviews } };
        }
        // Reconcile.
        if (opusVerdict.verdict === 'approve' && codexVerdict.verdict === 'approve') {
          return {
            ...run,
            state: postReviewerApprovalState(run),
            artifacts: { ...run.artifacts, reviews },
          };
        }
        if (opusVerdict.verdict === 'reject' && codexVerdict.verdict === 'reject') {
          const next = run.retryCounters.reviewerReject + 1;
          if (next > run.effectiveRetryBudgets.reviewerReject) {
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
        // Disagreement — third reviewer breaks the tie. NO counter bump:
        // we don't penalize the builder for one rejection that's contested
        // by the other reviewer. The tiebreaker's verdict decides whether
        // the round counts as a rejection.
        return {
          ...run,
          state: 'awaiting_tiebreaker',
          artifacts: { ...run.artifacts, reviews },
        };
      }

      // Tiebreaker round — the third provider's verdict is decisive.
      if (run.state === 'awaiting_tiebreaker') {
        const reviews = [...run.artifacts.reviews, ev.verdict];
        if (ev.verdict.verdict === 'approve') {
          return {
            ...run,
            state: postReviewerApprovalState(run),
            artifacts: { ...run.artifacts, reviews },
          };
        }
        // Tiebreaker rejected — NOW the round counts as a rejection.
        const next = run.retryCounters.reviewerReject + 1;
        if (next > run.effectiveRetryBudgets.reviewerReject) {
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

      return run;
    }

    case 'ci_pass':
      return {
        ...run,
        artifacts: { ...run.artifacts, ciResults: [...run.artifacts.ciResults, ev.result] },
      };

    case 'ci_fail': {
      const next = run.retryCounters.ciFail + 1;
      const ciResults = [...run.artifacts.ciResults, ev.result];
      if (next > run.effectiveRetryBudgets.ciFail) {
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
      // Phase 3c.3: questions may fire from active stages OR the post-stage
      // holding states (awaiting_plan_approval / awaiting_merge_approval) so
      // synthetic uncertainty escalations can land after the role's normal
      // transition. See QUESTIONABLE_STATES.
      if (!QUESTIONABLE_STATES.has(run.state)) return run;
      return {
        ...run,
        state: 'awaiting_clarification',
        // Remember which stage we left so `clarification_received`
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
      // it). If it's missing or not a valid resume target, fail the run
      // rather than silently lose work. Resume targets match the same
      // QUESTIONABLE_STATES set the question_raised path validated against.
      if (!resumeTo || !QUESTIONABLE_STATES.has(resumeTo)) {
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

    case 'red_team_done': {
      // Phase 3c.6: red-team completion. Only valid from `awaiting_red_team`;
      // late/duplicate sentinels in any other state are no-ops (the run has
      // already moved on, e.g. user already approved the merge).
      //
      // Routing:
      //   - 0 blockers → awaiting_merge_approval (concerns persist in
      //     artifacts.redTeamReports for the merger modal to render).
      //   - ≥1 blocker → failed with failureClass='red_team_blocker'.
      //
      // We use `failed` (not `escalated`) because the red-team finding a
      // blocker is a non-recoverable signal — the diff has a flaw the
      // Reviewer missed AND the system is calibrated to halt rather than
      // re-loop. The user can `replan_requested` from `escalated`, not
      // `failed`. If a future iteration wants red-team blockers to feed
      // back into `building`, that's a behavioral change — capture it in
      // a follow-up plan.
      if (run.state !== 'awaiting_red_team') return run;
      const redTeamReports = [...run.artifacts.redTeamReports, ev.report];
      const hasBlocker = ev.report.findings.some(f => f.severity === 'blocker');
      if (hasBlocker) {
        return {
          ...run,
          state: 'failed',
          failureReason: `red-team found ${ev.report.findings.filter(f => f.severity === 'blocker').length} blocker(s)`,
          failureClass: 'red_team_blocker',
          artifacts: { ...run.artifacts, redTeamReports },
          endedAt: Date.now(),
        };
      }
      return {
        ...run,
        state: 'awaiting_merge_approval',
        artifacts: { ...run.artifacts, redTeamReports },
      };
    }

    case 'red_team_failed': {
      // The red-team role refusal-protocoled (TX_REDTEAM_FAILED). Like
      // builder/reviewer abort: the run can't safely advance to merge
      // because the red-team didn't get a chance to look. Halt with the
      // role's reason; user can replan if they want to try again under
      // different conditions.
      if (run.state !== 'awaiting_red_team') return run;
      return {
        ...run,
        state: 'failed',
        failureReason: ev.reason,
        failureClass: 'red_team_blocker',
        endedAt: Date.now(),
      };
    }

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
