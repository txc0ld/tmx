import { useEffect, useState } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import { useHealthCheck } from '@/hooks/useHealthCheck';
import { isMac } from '@/utils/platform';

const SEEN_KEY = 'tx-pipeline-onboarding-seen';

function readSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // No localStorage (private mode, quota) — treat as seen so we don't
    // pop the tooltip on every render in a misconfigured environment.
    return true;
  }
}

function persistSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // localStorage write failed — the tooltip just shows again next boot.
  }
}

/**
 * Imperative dismiss hook for parent callers — TopBar wires this into the
 * Pipeline button's click handler so any click (whether the user is reading
 * the tooltip or just hammering the button) auto-dismisses.
 *
 * Exported as a standalone helper rather than threaded through React state
 * because the click target lives in a sibling component (`PipelineButton`),
 * not a child of this tooltip. Persisting + emitting a window event lets
 * the live `<PipelineOnboardingTooltip />` instance hide on the next render
 * without needing prop drilling.
 */
export function dismissPipelineOnboarding(): void {
  persistSeen();
  try {
    window.dispatchEvent(new Event('tx-pipeline-onboarding-dismissed'));
  } catch {
    // CustomEvent unavailable in some test environments — local state will
    // pick up the persisted flag on next render anyway.
  }
}

/**
 * One-time guided callout below the Pipeline button that explains the
 * Plan → Build → Review flow. Shown ONLY when ALL conditions are met:
 *
 *  1. localStorage `tx-pipeline-onboarding-seen` is NOT `'1'`
 *  2. User has at least one project (no projects → WelcomeBanner covers it)
 *  3. `pipelineHealthCheck` reports `claude` available
 *  4. The user has not yet launched ANY pipeline run on any project
 *     (`pipelineStore.runs` is empty)
 *
 * Any other condition → fail-silent, render nothing. The tooltip never
 * blocks the canvas, never auto-pops a modal, and is dismissed via the
 * "Got it" button OR by clicking the Pipeline button (the parent calls
 * `dismissPipelineOnboarding()` from the button's click handler).
 *
 * Visually a 280px floating callout positioned absolutely below its
 * sibling Pipeline button. The triangular arrow at the top points up to
 * the button. Fades in 300ms after mount via a setTimeout/CSS-transition
 * pair so the box eases on rather than popping.
 */
export function PipelineOnboardingTooltip() {
  const projects = useProjectStore((s) => s.projects);
  const runs = usePipelineStore((s) => s.runs);
  const health = useHealthCheck();

  // Initial seen state. We read once on mount; the dismiss-event listener
  // below re-reads when the user clicks the Pipeline button itself.
  const [seen, setSeen] = useState<boolean>(() => readSeen());

  // Faded-in state — false on mount, flipped true after a short delay so
  // the tooltip eases in rather than slamming on. Reset whenever we go
  // from "would render" to "won't render" so re-shown tooltips fade again.
  const [visible, setVisible] = useState<boolean>(false);

  // Listen for a programmatic dismiss (e.g. parent calls
  // dismissPipelineOnboarding() from the Pipeline button's onClick).
  useEffect(() => {
    const handler = () => setSeen(true);
    window.addEventListener('tx-pipeline-onboarding-dismissed', handler);
    return () => window.removeEventListener('tx-pipeline-onboarding-dismissed', handler);
  }, []);

  const conditionsMet = (
    !seen
    && projects.length > 0
    && health?.missing.includes('claude') === false  // health resolved AND claude is present
    && Object.keys(runs).length === 0
  );

  // Drive the fade-in. Wait one tick after mount so the initial render is
  // at opacity 0 and the next render flips to opacity 1, producing a real
  // CSS transition rather than a no-op.
  useEffect(() => {
    if (!conditionsMet) {
      setVisible(false);
      return;
    }
    const id = window.setTimeout(() => setVisible(true), 50);
    return () => window.clearTimeout(id);
  }, [conditionsMet]);

  if (!conditionsMet) return null;

  const handleDismiss = () => {
    dismissPipelineOnboarding();
    setSeen(true);
  };

  const shortcutLabel = isMac() ? '⌘⇧P' : 'Ctrl+Shift+P';

  return (
    <div
      data-testid="pipeline-onboarding-tooltip"
      role="dialog"
      aria-label="Pipeline runs introduction"
      style={{
        position: 'absolute',
        // The TopBar host has `position: relative` implicitly via flex;
        // we anchor below the Pipeline button group with a small offset
        // so the arrow visually attaches to the button.
        top: 'calc(100% + 8px)',
        right: 0,
        width: 280,
        background: 'var(--tx-tile-bg, #1a1a1a)',
        border: '1px solid var(--tx-accent, #4a9eff)',
        borderRadius: 8,
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
        padding: '12px 14px',
        color: 'var(--tx-fg, #e6e6e6)',
        fontSize: 12,
        lineHeight: 1.5,
        zIndex: 1000,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-4px)',
        transition: 'opacity 300ms ease, transform 300ms ease',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      {/* Triangular arrow pointing UP at the Pipeline button. Two stacked
          triangles fake a 1px accent border around the arrow — the outer
          one matches the box border color, the inner one matches the box
          background and is offset 1px down to leave the border peeking. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: -7,
          right: 24,
          width: 0,
          height: 0,
          borderLeft: '7px solid transparent',
          borderRight: '7px solid transparent',
          borderBottom: '7px solid var(--tx-accent, #4a9eff)',
        }}
      />
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: -5,
          right: 25,
          width: 0,
          height: 0,
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderBottom: '6px solid var(--tx-tile-bg, #1a1a1a)',
        }}
      />

      <div style={{ marginBottom: 10 }}>
        Click here (or <kbd style={{
          fontFamily: 'inherit',
          background: 'var(--tx-outline-ghost, rgba(255,255,255,0.08))',
          border: '1px solid var(--tx-outline-variant, rgba(255,255,255,0.15))',
          borderRadius: 4,
          padding: '0 5px',
          fontSize: 11,
        }}>{shortcutLabel}</kbd>) to launch a multi-agent pipeline run. The Planner writes a spec + plan, the Builder executes it, and the Reviewer verdicts the diff — all in an isolated git worktree.
      </div>

      <button
        type="button"
        data-testid="pipeline-onboarding-dismiss"
        onClick={handleDismiss}
        style={{
          background: 'var(--tx-accent, #4a9eff)',
          color: 'var(--tx-accent-fg, #000)',
          border: 'none',
          borderRadius: 4,
          padding: '5px 12px',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Got it
      </button>
    </div>
  );
}
