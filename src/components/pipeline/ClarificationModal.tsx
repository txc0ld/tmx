import { useEffect, useRef, useState } from 'react';
import type { AgentTile, PipelineRole, PipelineRun, QuestionArtifact, Tile } from '@/types';
import { emitTelemetry, usePipelineStore } from '@/stores/pipelineStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { ptyWrite } from '@/utils/ipc';

interface Props {
  run: PipelineRun;
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10_000,
  background: 'rgba(0, 0, 0, 0.6)',
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
  width: 'min(640px, 92vw)',
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
  gap: 14,
  overflowY: 'auto',
};

const footerStyle: React.CSSProperties = {
  padding: '12px 18px',
  borderTop: '1px solid var(--tx-border)',
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
};

const sectionLabelStyle: React.CSSProperties = {
  textTransform: 'uppercase',
  fontSize: 10,
  letterSpacing: 1,
  color: 'var(--tx-text-muted)',
  marginBottom: 4,
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

const optionButtonStyle: React.CSSProperties = {
  ...buttonBase,
  background: 'var(--tx-surface-2)',
  textAlign: 'left',
  whiteSpace: 'normal',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 80,
  padding: 8,
  background: 'rgba(0,0,0,0.25)',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  color: 'var(--tx-text)',
  fontFamily: 'var(--tx-font-mono)',
  fontSize: 12,
  resize: 'vertical',
  boxSizing: 'border-box',
};

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Look up the AgentTile bound to a given pipeline role across all projects.
 * `run.tiles` maps role → tileId; we then scan canvasStore tiles for that id.
 * Returns the AgentTile (so callers can read `ptyId`) or null if not found.
 */
function findAgentTile(run: PipelineRun, role: PipelineRole): AgentTile | null {
  const tileId = run.tiles[role];
  if (!tileId) return null;
  const projectTiles = useCanvasStore.getState().tiles;
  for (const list of Object.values(projectTiles)) {
    const arr = list as Tile[] | undefined;
    if (!arr) continue;
    const found = arr.find(t => t.id === tileId);
    if (found && found.type === 'agent') return found as AgentTile;
  }
  return null;
}

/**
 * Re-inject a clarification answer into the agent that asked the question.
 *
 * Live agents (planner/builder) are PTY-backed: write the answer + carriage
 * return so the agent's CLI ingests it as if the user typed it. One-shot
 * agents (the Reviewer, currently) have no PTY — we no-op here. The answer
 * still lands in telemetry, and the next `agent_run_oneshot` invocation
 * (Phase 2c-iii follow-up) is responsible for surfacing it on stdin.
 */
async function injectAnswer(run: PipelineRun, stage: PipelineRole, answer: string): Promise<void> {
  const tile = findAgentTile(run, stage);
  const ptyId = tile?.ptyId;
  if (!ptyId) return;
  // Trailing CR mirrors the rest of the codebase (TodoTile auto-dispatch,
  // MCP task injection, etc.) — a bare \n won't submit in some agent CLIs.
  await ptyWrite(ptyId, `${answer}\r`);
}

export function ClarificationModal({ run }: Props) {
  const dispatch = usePipelineStore(s => s.dispatch);
  const [submitting, setSubmitting] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Latest unanswered question. We don't track per-question answered state
  // (Phase 1: at most one outstanding); the state machine guarantees we're
  // only mounted while in awaiting_clarification.
  const question: QuestionArtifact | undefined =
    run.artifacts.questions[run.artifacts.questions.length - 1];

  // Escape → Cancel (matches MergerConfirmModal). Skip while a submit is in
  // flight so we don't strand the dispatch / PTY write half-done.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        handleCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // handleCancel reads fresh state via getState(); identity is fine to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting]);

  // Autofocus the textarea on mount so the user can start typing immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (!question) {
    // Shouldn't happen — the controller tile only renders us when there's a
    // question. Render nothing rather than crash if state desyncs.
    return null;
  }

  function handleCancel() {
    dispatch(run.id, { type: 'abort', reason: 'clarification_cancelled' });
  }

  function handleOptionClick(opt: string) {
    setText(opt);
    inputRef.current?.focus();
  }

  async function handleSubmit() {
    const answer = text.trim();
    if (!answer || submitting || !question) return;
    setSubmitting(true);
    try {
      await injectAnswer(run, question.stage, answer);
      emitTelemetry({
        at: Date.now(),
        event: 'clarification_answered',
        runId: run.id,
        projectId: run.projectId,
        stage: question.stage,
      });
      dispatch(run.id, { type: 'clarification_received', answer });
    } catch (err) {
      // PTY write can fail (PTY exited / unknown id). We still want the run
      // to advance — the user has given us an answer. Log + dispatch.
      console.warn('[pipeline] clarification injectAnswer failed:', err);
      emitTelemetry({
        at: Date.now(),
        event: 'clarification_answered',
        runId: run.id,
        projectId: run.projectId,
        stage: question.stage,
      });
      dispatch(run.id, { type: 'clarification_received', answer });
    } finally {
      setSubmitting(false);
    }
  }

  const submitDisabled = submitting || text.trim().length === 0;

  return (
    <div
      data-canvas-overlay
      data-testid="clarification-modal"
      style={overlayStyle}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Clarification needed"
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Question from {capitalize(question.stage)}
          </div>
          <div style={{ color: 'var(--tx-text-muted)' }}>
            <code>{run.id}</code>
          </div>
        </div>

        <div style={bodyStyle}>
          <div data-testid="clarification-question" style={{ fontSize: 14, lineHeight: 1.4 }}>
            {question.question}
          </div>

          {question.context && (
            <details data-testid="clarification-context">
              <summary style={{ cursor: 'pointer', color: 'var(--tx-text-muted)' }}>
                Context
              </summary>
              <div
                style={{
                  marginTop: 6,
                  padding: 8,
                  background: 'rgba(0,0,0,0.25)',
                  border: '1px solid var(--tx-border)',
                  borderRadius: 3,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {question.context}
              </div>
            </details>
          )}

          {question.options && question.options.length > 0 && (
            <div>
              <div style={sectionLabelStyle}>Suggested answers</div>
              <div
                data-testid="clarification-options"
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {question.options.map((opt, i) => (
                  <button
                    key={`${i}-${opt.slice(0, 32)}`}
                    type="button"
                    data-testid={`clarification-option-${i}`}
                    onClick={() => handleOptionClick(opt)}
                    disabled={submitting}
                    style={{ ...optionButtonStyle, opacity: submitting ? 0.5 : 1 }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <div style={sectionLabelStyle}>Your answer</div>
            <textarea
              ref={inputRef}
              data-testid="clarification-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type your answer..."
              disabled={submitting}
              style={textareaStyle}
            />
          </div>
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            data-testid="clarification-cancel"
            onClick={handleCancel}
            disabled={submitting}
            style={{
              ...buttonBase,
              background: 'var(--tx-surface-2)',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="clarification-submit"
            onClick={handleSubmit}
            disabled={submitDisabled}
            style={{
              ...buttonBase,
              background: 'var(--tx-accent)',
              borderColor: 'var(--tx-accent)',
              color: 'var(--tx-accent-fg)',
              fontWeight: 600,
              opacity: submitDisabled ? 0.5 : 1,
            }}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Exported for tests — the injection helper is the side-effect we want to
// assert against without mounting a real PTY.
export const __test__ = { injectAnswer, findAgentTile };
