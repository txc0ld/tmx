import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import {
  PipelineOnboardingTooltip,
  dismissPipelineOnboarding,
} from './PipelineOnboardingTooltip';
import {
  _resetHealthCheckCacheForTest,
  _setHealthProbeForTest,
} from '@/hooks/useHealthCheck';
import type { HealthReport } from '@/utils/ipc';
import { useProjectStore } from '@/stores/projectStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { Project, PipelineRun, PipelineState } from '@/types';

const ALL_GOOD: HealthReport = {
  claude: true,
  codex: true,
  gemini: true,
  gitInstalled: true,
};

/**
 * happy-dom 20+ ships a stubbed `localStorage` (no methods) unless launched
 * with `--localstorage-file=memory`. This tooltip persists a "seen" flag so
 * we install a real in-memory impl. Mirrors `WelcomeBanner.test.tsx`.
 */
function installMemoryLocalStorage(): () => void {
  const original = window.localStorage;
  const data = new Map<string, string>();
  const stub = {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
  } as Storage;
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true });
  return () => {
    Object.defineProperty(window, 'localStorage', { value: original, configurable: true });
  };
}

function makeProject(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    icon: '🚀',
    color: '#abcdef',
    description: '',
    cwd: '/tmp/' + id,
  } as unknown as Project;
}

function makeRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-1',
    templateId: 'tmpl-anth-trio',
    projectId: 'proj-1',
    worktreePath: '/tmp/wt/run-1',
    branch: 'feat/run-1',
    baseBranch: 'main',
    state: 'planning' as PipelineState,
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 },
    startedAt: 100,
    escalationLog: [],
    tiles: {},
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

function setProjects(projects: Project[]): void {
  useProjectStore.setState({ projects, active: projects[0]?.id ?? '' });
}

function resetPipelineRuns(): void {
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
}

/** Wait for the IPC-driven health probe to land + the 50ms fade-in tick. */
async function waitForFadeIn(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 80));
  });
}

describe('PipelineOnboardingTooltip', () => {
  let restoreLocalStorage: () => void;

  beforeEach(() => {
    restoreLocalStorage = installMemoryLocalStorage();
    _resetHealthCheckCacheForTest();
    setProjects([]);
    resetPipelineRuns();
  });

  afterEach(() => {
    _setHealthProbeForTest(null);
    _resetHealthCheckCacheForTest();
    setProjects([]);
    resetPipelineRuns();
    restoreLocalStorage();
  });

  it('renders when all conditions are met', async () => {
    setProjects([makeProject('p1')]);
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    render(<PipelineOnboardingTooltip />);

    // Health probe is async — wait for it to resolve before asserting.
    await waitFor(() => {
      expect(screen.queryByTestId('pipeline-onboarding-tooltip')).not.toBeNull();
    });
    const tooltip = screen.getByTestId('pipeline-onboarding-tooltip');
    expect(tooltip.textContent).toMatch(/Plan→Build→Reviewer|Planner.*Builder.*Reviewer/i);
    expect(screen.getByTestId('pipeline-onboarding-dismiss').textContent).toBe('Got it');
  });

  it('hidden when localStorage flag is set', async () => {
    setProjects([makeProject('p1')]);
    localStorage.setItem('tx-pipeline-onboarding-seen', '1');
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    render(<PipelineOnboardingTooltip />);

    // Even after waiting for the health probe / fade tick, the tooltip
    // should never render because the seen flag is set.
    await waitForFadeIn();
    expect(screen.queryByTestId('pipeline-onboarding-tooltip')).toBeNull();
  });

  it('hidden when there are zero projects (WelcomeBanner takes over)', async () => {
    // setProjects([]) is the default in beforeEach — explicit for clarity.
    setProjects([]);
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    render(<PipelineOnboardingTooltip />);

    await waitForFadeIn();
    expect(screen.queryByTestId('pipeline-onboarding-tooltip')).toBeNull();
  });

  it('hidden when claude is missing from health check', async () => {
    setProjects([makeProject('p1')]);
    _setHealthProbeForTest(() => Promise.resolve({ ...ALL_GOOD, claude: false }));
    render(<PipelineOnboardingTooltip />);

    await waitForFadeIn();
    expect(screen.queryByTestId('pipeline-onboarding-tooltip')).toBeNull();
  });

  it('hidden when at least one pipeline run exists', async () => {
    setProjects([makeProject('p1')]);
    usePipelineStore.setState({
      runs: { 'run-1': makeRun({ id: 'run-1' }) },
      activeRunIds: ['run-1'],
    });
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    render(<PipelineOnboardingTooltip />);

    await waitForFadeIn();
    expect(screen.queryByTestId('pipeline-onboarding-tooltip')).toBeNull();
  });

  it('clicking "Got it" persists the flag and hides the tooltip', async () => {
    setProjects([makeProject('p1')]);
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    render(<PipelineOnboardingTooltip />);

    await waitFor(() => {
      expect(screen.queryByTestId('pipeline-onboarding-tooltip')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('pipeline-onboarding-dismiss'));

    expect(localStorage.getItem('tx-pipeline-onboarding-seen')).toBe('1');
    expect(screen.queryByTestId('pipeline-onboarding-tooltip')).toBeNull();
  });

  it('parent calling dismissPipelineOnboarding() auto-dismisses the visible tooltip', async () => {
    setProjects([makeProject('p1')]);
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    render(<PipelineOnboardingTooltip />);

    await waitFor(() => {
      expect(screen.queryByTestId('pipeline-onboarding-tooltip')).not.toBeNull();
    });

    // Simulate the parent (PipelineButton click handler) calling the
    // imperative dismiss — the tooltip should hide and the flag should
    // persist for the next session.
    act(() => {
      dismissPipelineOnboarding();
    });

    expect(localStorage.getItem('tx-pipeline-onboarding-seen')).toBe('1');
    expect(screen.queryByTestId('pipeline-onboarding-tooltip')).toBeNull();
  });

  it('persisted dismiss survives re-mount', async () => {
    setProjects([makeProject('p1')]);
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    const { unmount } = render(<PipelineOnboardingTooltip />);

    await waitFor(() => {
      expect(screen.queryByTestId('pipeline-onboarding-tooltip')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('pipeline-onboarding-dismiss'));
    unmount();

    // Fresh mount — same conditions met but flag is now persisted.
    render(<PipelineOnboardingTooltip />);
    await waitForFadeIn();
    expect(screen.queryByTestId('pipeline-onboarding-tooltip')).toBeNull();
  });
});
