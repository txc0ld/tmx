import { create } from 'zustand';
import type { PipelineRole, PipelineRun } from '@/types';
import {
  reducer,
  initialRunState,
  isTerminalState,
  type PipelineEvent,
  type InitialRunInputs,
} from '@/pipeline/state-machine';

/**
 * Telemetry emitter — registered at app boot via `setPipelineTelemetryEmitter`
 * so this module stays free of IPC concerns. Tests leave it unset (no-op).
 *
 * `TelemetryEvent` is a discriminated union over `event`. The Rust IPC
 * (`pipeline_telemetry_log`) writes `JSON.stringify(ev)` as one JSONL line and
 * is agnostic to the exact shape — every variant carries `runId` + `projectId`
 * which is all App.tsx's wiring needs.
 */
export interface StateChangeTelemetryEvent {
  at: number;
  event: 'state_change';
  runId: string;
  projectId: string;
  from: string;
  to: string;
  trigger: string;
}

/** Capability/guardrails install/uninstall outcome. (Phase 2c-ii.7) */
export interface LifecycleTelemetryEvent {
  at: number;
  event:
    | 'capability_install'
    | 'capability_uninstall'
    | 'guardrails_install'
    | 'guardrails_uninstall';
  runId: string;
  projectId: string;
  /**
   * Role on capability events; undefined on guardrails (worktree-wide).
   * Typed as `PipelineRole` for ergonomics — `controller` never reaches the
   * capability install/uninstall path (filtered by `activeRoleForState`).
   */
  role?: PipelineRole;
  /** True when the IPC call succeeded; false on failure. */
  ok: boolean;
  /** Optional failure detail (truncated to ~500 chars). */
  error?: string;
}

/** Clarification answered by the user via ClarificationModal. (Phase 2c-iii.1) */
export interface ClarificationTelemetryEvent {
  at: number;
  event: 'clarification_answered';
  runId: string;
  projectId: string;
  /** The role/stage that asked the question (planner|builder|reviewer|...). */
  stage: PipelineRole;
}

/** Merger invocation outcome. (Phase 2c-ii.7) */
export interface MergerTelemetryEvent {
  at: number;
  event: 'merger_invoked' | 'merger_completed';
  runId: string;
  projectId: string;
  /** On merger_completed: the result.status field. */
  status?: 'success' | 'failure' | 'invalid_token';
  /** On merger_completed: the result.mode field. */
  mode?: 'pr' | 'local' | 'unknown';
  /** Optional detail when not success (truncated to ~500 chars). */
  detail?: string;
}

/**
 * Sub-agent invocation boundary. (Polish.2 — closes Phase 3b.8 deferral.)
 *
 * Fired when the controller parses `<<<TX_SUBAGENT_INVOKED>>>` — the
 * parent role (Builder) emits this BEFORE calling `agent_run_oneshot`
 * for a sub-agent, so the controller observes the invocation boundary.
 * Pairs with `subagent_completed` for latency tracking via
 * `(invoked.at, completed.at)`.
 */
export interface SubagentInvokedTelemetryEvent {
  at: number;
  event: 'subagent_invoked';
  runId: string;
  projectId: string;
  /** Role that emitted the sentinel — `'builder'` for now; future-proofed. */
  parentRole: PipelineRole;
  /** PlanTask.id from the brief, when delegating per a specific task. */
  taskId?: string;
  /** ≤120-char one-liner from the brief, for telemetry/audit. */
  briefSummary?: string;
  /** Number of file globs in the sub-agent's working_files allowlist. */
  workingFilesCount: number;
}

/**
 * Sub-agent completion outcome. (Phase 3b.8)
 *
 * Fired when the controller parses `<<<TX_SUBAGENT_DONE>>>` or
 * `<<<TX_SUBAGENT_FAILED>>>` from the parent role's PTY. Pairs with
 * `subagent_invoked` (above) for latency tracking.
 */
export interface SubagentCompletedTelemetryEvent {
  at: number;
  event: 'subagent_completed';
  runId: string;
  projectId: string;
  /** Role that emitted the sentinel — `'builder'` for now; future-proofed. */
  parentRole: PipelineRole;
  status: 'done' | 'failed';
  /** On status: 'done' — count of files the sub-agent reported editing. */
  filesEditedCount?: number;
  /** On status: 'done' — count of commits the sub-agent reported creating. */
  commitsCreatedCount?: number;
  /** On status: 'done' — short summary string from the sentinel payload. */
  summary?: string;
  /** On status: 'failed' — failure reason from the sentinel payload. */
  reason?: string;
}

