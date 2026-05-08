import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Goal-and-branch input modal — the visible entry point to the pipeline.
 *
 * UI-only; the launch flow itself lives in `src/pipeline/launch.ts`. The
 * modal calls back into `onSubmit({ goal, branch })` and surfaces the
 * resolved error / success message inline so the user doesn't have to hunt
 * through toasts. Submit is disabled while the launch flow is running.
 *
 * Conventions match SensitivePathsModal + MergerConfirmModal: no
 * click-outside dismiss (a half-typed goal is real work); Escape acts as
 * Cancel; data-testid hooks match the existing pipeline modals so e2e
 * scaffolding can find both with the same selectors pattern.
 */

interface Props {
  defaultBranch: string;
  /** Resolves once the launch attempt finishes (success or error). */
  onSubmit(input: { goal: string; branch: string }): Promise<{ ok: boolean; error?: string }>;
  onCancel(): void;
  /**
   * Visually hide the modal without unmounting. Used by App.tsx to stack
   * the SensitivePathsModal in front while preserving this modal's
   * goal/branch/error state for when the gate cancel returns control.
   */
  hidden?: boolean;
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10_000,
  background: 'rgba(0, 0, 0, 0.75)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--tx-font-mono)',
  fontSize: 12,
  color: 'var(--tx-text)',
};

const modal: React.CSSProperties = {
  background: 'var(--tx-surface-2)',
  border: '1px solid var(--tx-border)',
  borderRadius: 6,
  width: 'min(640px, 92vw)',
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
};

const header: React.CSSProperties = {
  padding: '14px 18px',
  borderBottom: '1px solid var(--tx-border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const body: React.CSSProperties = {
  padding: '14px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  overflowY: 'auto',
};

const footer: React.CSSProperties = {
  padding: '12px 18px',
  borderTop: '1px solid var(--tx-border)',
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
  alignItems: 'center',
};

const label: React.CSSProperties = {
  textTransform: 'uppercase',
  fontSize: 10,
  letterSpacing: 1,
  color: 'var(--tx-text-muted)',
  marginBottom: 4,
};

const input: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--tx-input-bg, var(--tx-bg))',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  color: 'var(--tx-text)',
  fontFamily: 'inherit',
  fontSize: 12,
  boxSizing: 'border-box',
};

const button: React.CSSProperties = {
  padding: '6px 14px',
  color: 'var(--tx-text)',
  cursor: 'pointer',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  fontFamily: 'inherit',
  fontSize: 12,
};

export function StartPipelineRunModal({ defaultBranch, onSubmit, onCancel, hidden = false }: Props) {
  const [goal, setGoal] = useState('');
  const [branch, setBranch] = useState(defaultBranch);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  const canSubmit = useMemo(
    () => !submitting && goal.trim().length > 0 && branch.trim().length > 0,
    [submitting, goal, branch],
  );

  useEffect(() => {
    goalRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (submitting) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const result = await onSubmit({ goal: goal.trim(), branch: branch.trim() });
    if (!result.ok) {
      setError(result.error ?? 'Unknown error');
      setSubmitting(false);
    }
    // On success, the parent unmounts us; no need to reset state.
  };

  return (
    <div
      data-canvas-overlay
      data-testid="start-pipeline-run-modal"
      aria-hidden={hidden}
      style={{ ...overlay, ...(hidden ? { display: 'none' } : null) }}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" aria-label="Start pipeline run" style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Start pipeline run</div>
          <div style={{ color: 'var(--tx-text-muted)' }}>
            Plan → Build → Review with the Anthropic Trio. The pipeline will create
            a worktree, spawn agent tiles, and run inside an isolated branch.
          </div>
        </div>

        <div style={body}>
          <div>
            <div style={label}>Goal</div>
            <textarea
              ref={goalRef}
              data-testid="start-pipeline-run-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Describe what the pipeline should accomplish — be concrete. e.g. 'Add a /healthz endpoint that returns 200 with the build SHA, plus an integration test.'"
              rows={6}
              style={{ ...input, resize: 'vertical', minHeight: 96 }}
              disabled={submitting}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
            />
            <div style={{ color: 'var(--tx-text-muted)', marginTop: 4, fontSize: 11 }}>
              Cmd / Ctrl + Enter to submit. The text is also written to{' '}
              <code>PIPELINE_GOAL.md</code> at the worktree root.
            </div>
          </div>

          <div>
            <div style={label}>Branch</div>
            <input
              data-testid="start-pipeline-run-branch"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              style={input}
              disabled={submitting}
            />
            <div style={{ color: 'var(--tx-text-muted)', marginTop: 4, fontSize: 11 }}>
              Letters, digits, dots, underscores, slashes, hyphens.
            </div>
          </div>

          {error && (
            <div
              data-testid="start-pipeline-run-error"
              style={{
                background: 'var(--tx-error-bg, rgba(255, 80, 80, 0.12))',
                border: '1px solid var(--tx-error, #f55)',
                color: 'var(--tx-error, #f88)',
                padding: '8px 10px',
                borderRadius: 3,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div style={footer}>
          {submitting && (
            <div data-testid="start-pipeline-run-spinner" style={{ color: 'var(--tx-text-muted)', marginRight: 'auto' }}>
              Launching…
            </div>
          )}
          <button
            type="button"
            data-testid="start-pipeline-run-cancel"
            onClick={onCancel}
            disabled={submitting}
            style={{ ...button, background: 'var(--tx-surface-2)', opacity: submitting ? 0.5 : 1 }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="start-pipeline-run-submit"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              ...button,
              background: canSubmit ? 'var(--tx-accent)' : 'var(--tx-surface-2)',
              borderColor: canSubmit ? 'var(--tx-accent)' : 'var(--tx-border)',
              color: canSubmit ? 'var(--tx-accent-fg)' : 'var(--tx-text)',
              fontWeight: canSubmit ? 600 : 400,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
