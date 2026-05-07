import { usePipelineStore } from '@/stores/pipelineStore';
import { isTerminalState } from '@/pipeline/state-machine';
import { MergerConfirmModal } from '@/components/pipeline/MergerConfirmModal';
import { ClarificationModal } from '@/components/pipeline/ClarificationModal';
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

  if (!run) {
    return (
      <div style={{ padding: 12, color: 'var(--tx-text-muted)' }}>
        No run bound (runId={tile.runId}).
      </div>
    );
  }

  const isTerminal = isTerminalState(run.state);

  return (
    <div style={{
      padding: 12,
      display: 'flex', flexDirection: 'column', gap: 8,
      color: 'var(--tx-text)',
      fontFamily: 'var(--tx-font-mono)',
      fontSize: 12,
    }}>
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
            style={{ ...BUTTON_BASE, background: 'var(--tx-accent)' }}
          >
            Start
          </button>
        )}
        {!isTerminal && (
          <button
            type="button"
            onClick={() => dispatch(run.id, { type: 'abort', reason: 'user clicked abort' })}
            style={{ ...BUTTON_BASE, background: 'var(--tx-surface-2)' }}
          >
            Abort
          </button>
        )}
        {isTerminal && (
          <button
            type="button"
            onClick={() => removeRun(run.id)}
            style={{ ...BUTTON_BASE, background: 'var(--tx-surface-2)' }}
          >
            Clear
          </button>
        )}
      </div>
      {run.state === 'awaiting_merge_approval' && <MergerConfirmModal run={run} />}
      {run.state === 'awaiting_clarification' && run.artifacts.questions.length > 0 && (
        <ClarificationModal run={run} />
      )}
    </div>
  );
}