/**
 * Compaction prompt fired by the controller. (Phase 3b.8)
 *
 * Emitted when `compaction-watcher.notifyBuilderBytes` writes the
 * compaction prompt to the Builder PTY (cumulative bytes since last
 * sentinel ≥ `COMPACTION_THRESHOLD_BYTES`).
 */
export interface CompactionTriggeredTelemetryEvent {
  at: number;
  event: 'compaction_triggered';
  runId: string;
  projectId: string;
  /** Cumulative Builder bytes since the last sentinel that tripped the threshold. */
  bytesAccumulated: number;
}

/**
 * Compaction summary received from Builder. (Phase 3b.8)
 *
 * Emitted when `handleCompactionDone` finishes appending the summary to
 * the scratchpad. Records the summary length so we can monitor whether
 * Builder is honoring the ≤500-token cap from the prompt.
 */
export interface CompactionCompletedTelemetryEvent {
  at: number;
  event: 'compaction_completed';
  runId: string;
  projectId: string;
  /** Character count of the summary appended to the scratchpad. */
  summaryLength: number;
}

/**
 * Trust telemetry — Phase 3c.7. Five variants surface the trust-related
 * decisions the run made so dashboards can aggregate them independently
 * of the noisier `state_change` stream.
 *
 * Emission sites:
 *  - `complexity_routed` — pipelineStore.dispatch wrapper, when a
 *    `planner_done` transition lands and the run was re-stamped with
 *    a complexity mode + routing flags (see state-machine.ts §planner_done).
 *  - `confidence_uncertain_escalated` — controller-runtime's
 *    `maybeEscalateUncertainty` after it dispatches the synthetic
 *    `question_raised`.
 *  - `dual_reviewer_disagreement` — pipelineStore.dispatch wrapper, on
 *    the `awaiting_dual_reviewer → awaiting_tiebreaker` transition pair.
 *  - `tiebreaker_invoked` — dual-reviewer-dispatcher when it spawns the
 *    third (gemini) reviewer on `awaiting_tiebreaker` entry.
 *  - `red_team_finding` — controller-runtime's `redteam_done` case, fired
 *    once per finding so dashboards can aggregate by severity / category
 *    without re-parsing the report. 0 findings → no events.
 */
export interface ComplexityRoutedTelemetryEvent {
  at: number;
  event: 'complexity_routed';
  runId: string;
  projectId: string;
  complexity: 'trivial' | 'standard' | 'complex';
  autoApprovePlan: boolean;
  useDualReviewer: boolean;
  runRedTeam: boolean;
}

export interface ConfidenceUncertainEscalatedTelemetryEvent {
  at: number;
  event: 'confidence_uncertain_escalated';
  runId: string;
  projectId: string;
  role: PipelineRole;
  /** Builder/Reviewer-derived metric; absent for Planner. */
  filesChanged?: number;
  /** Builder/Reviewer-derived metric; absent for Planner. */
  commits?: number;
  /** Planner-only — task count from the plan. */
  tasks?: number;
  uncertaintyDrivers?: string[];
}

export interface DualReviewerDisagreementTelemetryEvent {
  at: number;
  event: 'dual_reviewer_disagreement';
  runId: string;
  projectId: string;
  opusVerdict: 'approve' | 'reject';
  codexVerdict: 'approve' | 'reject';
}

export interface TiebreakerInvokedTelemetryEvent {
  at: number;
  event: 'tiebreaker_invoked';
  runId: string;
  projectId: string;
  /** Hardcoded `gemini` today; future-proofed for other tiebreaker providers. */
  provider: 'gemini' | 'opus' | 'codex';
}

export interface RedTeamFindingTelemetryEvent {
  at: number;
  event: 'red_team_finding';
  runId: string;
  projectId: string;
  severity: 'blocker' | 'concern' | 'nit';
  category:
    | 'supply-chain'
    | 'prompt-injection'
    | 'secret-exposure'
    | 'race-condition'
    | 'edge-case'
    | 'other';
  file?: string;
  line?: number;
}

/**
 * Polish.1: red-team dispatcher fired the one-shot for this run. Counter-
 * part to `red_team_finding` (which fires post-completion, once per
 * finding). Together they let dashboards distinguish "we tried to run
 * red-team" from "red-team produced findings" — useful when a run stalls
 * mid-red-team and we need to know whether the spawn itself succeeded.
 */
export interface RedTeamInvokedTelemetryEvent {
  at: number;
  event: 'red_team_invoked';
  runId: string;
  projectId: string;
  /** Hardcoded `opus` today; future-proofed for per-run provider overrides. */
  provider: 'opus' | 'codex' | 'gemini';
}

