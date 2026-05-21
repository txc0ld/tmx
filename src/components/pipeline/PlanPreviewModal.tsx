import { useEffect, useState } from 'react';
import type { PipelineRun } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';
import { readFileText as defaultReadFileText } from '@/utils/ipc';

/**
 * Plan preview surface for `awaiting_plan_approval`.
 *
 * Read-only window onto `<worktreePath>/<plan.planPath>` so the user can
 * actually *read* the plan before approving. Without this, the controller
 * tile's "Approve" button is a leap of faith — the user has to `cat` the
 * file in a terminal first. This modal closes that loop.
 *
 * Mirrors the SensitivePathsModal / MergerConfirmModal pattern: fixed
 * overlay, CSS-var theming, `data-canvas-overlay` so the canvas wheel
 * handler bails, Escape→cancel, click-outside is a no-op (a cancel
 * during read could lose mid-typed feedback in a future variant — keep
 * dismissal explicit).
 *
 * `Request replan` is intentionally omitted: the state machine's
 * `replan_requested` event is a `escalated`-only carve-out (see
 * src/pipeline/state-machine.ts §replan_requested), so wiring it here
 * would be a no-op the user can't tell apart from a successful dispatch.
 *
 * `readFileText` is dependency-injected for tests; production callers
 * use the default IPC binding.
 */

interface Props {
  run: PipelineRun;
  onClose: () => void;
  /** DI hook — defaults to the IPC binding. Tests pass a vi.fn(). */
  readFileText?: (path: string) => Promise<string>;
}

const overlayStyle: React.CSSProperties = {
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

const modalStyle: React.CSSProperties = {
  background: 'var(--tx-surface-2)',
  border: '1px solid var(--tx-border)',
  borderRadius: 6,
  width: 'min(820px, 94vw)',
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
};

const headerStyle: React.CSSProperties = {
  padding: '14px 18px',
  borderBottom: '1px solid var(--tx-border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const bodyStyle: React.CSSProperties = {
  padding: '14px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  overflowY: 'auto',
  flex: 1,
};

const footerStyle: React.CSSProperties = {
  padding: '12px 18px',
  borderTop: '1px solid var(--tx-border)',
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
};

const buttonBase: React.CSSProperties = {
  padding: '6px 14px',
  color: 'var(--tx-text)',
  cursor: 'pointer',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  fontFamily: 'inherit',
  fontSize: 12,
};

function joinPath(worktreePath: string, planPath: string): string {
  // Cheap cross-platform join — planPath is repo-relative and POSIX-style
  // by convention (it's a git path), so a literal '/' boundary is safe on
  // both macOS/Linux and Windows (Win32 APIs accept forward slashes).
  if (!worktreePath) return planPath;
  if (worktreePath.endsWith('/') || worktreePath.endsWith('\\')) {
    return `${worktreePath}${planPath}`;
  }
  return `${worktreePath}/${planPath}`;
}

/**
 * Lightweight markdown-ish renderer. Intentionally minimal — we want a
 * readable preview, not a full doc engine. Handles:
 *  - `# / ## / ###` ATX headings (rendered as h1/h2/h3)
 *  - triple-backtick fenced code blocks (rendered as <pre>)
 *  - everything else as a plain paragraph that preserves \n via
 *    `whiteSpace: 'pre-wrap'`
 *
 * Inline emphasis (*bold*, _italic_, links) is NOT rendered — the body is
 * presented as monospace text so plan markdown stays readable as-is even
 * when raw `*` / `_` chars leak through.
 */
function renderMarkdown(content: string): React.ReactNode {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let codeBlockKey = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block.
    if (line.startsWith('```')) {
      const fenceLang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      // Skip the closing fence (or end-of-input).
      if (i < lines.length) i++;
      blocks.push(
        <pre
          key={`code-${codeBlockKey++}`}
          data-testid="plan-code-block"
          data-lang={fenceLang || undefined}
          style={{
            margin: '4px 0',
            padding: 10,
            background: 'var(--tx-surface-3, rgba(255,255,255,0.04))',
            border: '1px solid var(--tx-border)',
            borderRadius: 4,
            fontFamily: 'var(--tx-font-mono)',
            fontSize: 12,
            whiteSpace: 'pre',
            overflowX: 'auto',
          }}
        >
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }
    // Headings.
    const h3 = line.match(/^###\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      blocks.push(
        <h1
          key={`h-${i}`}
          style={{ margin: '12px 0 4px', fontSize: 18, fontWeight: 700 }}
        >
          {h1[1]}
        </h1>,
      );
      i++;
      continue;
    }
    if (h2) {
      blocks.push(
        <h2
          key={`h-${i}`}
          style={{ margin: '10px 0 4px', fontSize: 15, fontWeight: 700 }}
        >
          {h2[1]}
        </h2>,
      );
      i++;
      continue;
    }
    if (h3) {
      blocks.push(
        <h3
          key={`h-${i}`}
          style={{ margin: '8px 0 2px', fontSize: 13, fontWeight: 700 }}
        >
          {h3[1]}
        </h3>,
      );
      i++;
      continue;
    }
    // Coalesce a run of non-heading, non-fence lines into one paragraph
    // so blank lines inside markdown become real paragraph breaks.
    const buf: string[] = [];
    while (
      i < lines.length &&
      !lines[i].startsWith('```') &&
      !/^#{1,3}\s+/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(
      <div
        key={`p-${i}`}
        style={{
          whiteSpace: 'pre-wrap',
          fontFamily: 'var(--tx-font-mono)',
          lineHeight: 1.5,
        }}
      >
        {buf.join('\n')}
      </div>,
    );
  }
  return blocks;
}

