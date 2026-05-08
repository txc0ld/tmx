import { useState } from 'react';
import { usePipelineStore } from '@/stores/pipelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { isTerminalState } from '@/pipeline/state-machine';
import { MergerConfirmModal } from '@/components/pipeline/MergerConfirmModal';
import { ClarificationModal } from '@/components/pipeline/ClarificationModal';
import { PlanPreviewModal } from '@/components/pipeline/PlanPreviewModal';
import { RunLogsModal } from '@/components/pipeline/RunLogsModal';
import { ConfirmableButton } from '@/components/pipeline/ConfirmableButton';
import { pipelineWorktreeDestroy, deleteFile } from '@/utils/ipc';
import { snapshotPath } from '@/pipeline/run-persistence';
import type { PipelineControllerTile as Tile } from '@/types';

interface Props {
  tile: Tile;
}

const BUTTON_BASE = {
  padding: '4px 10px',
  color: 'var(--tx-text)',
  cursor: 'pointer',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
} as const;

export function PipelineControllerTile({ tile }: Props) {
  const run = usePipelineStore(s => s.runs[tile.runId]);
  const dispatch = usePipelineStore(s => s.dispatch);
  const removeRun = usePipelineStore(s => s.removeRun);
  const project = useProjectStore(s => s.projects.find(p => p.id === run?.projectId));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (!run) {
    return (
      <div style={{ padding: 12, color: 'var(--tx-text-muted)' }}>
        No run bound (runId={tile.runId}).
      </div>
    );
  }

  const isTerminal = isTerminalState(run.state);

  // Worktree cleanup is only meaningful in terminal states. We:
  //   1. tear down the on-disk worktree + branch via the existing IPC,
  //   2. delete the persisted run JSON so reload doesn't resurrect a
  //      ghost run pointing at a missing path,
  //   3. drop the run from the in-memory store.
  // Errors at step 1 surface inline; step 2/3 still run because the
  // worktree may already be partially gone (idempotent IPCs).
  const handleDeleteWorktree = async () => {
    if (!isTerminal || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const projectDir = project?.cwd ?? '';
    try {
      if (projectDir) {
        await pipelineWorktreeDestroy({
          projectDir,
          worktreePath: run.worktreePath,
          branch: run.branch,
        });
      }
    } catch (err) {
      // Don't bail — the JSON snapshot deletion below is still useful so
      // the user can retry from a cleaner state. Surface the worktree
      // error message so they can see why git failed.
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
    if (projectDir) {
      try {
        await deleteFile(snapshotPath(projectDir, run.id));
      } catch (err) {
        // Snapshot deletion failure is non-fatal; the next launch won't
        // see it as an active run anyway (terminal state).
        console.warn('[pipeline] failed to delete run snapshot:', err);
      }
    }
    removeRun(run.id);
    setDeleting(false);
  };

  return (
    <div style={{
      padding: 12,
      display: 'flex', flexDirection: 'column', gap: 8,
      color: 'var(--tx-text)',
      fontFamily: 'var(--tx-font-mono)',
      fontSize: 12,
    }}>
      {run.agentsDisconnected && (
        <div
          role="alert"
          data-testid="agents-disconnected-banner"
          style={{
            background: 'rgba(234, 179, 8, 0.18)',
            border: '1px solid rgba(234, 179, 8, 0.55)',
            color: 'var(--tx-text)',
            padding: '6px 10px',
            borderRadius: 3,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ color: '#facc15' }}>{'⚠'} Agents disconnected</strong>
          {' — this run was restored after a reload. Approve/abort actions still work, but Builder/Reviewer won’t auto-resume. Launch a fresh run to continue.'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
        <strong>Pipeline</strong>
        <span style={{ color: 'var(--tx-text-muted)' }}>{run.id}</span>
        <span>state: <code style={{ color: 'var(--tx-accent)' }}>{run.state}</code></span>
      </div>
      <div>branch: <code>{run.branch}</code></div>
      <div>worktree: <code>{run.worktreePath}</code></div>
      <div>retries: reviewer={run.retryCounters.reviewerReject}/3, ci={run.retryCounters.ciFail}/3</div>
      {run.failureReason && (
        <div style={{ color: 'var(--tx-error)' }}>failure: {run.failureReason}</div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {!isTerminal && run.state === 'idle' && (
          <button
            type="button"
            onClick={() => dispatch(run.id, { type: 'start' })}
            style={{
              ...BUTTON_BASE,
              background: 'var(--tx-accent)',
              borderColor: 'var(--tx-accent)',
              color: 'var(--tx-accent-fg)',
              fontWeight: 600,
              padding: '4px 14px',
            }}
          >
            Start
          </button>
        )}
        {!isTerminal && run.state === 'awaiting_plan_approval' && (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            disabled={!run.artifacts.plan}
            title={run.artifacts.plan ? undefined : 'No plan yet'}
            style={{
              ...BUTTON_BASE,
              background: 'var(--tx-accent)',
              borderColor: 'var(--tx-accent)',
              color: 'var(--tx-accent-fg)',
              fontWeight: 600,
              padding: '4px 14px',
              opacity: run.artifacts.plan ? 1 : 0.5,
              cursor: run.artifacts.plan ? 'pointer' : 'not-allowed',
            }}
          >
            Review plan
          </button>
        )}
        {!isTerminal && (
          <ConfirmableButton
            label="Abort"
            confirmLabel="Confirm abort?"
            variant="danger"
            onConfirm={() => dispatch(run.id, { type: 'abort', reason: 'user clicked abort' })}
          />
        )}
        {isTerminal && (
          <ConfirmableButton
            label="Clear"
            confirmLabel="Confirm clear?"
            variant="neutral"
            onConfirm={() => removeRun(run.id)}
          />
        )}
        {isTerminal && (
          <ConfirmableButton
            label={deleting ? 'Deleting…' : 'Delete worktree'}
            confirmLabel="Confirm delete worktree?"
            variant="danger"
            disabled={deleting}
            title="Tear down the on-disk worktree + branch and remove this run from the store"
            onConfirm={() => {
              void handleDeleteWorktree();
            }}
          />
        )}
        <button
          type="button"
          onClick={() => setLogsOpen(true)}
          style={{ ...BUTTON_BASE, background: 'var(--tx-surface-2)' }}
          title="View telemetry, plan/spec, and failure bundle for this run"
        >
          View logs
        </button>
      </div>
      {deleteError && (
        <div style={{ color: 'var(--tx-error)' }} role="alert">
          delete failed: {deleteError}
        </div>
      )}
      {run.state === 'awaiting_merge_approval' && <MergerConfirmModal run={run} />}
      {run.state === 'awaiting_clarification' && run.artifacts.questions.length > 0 && (
        <ClarificationModal run={run} />
      )}
      {previewOpen && (
        <PlanPreviewModal run={run} onClose={() => setPreviewOpen(false)} />
      )}
      {logsOpen && (
        <RunLogsModal
          run={run}
          projectDir={project?.cwd ?? ''}
          onClose={() => setLogsOpen(false)}
        />
      )}
    </div>
  );
}