export type TelemetryEvent =
  | StateChangeTelemetryEvent
  | LifecycleTelemetryEvent
  | MergerTelemetryEvent
  | ClarificationTelemetryEvent
  | SubagentInvokedTelemetryEvent
  | SubagentCompletedTelemetryEvent
  | CompactionTriggeredTelemetryEvent
  | CompactionCompletedTelemetryEvent
  | ComplexityRoutedTelemetryEvent
  | ConfidenceUncertainEscalatedTelemetryEvent
  | DualReviewerDisagreementTelemetryEvent
  | TiebreakerInvokedTelemetryEvent
  | RedTeamFindingTelemetryEvent
  | RedTeamInvokedTelemetryEvent;

type TelemetryEmitter = (event: TelemetryEvent) => void;
const telemetryListeners: Set<TelemetryEmitter> = new Set();

/**
 * Register a telemetry listener; returns an unsubscribe fn. Multiple
 * listeners are supported — each is invoked on every emit, isolated with
 * try/catch so one throwing doesn't suppress the others.
 *
 * Back-compat: passing `null` clears every listener (matches the prior
 * single-slot semantic).
 */
export function setPipelineTelemetryEmitter(fn: TelemetryEmitter | null): (() => void) {
  if (fn === null) {
    telemetryListeners.clear();
    return () => {};
  }
  telemetryListeners.add(fn);
  return () => telemetryListeners.delete(fn);
}

/**
 * Emit a telemetry event from outside the store reducer. Used by the
 * lifecycle handlers (capabilities/guardrails) and the MergerConfirmModal
 * to record outcomes that aren't tied to a state-machine transition.
 *
 * Safe no-op when no listener is registered (e.g. vitest jsdom).
 */
export function emitTelemetry(event: TelemetryEvent): void {
  for (const fn of telemetryListeners) {
    try {
      fn(event);
    } catch (err) {
      console.warn('[pipeline] telemetry listener threw:', err);
    }
  }
}

/**
 * Lifecycle emitter — fires once per state transition. App.tsx wires it
 * to the guardrails install/uninstall IPCs (Phase 2c-ii.3) so the
 * worktree's `.claude/settings.json` PreToolUse hook list is maintained
 * for the active run window only. Tests leave it unset (no-op).
 *
 * Distinct from `TelemetryEmitter`: telemetry is fire-and-forget JSONL
 * persistence; lifecycle hooks may need to dedupe (multiple transitions
 * within `idle → planning → … → done` should install once, uninstall once)
 * and the consumer owns that bookkeeping.
 */
export interface LifecycleEvent {
  runId: string;
  projectId: string;
  worktreePath: string;
  from: string;
  to: string;
  trigger: string;
}
type LifecycleEmitter = (event: LifecycleEvent) => void;
const lifecycleListeners: Set<LifecycleEmitter> = new Set();

/**
 * Register a lifecycle listener; returns an unsubscribe fn. Multiple
 * listeners are supported — guardrails / capabilities / failure-bundle
 * each register independently. Each is invoked with try/catch isolation
 * so one throwing doesn't suppress the others.
 *
 * Back-compat: passing `null` clears every listener.
 */
export function setPipelineLifecycleEmitter(fn: LifecycleEmitter | null): (() => void) {
  if (fn === null) {
    lifecycleListeners.clear();
    return () => {};
  }
  lifecycleListeners.add(fn);
  return () => lifecycleListeners.delete(fn);
}

interface PipelineStoreShape {
  runs: Record<string, PipelineRun>;
  activeRunIds: string[];
  createRun(input: InitialRunInputs): string;
  dispatch(runId: string, ev: PipelineEvent): void;
  removeRun(runId: string): void;
}

function deriveActive(runs: Record<string, PipelineRun>): string[] {
  return Object.values(runs)
    .filter(r => !isTerminalState(r.state))
    .map(r => r.id);
}

/**
 * Cross-project indicator helper. Returns every run whose `projectId` matches
 * — including terminal ones — so the caller can decide what to show
 * (sidebar dot uses non-terminal + unviewed-failed; history panel uses all).
 *
 * Pure read; safe to call from `useSyncExternalStore`-style selectors as
 * long as the caller passes the same `runs` reference each time. UI sites
 * should prefer subscribing to `usePipelineStore(s => s.runs)` and filtering
 * inline so React re-renders track membership changes.
 */
export function getRunsForProject(
  runs: Record<string, PipelineRun>,
  projectId: string,
): PipelineRun[] {
  const out: PipelineRun[] = [];
  for (const r of Object.values(runs)) {
    if (r.projectId === projectId) out.push(r);
  }
  return out;
}

