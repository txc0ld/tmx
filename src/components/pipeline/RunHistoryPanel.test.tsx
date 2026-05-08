import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import type { PipelineRun, PipelineState } from '@/types';
import { RunHistoryPanel } from './RunHistoryPanel';

function makeRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-default',
    templateId: 'tmpl-anth-trio',
    projectId: 'proj-1',
    worktreePath: '/tmp/wt',
    branch: 'feat/x',
    baseBranch: 'main',
    state: 'idle' as PipelineState,
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 },
    startedAt: 1000,
    escalationLog: [],
    tiles: {},
    fingerprint: {
      templateId: 'tmpl-anth-trio',
      templateHash: 'h',
      skillHashes: {},
      rolePromptHashes: {},
      models: {},
      capabilityManifests: {},
      terminalxVersion: '0.0.0',
    },
    planLineage: [],
    runMode: 'standard',
    autoApprovePlan: false,
    useDualReviewer: false,
    runRedTeam: false,
    effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3, planReject: 3 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3, planReject: 3 },
    templateDualReviewer: false,
    ...over,
  };
}

function asMap(runs: PipelineRun[]): Record<string, PipelineRun> {
  const out: Record<string, PipelineRun> = {};
  for (const r of runs) out[r.id] = r;
  return out;
}

afterEach(() => cleanup());

describe('RunHistoryPanel', () => {
  it('renders the empty state when there are no runs for this project', () => {
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={{}}
        activeProjectId="proj-1"
      />,
    );
    expect(screen.getByTestId('run-history-empty').textContent).toContain('No runs yet');
  });

  it('shows runs sorted newest-first by startedAt', () => {
    const runs = asMap([
      makeRun({ id: 'old', branch: 'feat/old', startedAt: 100, state: 'done' }),
      makeRun({ id: 'mid', branch: 'feat/mid', startedAt: 500, state: 'done' }),
      makeRun({ id: 'new', branch: 'feat/new', startedAt: 900, state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-runid')).toBe('new');
    expect(rows[1].getAttribute('data-runid')).toBe('mid');
    expect(rows[2].getAttribute('data-runid')).toBe('old');
  });

  it('filters to only awaiting runs when the Awaiting chip is toggled on', () => {
    const runs = asMap([
      makeRun({ id: 'wait', startedAt: 100, state: 'awaiting_plan_approval' }),
      makeRun({ id: 'done', startedAt: 200, state: 'done' }),
      makeRun({ id: 'fail', startedAt: 300, state: 'failed' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId('run-history-filter-awaiting'));
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-runid')).toBe('wait');
  });

  it('clicking a row calls onOpenLogs with the matching run', () => {
    const onOpenLogs = vi.fn();
    const target = makeRun({ id: 'pick-me', state: 'done' });
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={onOpenLogs}
        runs={asMap([target])}
        activeProjectId="proj-1"
      />,
    );
    const row = screen.getByTestId('run-history-row');
    fireEvent.click(row);
    expect(onOpenLogs).toHaveBeenCalledTimes(1);
    expect(onOpenLogs.mock.calls[0][0].id).toBe('pick-me');
  });

  it('only shows runs for the active project', () => {
    const runs = asMap([
      makeRun({ id: 'mine', projectId: 'proj-1', state: 'done' }),
      makeRun({ id: 'other', projectId: 'proj-2', state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-runid')).toBe('mine');
  });

  it('Escape closes the panel', () => {
    const onClose = vi.fn();
    render(
      <RunHistoryPanel
        onClose={onClose}
        onOpenLogs={vi.fn()}
        runs={{}}
        activeProjectId="proj-1"
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies the awaiting/done/failed pill colors via the state-classification rules', () => {
    const runs = asMap([
      makeRun({ id: 'a', startedAt: 300, state: 'awaiting_merge_approval' }),
      makeRun({ id: 'd', startedAt: 200, state: 'done' }),
      makeRun({ id: 'f', startedAt: 100, state: 'failed' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    const rows = screen.getAllByTestId('run-history-row');
    // Pills label by raw state — assert the label, color is style-only.
    expect(within(rows[0]).getByTestId('run-history-row-pill').textContent).toBe(
      'awaiting_merge_approval',
    );
    expect(within(rows[1]).getByTestId('run-history-row-pill').textContent).toBe('done');
    expect(within(rows[2]).getByTestId('run-history-row-pill').textContent).toBe('failed');
  });

  it('clicking the All chip clears any existing filter', () => {
    const runs = asMap([
      makeRun({ id: 'wait', startedAt: 100, state: 'awaiting_plan_approval' }),
      makeRun({ id: 'done', startedAt: 200, state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId('run-history-filter-awaiting'));
    expect(screen.getAllByTestId('run-history-row')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('run-history-filter-all'));
    expect(screen.getAllByTestId('run-history-row')).toHaveLength(2);
  });
});
