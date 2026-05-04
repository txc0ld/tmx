import { usePipelineStore } from '@/stores/pipelineStore';
import type { PipelineControllerTile as Tile } from '@/types';

const EMPTY_RUN_PLACEHOLDER = '—';

interface Props {
  tile: Tile;
}

export function PipelineControllerTile({ tile }: Props) {
  const run = usePipelineStore(s => s.runs[tile.runId]);
  const dispatch = usePipelineStore(s => s.dispatch);
  const removeRun = usePipelineStore(s => s.removeRun);

  if (!run) {
    return (
      <div style={{ padding: 12, color: 'var(--tx-text-muted)' }}>
        No run bound (runId={tile.runId || EMPTY_RUN_PLACEHOLDER}).
      </div>
    );
  }

  const isTerminal = run.state === 'done' || run.state === 'failed' || run.state === 'escalated';

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
            onClick={() => dispatch(run.id, { type: 'start' })}
            style={{ padding: '4px 10px', background: 'var(--tx-accent)', color: 'var(--tx-text)' }}
          >
            Start
          </button>
        )}
        {!isTerminal && (
          <button
            onClick={() => dispatch(run.id, { type: 'abort', reason: 'user clicked abort' })}
            style={{ padding: '4px 10px', background: 'var(--tx-surface-2)', color: 'var(--tx-text)' }}
          >
            Abort
          </button>
        )}
        {isTerminal && (
          <button
            onClick={() => removeRun(run.id)}
            style={{ padding: '4px 10px', background: 'var(--tx-surface-2)', color: 'var(--tx-text)' }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
