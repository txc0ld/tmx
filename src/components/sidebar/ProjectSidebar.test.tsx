import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// themeStore reads localStorage at module init; happy-dom's stub in this
// version doesn't expose `getItem`. Mock to the minimal surface ProjectSidebar
// touches (just `getActiveTheme()` for the new-project flow, which we don't
// trigger from these tests, but the import path needs to resolve).
vi.mock('@/stores/themeStore', () => {
  const theme = { id: 'mocha', name: 'Mocha', accent: '#cba6f7' };
  return {
    useThemeStore: Object.assign(
      () => theme,
      {
        getState: () => ({ getActiveTheme: () => theme }),
        subscribe: (_fn: () => void) => () => {},
      },
    ),
  };
});

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@/utils/ipc', () => ({
  gitAvailable: () => Promise.resolve(false),
}));

vi.mock('@/utils/projectIcon', () => ({
  resolveProjectIcon: () => Promise.resolve(null),
}));

import {
  ProjectSidebar,
  computeProjectIndicator,
} from './ProjectSidebar';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { PipelineRun, PipelineState, Project } from '@/types';

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Project One',
    icon: 'P',
    color: '#fff',
    description: '',
    cwd: '/tmp/proj-1',
    ...over,
  };
}

function makeRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-default',
    templateId: 'tmpl-anth-trio',
    projectId: 'proj-1',
    worktreePath: '/tmp/wt',
    branch: 'feat/x',
    baseBranch: 'main',
    state: 'building' as PipelineState,
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

afterEach(() => {
  cleanup();
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
});

describe('computeProjectIndicator', () => {

  it('returns none when there are no runs', () => {
    expect(computeProjectIndicator([])).toEqual({ kind: 'none', activeCount: 0 });
  });

  it('returns active with the count of non-terminal runs', () => {
    const runs = [
      makeRun({ id: 'a', state: 'building' }),
      makeRun({ id: 'b', state: 'planning' }),
      makeRun({ id: 'c', state: 'done' }), // terminal — excluded
    ];
    expect(computeProjectIndicator(runs)).toEqual({ kind: 'active', activeCount: 2 });
  });

  it('returns unviewed-failed when at least one terminal failed run is unviewed', () => {
    const runs = [makeRun({ id: 'oops', state: 'failed' })];
    expect(computeProjectIndicator(runs)).toEqual({
      kind: 'unviewed-failed',
      activeCount: 0,
    });
  });

  it('unviewed-failed wins over active when both are present', () => {
    const runs = [
      makeRun({ id: 'live', state: 'building' }),
      makeRun({ id: 'oops', state: 'failed' }),
    ];
    expect(computeProjectIndicator(runs)).toEqual({
      kind: 'unviewed-failed',
      activeCount: 1,
    });
  });

  it('viewed terminal runs do not surface a red indicator', () => {
    const runs = [makeRun({ id: 'oops', state: 'failed' })];
    expect(
      computeProjectIndicator(runs, () => true /* always viewed */),
    ).toEqual({ kind: 'none', activeCount: 0 });
  });

  it('escalated counts as failed for the indicator', () => {
    const runs = [makeRun({ id: 'esc', state: 'escalated' })];
    expect(computeProjectIndicator(runs)).toEqual({
      kind: 'unviewed-failed',
      activeCount: 0,
    });
  });
});

describe('ProjectSidebar indicator', () => {
  it('renders no indicator when the project has zero runs', () => {
    const projects = [makeProject({ id: 'p1' })];
    render(
      <ProjectSidebar
        projects={projects}
        active="p1"
        onSelect={() => {}}
        runs={{}}
      />,
    );
    expect(screen.queryByTestId('project-sidebar-indicator-p1')).toBeNull();
  });

  it('renders an active dot when the project has an in-flight run', () => {
    const projects = [makeProject({ id: 'p1' })];
    const run = makeRun({ projectId: 'p1', state: 'planning' });
    render(
      <ProjectSidebar
        projects={projects}
        active="p1"
        onSelect={() => {}}
        runs={{ [run.id]: run }}
      />,
    );
    const dot = screen.getByTestId('project-sidebar-indicator-p1');
    expect(dot.getAttribute('data-indicator-kind')).toBe('active');
  });

  it('renders a red dot for unviewed failed runs', () => {
    const projects = [makeProject({ id: 'p1' })];
    const run = makeRun({ projectId: 'p1', state: 'failed' });
    render(
      <ProjectSidebar
        projects={projects}
        active="p1"
        onSelect={() => {}}
        runs={{ [run.id]: run }}
      />,
    );
    const dot = screen.getByTestId('project-sidebar-indicator-p1');
    expect(dot.getAttribute('data-indicator-kind')).toBe('unviewed-failed');
  });

  it('renders separate indicators per project', () => {
    const projects = [
      makeProject({ id: 'p1' }),
      makeProject({ id: 'p2', name: 'Project Two', icon: 'T' }),
    ];
    const runs: Record<string, PipelineRun> = {
      r1: makeRun({ id: 'r1', projectId: 'p1', state: 'building' }),
      r2: makeRun({ id: 'r2', projectId: 'p2', state: 'failed' }),
    };
    render(
      <ProjectSidebar
        projects={projects}
        active="p1"
        onSelect={() => {}}
        runs={runs}
      />,
    );
    expect(
      screen.getByTestId('project-sidebar-indicator-p1').getAttribute('data-indicator-kind'),
    ).toBe('active');
    expect(
      screen.getByTestId('project-sidebar-indicator-p2').getAttribute('data-indicator-kind'),
    ).toBe('unviewed-failed');
  });

  it('tooltip mentions the active count', () => {
    const projects = [makeProject({ id: 'p1' })];
    const runs = {
      a: makeRun({ id: 'a', projectId: 'p1', state: 'building' }),
      b: makeRun({ id: 'b', projectId: 'p1', state: 'planning' }),
    };
    render(
      <ProjectSidebar
        projects={projects}
        active="p1"
        onSelect={() => {}}
        runs={runs}
      />,
    );
    const icon = screen.getByTestId('project-sidebar-icon-p1');
    expect(icon.getAttribute('title')).toContain('2 pipeline runs active');
  });
});