export function PlanPreviewModal({
  run,
  onClose,
  readFileText = defaultReadFileText,
}: Props) {
  const dispatch = usePipelineStore.getState().dispatch;
  const plan = run.artifacts.plan;
  const fullPath = plan ? joinPath(run.worktreePath, plan.planPath) : '';

  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two-step reject UX: clicking "Reject plan" reveals an inline textarea
  // (kept inside this modal so the user has full plan context while
  // composing feedback). `Send rejection` then validates min-length and
  // dispatches `reject_plan` with the feedback string.
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const REJECT_MIN_CHARS = 10;

  // Escape → close (sibling-modal convention).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Kick the read once on mount / path change. Use a `cancelled` flag so
  // a fast unmount doesn't set state on an unmounted tree.
  useEffect(() => {
    if (!plan) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    readFileText(fullPath).then(
      (text) => {
        if (!cancelled) setContent(text);
      },
      (err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [plan, fullPath, readFileText]);

  function handleApprove() {
    dispatch(run.id, { type: 'approve_plan' });
    onClose();
  }

  function handleSendRejection() {
    const trimmed = rejectFeedback.trim();
    if (trimmed.length < REJECT_MIN_CHARS) return;
    dispatch(run.id, { type: 'reject_plan', feedback: trimmed });
    onClose();
  }

  const trimmedFeedback = rejectFeedback.trim();
  const sendDisabled = trimmedFeedback.length < REJECT_MIN_CHARS;

  return (
    <div
      data-canvas-overlay
      data-testid="plan-preview-modal"
      style={overlayStyle}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Plan preview"
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Review plan</div>
          <div style={{ color: 'var(--tx-text-muted)' }}>
            {plan ? (
              <>
                <code data-testid="plan-preview-path">{fullPath}</code>
                {plan.summary && (
                  <span style={{ marginLeft: 8 }}>— {plan.summary}</span>
                )}
              </>
            ) : (
              <>No plan artifact attached to this run.</>
            )}
          </div>
        </div>

        <div style={bodyStyle}>
          {!plan && (
            <div data-testid="plan-preview-no-plan" style={{ color: 'var(--tx-text-muted)' }}>
              The planner has not produced a plan yet.
            </div>
          )}
          {plan && content === null && error === null && (
            <div
              data-testid="plan-preview-loading"
              style={{ color: 'var(--tx-text-muted)' }}
            >
              Loading plan…
            </div>
          )}
          {plan && error !== null && (
            <div data-testid="plan-preview-error" style={{ color: 'var(--tx-error)' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Failed to read plan</div>
              <div>
                <code>{fullPath}</code>
              </div>
              <div style={{ marginTop: 4 }}>{error}</div>
            </div>
          )}
          {plan && content !== null && (
            <div data-testid="plan-preview-content">{renderMarkdown(content)}</div>
          )}
        </div>

        {rejectOpen && (
          <div
            data-testid="plan-preview-reject-panel"
            style={{
              padding: '12px 18px',
              borderTop: '1px solid var(--tx-border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: 'var(--tx-surface-3, rgba(255,255,255,0.02))',
            }}
          >
            <label
              htmlFor="plan-preview-reject-textarea"
              style={{ color: 'var(--tx-text-muted)', fontSize: 12 }}
            >
              Why Is This Plan Unsuitable? (Required — sent to planner for the next pass)
            </label>
            <textarea
              id="plan-preview-reject-textarea"
              data-testid="plan-preview-reject-textarea"
              value={rejectFeedback}
              onChange={(e) => setRejectFeedback(e.target.value)}
              autoFocus
              rows={4}
              style={{
                resize: 'vertical',
                padding: 8,
                background: 'var(--tx-surface-1, var(--tx-surface-2))',
                color: 'var(--tx-text)',
                border: '1px solid var(--tx-border)',
                borderRadius: 3,
                fontFamily: 'var(--tx-font-mono)',
                fontSize: 12,
                lineHeight: 1.5,
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span
                data-testid="plan-preview-reject-validation"
                style={{
                  fontSize: 11,
                  color: sendDisabled ? 'var(--tx-text-muted)' : 'var(--tx-text)',
                }}
              >
                {sendDisabled
                  ? `${trimmedFeedback.length}/${REJECT_MIN_CHARS} chars min`
                  : `${trimmedFeedback.length} chars`}
              </span>
              <button
                type="button"
                data-testid="plan-preview-send-rejection"
                onClick={handleSendRejection}
                disabled={sendDisabled}
                style={{
                  ...buttonBase,
                  background: 'var(--tx-warn, #b08400)',
                  borderColor: 'var(--tx-warn, #b08400)',
                  color: 'var(--tx-accent-fg)',
                  fontWeight: 600,
                  opacity: sendDisabled ? 0.5 : 1,
                  cursor: sendDisabled ? 'not-allowed' : 'pointer',
                }}
              >
                Send rejection
              </button>
            </div>
          </div>
        )}

        <div style={footerStyle}>
          <button
            type="button"
            data-testid="plan-preview-cancel"
            onClick={onClose}
            style={{ ...buttonBase, background: 'var(--tx-surface-2)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="plan-preview-reject"
            onClick={() => setRejectOpen((v) => !v)}
            disabled={!plan}
            aria-expanded={rejectOpen}
            style={{
              ...buttonBase,
              background: 'var(--tx-surface-2)',
              opacity: plan ? 1 : 0.5,
              cursor: plan ? 'pointer' : 'not-allowed',
            }}
          >
            {rejectOpen ? 'Hide rejection' : 'Reject plan'}
          </button>
          <button
            type="button"
            data-testid="plan-preview-approve"
            onClick={handleApprove}
            disabled={!plan}
            style={{
              ...buttonBase,
              background: 'var(--tx-accent)',
              borderColor: 'var(--tx-accent)',
              color: '#000',
              fontWeight: 600,
              opacity: plan ? 1 : 0.5,
              cursor: plan ? 'pointer' : 'not-allowed',
            }}
          >
            Approve plan
          </button>
        </div>
      </div>
    </div>
  );
}