export const usePipelineStore = create<PipelineStoreShape>((set) => ({
  runs: {},
  activeRunIds: [],

  createRun: (input) => {
    const run = initialRunState(input);
    set(s => {
      if (s.runs[run.id]) return s;
      const runs = { ...s.runs, [run.id]: run };
      return { runs, activeRunIds: deriveActive(runs) };
    });
    return run.id;
  },

  dispatch: (runId, ev) => {
    let pendingTelemetry: StateChangeTelemetryEvent | null = null;
    let pendingLifecycle: LifecycleEvent | null = null;
    /**
     * Phase 3c.7: trust-telemetry events that are derived from the
     * (existing, next) pair and emitted *after* the state-change event
     * (so the JSONL stream's ordering remains causal — state_change
     * first, then any augmenting trust events). Keep this list small;
     * deeper analysis belongs in the role-specific modules
     * (controller-runtime, dual-reviewer-dispatcher).
     */
    const pendingTrust: TelemetryEvent[] = [];
    set(s => {
      const existing = s.runs[runId];
      if (!existing) return s;
      const next = reducer(existing, ev);
      if (next === existing) return s;

      if (existing.state !== next.state) {
        pendingTelemetry = {
          at: Date.now(),
          event: 'state_change',
          runId,
          projectId: existing.projectId,
          from: existing.state,
          to: next.state,
          trigger: ev.type,
        };
        pendingLifecycle = {
          runId,
          projectId: existing.projectId,
          worktreePath: existing.worktreePath,
          from: existing.state,
          to: next.state,
          trigger: ev.type,
        };

        // Phase 3c.7: dual-reviewer disagreement. Detect transition into
        // awaiting_tiebreaker — by construction the reducer only routes
        // there from awaiting_dual_reviewer when the two verdicts disagree.
        // We pull the verdicts from `next.artifacts.reviews` (most-recent
        // opus + codex) since the reducer just appended them.
        if (
          existing.state === 'awaiting_dual_reviewer' &&
          next.state === 'awaiting_tiebreaker'
        ) {
          const reviews = next.artifacts.reviews;
          let opusV: 'approve' | 'reject' | undefined;
          let codexV: 'approve' | 'reject' | undefined;
          for (let i = reviews.length - 1; i >= 0; i--) {
            const r = reviews[i];
            if (!opusV && r.reviewer === 'opus') opusV = r.verdict;
            else if (!codexV && r.reviewer === 'codex') codexV = r.verdict;
            if (opusV && codexV) break;
          }
          if (opusV && codexV) {
            pendingTrust.push({
              at: Date.now(),
              event: 'dual_reviewer_disagreement',
              runId,
              projectId: existing.projectId,
              opusVerdict: opusV,
              codexVerdict: codexV,
            });
          }
        }
      }

      // Phase 3c.7: complexity_routed fires on planner_done regardless of
      // whether the state changed — the reducer always re-stamps
      // runMode/autoApprovePlan/useDualReviewer/runRedTeam on planner_done,
      // and `next !== existing` is already guaranteed above (we early-
      // returned on no-op). Test-friendly: fires after the state-change
      // event is queued so dashboards see them in order.
      if (ev.type === 'planner_done') {
        pendingTrust.push({
          at: Date.now(),
          event: 'complexity_routed',
          runId,
          projectId: existing.projectId,
          complexity: next.runMode,
          autoApprovePlan: next.autoApprovePlan,
          useDualReviewer: next.useDualReviewer,
          runRedTeam: next.runRedTeam,
        });
      }

      // activeRunIds membership only changes when a run crosses the terminal
      // boundary; otherwise reuse the prior reference so subscribers selecting
      // `activeRunIds` don't re-render needlessly.
      const terminalBoundaryCrossed =
        isTerminalState(existing.state) !== isTerminalState(next.state);
      const runs = { ...s.runs, [runId]: next };
      const activeRunIds = terminalBoundaryCrossed ? deriveActive(runs) : s.activeRunIds;
      return { runs, activeRunIds };
    });

    if (pendingTelemetry) {
      for (const fn of telemetryListeners) {
        try { fn(pendingTelemetry); } catch (err) {
          console.warn('[pipeline] telemetry listener threw:', err);
        }
      }
    }
    for (const trustEv of pendingTrust) {
      for (const fn of telemetryListeners) {
        try { fn(trustEv); } catch (err) {
          console.warn('[pipeline] telemetry listener threw:', err);
        }
      }
    }
    if (pendingLifecycle) {
      for (const fn of lifecycleListeners) {
        try { fn(pendingLifecycle); } catch (err) {
          console.warn('[pipeline] lifecycle listener threw:', err);
        }
      }
    }
  },

  removeRun: (runId) => {
    set(s => {
      const { [runId]: _gone, ...rest } = s.runs;
      return { runs: rest, activeRunIds: deriveActive(rest) };
    });
  },
}));
