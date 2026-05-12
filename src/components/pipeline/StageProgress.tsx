import { useEffect, useState } from 'react';
import type { PipelineState } from '@/types';

/**
 * Tiny local hook — `true` when the user has expressed a preference AGAINST
 * motion via the OS-level reduced-motion setting. Defaults to `false` (we
 * animate) so SSR / test environments without `matchMedia` don't crash.
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    // Older Safari uses addListener; modern browsers use addEventListener.
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduced;
}

/**
 * Pure presentational stage progress indicator for PipelineControllerTile.
 *
 * Renders a thin row of stage pills (Plan → Build → Review[ + Red Team]
 * → Merge) with the current stage highlighted, past stages filled-muted,
 * future stages outline-only, and a terminal badge (Done / Failed /
 * Escalated) when the run has reached a terminal state.
 *
 * No state, no IPC. Parent gates `run === null` before rendering.
 */

type ActiveStageKey = 'plan' | 'build' | 'review' | 'red-team' | 'merge' | null;
type StageStatus = 'past' | 'active' | 'future' | 'failed';

type StageDef = {
  key: Exclude<ActiveStageKey, null>;
  label: string;
};

interface Props {
  state: PipelineState;
  runMode: 'trivial' | 'standard' | 'complex';
  /**
   * The active stage we left when entering `awaiting_clarification`. Required
   * to disambiguate which pill to highlight while waiting on a user answer —
   * a clarification can fire from planning, building, or reviewing.
   */
  priorActiveState?: PipelineState;
  /** True when `runMode === 'complex' || templateDualReviewer`. Adds "×2" subscript on Review pill. */
  useDualReviewer?: boolean;
}

/** Map a pipeline state to the stage pill it should highlight. */
function activeStageFor(
  state: PipelineState,
  priorActiveState: PipelineState | undefined,
): ActiveStageKey {
  switch (state) {
    case 'idle':
    case 'planning':
    case 'awaiting_plan_approval':
      return 'plan';
    case 'building':
      return 'build';
    case 'reviewing':
    case 'awaiting_dual_reviewer':
    case 'awaiting_tiebreaker':
      return 'review';
    case 'awaiting_red_team':
      return 'red-team';
    case 'awaiting_merge_approval':
    case 'merging':
      return 'merge';
    case 'awaiting_clarification':
      // Resume target — highlight the stage we'd return to.
      if (!priorActiveState) return null;
      return activeStageFor(priorActiveState, undefined);
    case 'done':
    case 'failed':
    case 'escalated':
      return null;
  }
}

function isTerminal(state: PipelineState): boolean {
  return state === 'done' || state === 'failed' || state === 'escalated';
}

function pillStyle(status: StageStatus, reducedMotion = false): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 10px',
    borderRadius: 999,
    border: '1px solid var(--tx-border)',
    fontSize: 11,
    fontFamily: 'var(--tx-font-mono)',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  };
  switch (status) {
    case 'active':
      return {
        ...base,
        background: 'var(--tx-accent)',
        borderColor: 'var(--tx-accent)',
        color: 'var(--tx-accent-fg)',
        fontWeight: 600,
        ...(reducedMotion
          ? {}
          : { animation: 'tx-stage-pulse 1.6s ease-in-out infinite' }),
      };
    case 'past':
      return {
        ...base,
        background: 'var(--tx-text-muted)',
        borderColor: 'var(--tx-text-muted)',
        color: 'var(--tx-bg, #000)',
        opacity: 0.7,
      };
    case 'failed':
      return {
        ...base,
        background: 'var(--tx-error)',
        borderColor: 'var(--tx-error)',
        color: 'var(--tx-accent-fg, #fff)',
        fontWeight: 600,
      };
    case 'future':
    default:
      return {
        ...base,
        background: 'transparent',
        color: 'var(--tx-text-muted)',
      };
  }
}

const ARROW_STYLE: React.CSSProperties = {
  color: 'var(--tx-text-muted)',
  fontSize: 11,
  userSelect: 'none',
};

const TERMINAL_BADGE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: 11,
  fontFamily: 'var(--tx-font-mono)',
  fontWeight: 600,
  lineHeight: 1.4,
};

const KEYFRAMES = `@keyframes tx-stage-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--tx-accent); opacity: 1; }
  50%      { box-shadow: 0 0 0 3px transparent;     opacity: 0.85; }
}`;

export function StageProgress({
  state,
  runMode,
  priorActiveState,
  useDualReviewer = false,
}: Props) {
  // Stage list is always Plan → Build → Review → Merge. Complex runs insert
  // a Red Team pill between Review and Merge. Trivial runs use the same
  // four-stage ordering — the merge gate is always required today.
  const stages: StageDef[] = [
    { key: 'plan', label: 'Plan' },
    { key: 'build', label: 'Build' },
    { key: 'review', label: 'Review' },
  ];
  if (runMode === 'complex') {
    stages.push({ key: 'red-team', label: 'Red Team' });
  }
  stages.push({ key: 'merge', label: 'Merge' });

  const active = activeStageFor(state, priorActiveState);
  const terminal = isTerminal(state);
  const reducedMotion = useReducedMotion();

  // Past/future is computed by index against the active stage. On terminal
  // failure, all pills mute; the failed badge does the talking.
  const activeIdx = active ? stages.findIndex(s => s.key === active) : -1;

  return (
    <div
      role="group"
      aria-label="Pipeline stage progress"
      data-testid="stage-progress"
      data-state={state}
      data-active-stage={active ?? ''}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 40,
        flexWrap: 'wrap',
      }}
    >
      <style>{KEYFRAMES}</style>
      {stages.map((s, i) => {
        let status: StageStatus;
        if (state === 'done') {
          status = 'past';
        } else if (state === 'failed' || state === 'escalated') {
          // No pill is "active" in failure — the badge carries the signal.
          status = 'future';
        } else if (activeIdx < 0) {
          status = 'future';
        } else if (i < activeIdx) {
          status = 'past';
        } else if (i === activeIdx) {
          status = 'active';
        } else {
          status = 'future';
        }
        const isReview = s.key === 'review';
        const showDualBadge = isReview && useDualReviewer;
        return (
          <span
            key={s.key}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span
              data-testid={`stage-pill-${s.key}`}
              data-status={status}
              style={pillStyle(status, reducedMotion)}
            >
              {s.label}
              {showDualBadge && (
                <sub
                  aria-label="dual reviewer"
                  style={{ fontSize: 9, marginLeft: 2, opacity: 0.85 }}
                >
                  ×2
                </sub>
              )}
            </span>
            {i < stages.length - 1 && <span style={ARROW_STYLE}>→</span>}
          </span>
        );
      })}
      {terminal && (
        <span
          data-testid={`stage-badge-${state}`}
          style={{
            ...TERMINAL_BADGE_STYLE,
            marginLeft: 6,
            background:
              state === 'done'
                ? 'var(--tx-text-muted)'
                : 'var(--tx-error)',
            color: 'var(--tx-accent-fg, #fff)',
          }}
        >
          {state === 'done' ? 'Done' : state === 'failed' ? 'Failed' : 'Escalated'}
        </span>
      )}
    </div>
  );
}
