import { useEffect, useState } from 'react';
import type { PipelineRun, ReviewVerdict } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { useToastStore } from '@/stores/toastStore';
import { pipelineMergerRequestToken, pipelineMergerRun } from '@/utils/ipc';

interface Props {
  run: PipelineRun;
  /** Optional override for tests / future callers. Defaults to 'main'. */
  baseBranch?: string;
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

const codeBlockStyle: React.CSSProperties = {
  display: 'block',
  padding: 8,
  background: 'rgba(0,0,0,0.25)',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  fontFamily: 'var(--tx-font-mono)',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

function verdictRowStyle(verdict: ReviewVerdict['verdict']): React.CSSProperties {
  const isApprove = verdict === 'approve';
  return {
    padding: '6px 8px',
    borderRadius: 3,
    border: `1px solid ${isApprove ? 'rgba(0, 200, 100, 0.4)' : 'rgba(220, 180, 0, 0.4)'}`,
    background: isApprove ? 'rgba(0, 200, 100, 0.08)' : 'rgba(220, 180, 0, 0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  };
}

const COMMIT_LIST_MAX_HEIGHT = 180;

export function MergerConfirmModal({ run, baseBranch = 'main' }: Props) {
  const dispatch = usePipelineStore(s => s.dispatch);
  const addToast = useToastStore(s => s.addToast);
  const [submitting, setSubmitting] = useState(false);

  // Latest build (if any) — bullet list comes from its commits.
  const lastBuild = run.artifacts.builds[run.artifacts.builds.length - 1];
  const reviews = run.artifacts.reviews;

  const headShaShort = lastBuild?.headSha?.slice(0, 7) ?? '(none)';
  const commitCount = lastBuild?.commits.length ?? 0;
  const filesChangedCount = lastBuild?.filesChanged.length ?? 0;

  const prCommand = `gh pr create --base ${baseBranch} --head ${run.branch}`;
  const localCommand = `git switch ${baseBranch} && git merge --no-ff ${run.branch}`;

  // Escape → Cancel. Skip while submitting so we don't strand a request mid-flight.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        handleCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // handleCancel/handleMerge identity is fine to omit — they read fresh state via getState().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting]);

  function handleCancel() {
    dispatch(run.id, { type: 'reject_merge' });
  }

  async function handleMerge() {
    if (submitting) return;
    setSubmitting(true);

    const project = useProjectStore.getState().projects.find(p => p.id === run.projectId);
    if (!project) {
      addToast('Merge aborted: project not loaded', 'error');
      setSubmitting(false);
      return;
    }

    // Transition awaiting_merge_approval → merging BEFORE the IPC call so
    // telemetry captures the intermediate state and a refresh mid-merge shows
    // the right machine state.
    dispatch(run.id, { type: 'approve_merge' });

    try {
      const token = await pipelineMergerRequestToken(run.id);
      const result = await pipelineMergerRun({
        runId: run.id,
        projectDir: project.cwd,
        branch: run.branch,
        baseBranch,
        confirmToken: token,
      });

      if (result.status === 'success') {
        dispatch(run.id, { type: 'merge_done' });
        const where =
          result.mode === 'pr' && result.pr_url
            ? `PR opened: ${result.pr_url}`
            : 'Merged';
        addToast(where, 'success');
      } else {
        const reason = result.detail || result.status;
        dispatch(run.id, { type: 'merge_failed', reason });
        addToast(`Merge failed: ${reason}`, 'error');
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      dispatch(run.id, { type: 'merge_failed', reason });
      addToast(`Merge failed: ${reason}`, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-canvas-overlay
      data-testid="merger-confirm-modal"
      style={overlayStyle}
      // Click outside the inner card does NOT close — destructive op.
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm merge"
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Confirm merge</div>
          <div style={{ color: 'var(--tx-text-muted)' }}>
            <code>{run.id}</code> &nbsp;·&nbsp; <code>{run.branch}</code>{' '}
            <span style={{ opacity: 0.7 }}>→</span> <code>{baseBranch}</code>
          </div>
        </div>

        <div style={bodyStyle}>
          <div>
            <div style={sectionLabelStyle}>Last build</div>
            <div>
              headSha: <code>{headShaShort}</code> &nbsp;·&nbsp; commits: {commitCount}{' '}
              &nbsp;·&nbsp; files changed: {filesChangedCount}
            </div>
          </div>

          <div>
            <div style={sectionLabelStyle}>Commit subjects</div>
            {commitCount === 0 ? (
              <div style={{ color: 'var(--tx-text-muted)' }}>(no commits)</div>
            ) : (
              <ul
                data-testid="merger-modal-commits"
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  maxHeight: COMMIT_LIST_MAX_HEIGHT,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                {lastBuild!.commits.map(c => (
                  <li key={c.sha}>
                    <code style={{ color: 'var(--tx-text-muted)' }}>{c.sha.slice(0, 7)}</code>{' '}
                    {c.subject}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div style={sectionLabelStyle}>Reviewer verdicts</div>
            {reviews.length === 0 ? (
              <div style={{ color: 'var(--tx-text-muted)' }}>(no reviews)</div>
            ) : (
              <div
                data-testid="merger-modal-reviews"
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {reviews.map((r, i) => (
                  <div key={`${r.reviewer}-${r.round}-${i}`} style={verdictRowStyle(r.verdict)}>
                    <div>
                      <strong>{r.reviewer}</strong> @ <strong>{r.verdict}</strong>
                      {r.confidence && (
                        <span
                          style={{
                            marginLeft: 8,
                            padding: '1px 6px',
                            borderRadius: 8,
                            border: '1px solid var(--tx-border)',
                            fontSize: 10,
                            color: 'var(--tx-text-muted)',
                          }}
                        >
                          {r.confidence}
                        </span>
                      )}
                    </div>
                    <div style={{ color: 'var(--tx-text-muted)' }}>{r.summary}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={sectionLabelStyle}>Will run one of these (auto-detected at merge time)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                <div style={{ marginBottom: 2 }}>If a GitHub remote is detected:</div>
                <code style={codeBlockStyle}>{prCommand}</code>
              </div>
              <div>
                <div style={{ marginBottom: 2 }}>Otherwise (local merge):</div>
                <code style={codeBlockStyle}>{localCommand}</code>
              </div>
            </div>
          </div>
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            data-testid="merger-modal-cancel"
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
            data-testid="merger-modal-merge"
            onClick={handleMerge}
            disabled={submitting}
            style={{
              ...buttonBase,
              background: 'var(--tx-accent)',
              borderColor: 'var(--tx-accent)',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            {submitting ? 'Merging…' : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
