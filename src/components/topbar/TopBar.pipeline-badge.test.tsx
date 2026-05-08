import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PipelineButton } from './TopBar';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { PipelineRun, PipelineState, Project } from '@/types';

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test',
    description: '',
    cwd: '/tmp/tx-proj-1',
    color: '#ffffff',
    icon: '',
    ...over,
  };
}

function makeRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-1',
    templateId: 'tmpl-anth-trio',
    projectId: 'proj-1',
    worktreePath: '/tmp/wt/run-1',
    branch: 'feat/run-1',
    baseBranch: 'main',
    state: 'awaiting_plan_approval' as PipelineState,
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 },
    startedAt: 100,
    escalationLog: [],
    tiles: { controller: 'tile-controller-1' },
    fingerprint: {
      templateId: 'tmpl-anth-trio',
      templateHash: 'h',
      skillHashes: {},
      rolePromptHashes: {},
      models: {},
      capabilityManifests: {},
      terminalxVersion: '0.1.0',
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

function seedRuns(runs: PipelineRun[]) {
  const map: Record<string, PipelineRun> = {};
  for (const r of runs) map[r.id] = r;
  usePipelineStore.setState({ runs: map, activeRunIds: runs.map(r => r.id) });
}

function resetStore() {
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
}

describe('PipelineButton attention badge', () => {
  beforeEach(() => {
    resetStore();
  });

  it('renders no badge when zero pending runs', () => {
    const project = makeProject();
    const onStart = vi.fn();
    render(<PipelineButton project={project} onStartPipelineRun={onStart} />);

    expect(screen.queryByTestId('topbar-pipeline-badge')).toBeNull();
    // Title now includes the keyboard shortcut hint (Ctrl+Shift+P on
    // non-mac, ⌘⇧P on mac). The test runs in happy-dom which doesn't
    // simulate macOS, so isMac() returns false → "Ctrl+Shift+P".
    expect(screen.getByTestId('topbar-pipeline-button').getAttribute('title')).toBe(
      'Start a pipeline run (Plan → Build → Review) (Ctrl+Shift+P)',
    );
  });

  it('renders badge with count and attention tooltip when pending runs exist', () => {
    const project = makeProject();
    seedRuns([
      makeRun({ id: 'r1', state: 'awaiting_plan_approval' }),
      makeRun({ id: 'r2', state: 'awaiting_merge_approval', startedAt: 200 }),
      makeRun({ id: 'r3', state: 'building', startedAt: 300 }), // not awaiting → excluded
    ]);
    const onStart = vi.fn();
    render(<PipelineButton project={project} onStartPipelineRun={onStart} />);

    const badge = screen.getByTestId('topbar-pipeline-badge');
    expect(badge.textContent).toBe('2');
    expect(screen.getByTestId('topbar-pipeline-button').getAttribute('title')).toBe(
      '2 runs need attention',
    );
  });

  it('clicking with pending runs focuses the most recent run\'s controller tile (DI)', () => {
    const project = makeProject();
    seedRuns([
      makeRun({ id: 'r-old', startedAt: 100, tiles: { controller: 'tile-old' } }),
      makeRun({ id: 'r-new', startedAt: 500, tiles: { controller: 'tile-new' } }),
    ]);
    const onStart = vi.fn();
    const setFocusedTile = vi.fn();
    const bringToFront = vi.fn();
    render(
      <PipelineButton
        project={project}
        onStartPipelineRun={onStart}
        deps={{ getCanvasStore: () => ({ setFocusedTile, bringToFront }) }}
      />,
    );

    fireEvent.click(screen.getByTestId('topbar-pipeline-button'));

    expect(onStart).not.toHaveBeenCalled();
    expect(bringToFront).toHaveBeenCalledWith('tile-new');
    expect(setFocusedTile).toHaveBeenCalledWith('tile-new');
  });

  it('clicking with no pending runs opens the launch modal', () => {
    const project = makeProject();
    const onStart = vi.fn();
    const setFocusedTile = vi.fn();
    const bringToFront = vi.fn();
    render(
      <PipelineButton
        project={project}
        onStartPipelineRun={onStart}
        deps={{ getCanvasStore: () => ({ setFocusedTile, bringToFront }) }}
      />,
    );

    fireEvent.click(screen.getByTestId('topbar-pipeline-button'));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(setFocusedTile).not.toHaveBeenCalled();
    expect(bringToFront).not.toHaveBeenCalled();
  });

  it('falls back to launch modal when pending run has no controller tile', () => {
    const project = makeProject();
    seedRuns([
      makeRun({ id: 'r1', state: 'awaiting_plan_approval', tiles: {} }),
    ]);
    const onStart = vi.fn();
    const setFocusedTile = vi.fn();
    const bringToFront = vi.fn();
    render(
      <PipelineButton
        project={project}
        onStartPipelineRun={onStart}
        deps={{ getCanvasStore: () => ({ setFocusedTile, bringToFront }) }}
      />,
    );

    fireEvent.click(screen.getByTestId('topbar-pipeline-button'));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(setFocusedTile).not.toHaveBeenCalled();
  });

  it('filters by active project — runs on other projects do not count', () => {
    const project = makeProject({ id: 'proj-1' });
    seedRuns([
      makeRun({ id: 'mine', projectId: 'proj-1', state: 'awaiting_plan_approval' }),
      makeRun({ id: 'theirs', projectId: 'proj-2', state: 'awaiting_merge_approval' }),
    ]);
    const onStart = vi.fn();
    render(<PipelineButton project={project} onStartPipelineRun={onStart} />);

    expect(screen.getByTestId('topbar-pipeline-badge').textContent).toBe('1');
  });

  it('renders no badge when project is undefined', () => {
    seedRuns([makeRun({ state: 'awaiting_plan_approval' })]);
    const onStart = vi.fn();
    render(<PipelineButton project={undefined} onStartPipelineRun={onStart} />);

    expect(screen.queryByTestId('topbar-pipeline-badge')).toBeNull();
  });
});
