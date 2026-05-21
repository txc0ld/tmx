import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { PipelineRun, PlanArtifact, RunFingerprint, PipelineState } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';
import { initialRunState } from '@/pipeline/state-machine';
import type { FailureBundleSummary } from '@/utils/ipc';
import { RunLogsModal } from './RunLogsModal';

/**
 * Default summary stub used when a test doesn't care about the
 * specifics of the inline bundle summary panel — keeps the existing
 * Failure-bundle tab assertions (path + Reveal button) free of
 * unrelated bundle-summary noise.
 */
function makeSummary(overrides: Partial<FailureBundleSummary> = {}): FailureBundleSummary {
  return {
    bytes: 1024,
    telemetry_line_count: 0,
    last_events: [],
    run_state: null,
    failure_reason: null,
    retry_counters: {},
    git_status: '',
    artifacts_present: false,
    ...overrides,
  };
}

const fakeFingerprint: RunFingerprint = {
  templateId: 'tpl',
  templateHash: 'h',
  skillHashes: {},
  rolePromptHashes: {},
  models: {},
  capabilityManifests: {},
  terminalxVersion: '0.0.0',
};

function makePlan(overrides: Partial<PlanArtifact> = {}): PlanArtifact {
  return {
    stage: 'planner',
    branch: 'feat/x',
    specPath: 'docs/spec.md',
    planPath: 'docs/plan.md',
    tasks: [],
    summary: 'Add a thing',
    planCommitSha: 'a'.repeat(40),
    confidence: 'verified',
    ...overrides,
  };
}

function makeRun(opts: {
  state?: PipelineState;
  plan?: PlanArtifact | null;
  worktreePath?: string;
} = {}): PipelineRun {
  const base = initialRunState({
    runId: 'run-test',
    templateId: 'tpl',
    projectId: 'proj',
    worktreePath: opts.worktreePath ?? '/tmp/wt',
    branch: 'feat/x',
    fingerprint: fakeFingerprint,
  });
  const plan = opts.plan === undefined ? makePlan() : opts.plan;
  return {
    ...base,
    state: opts.state ?? 'idle',
    artifacts: { ...base.artifacts, plan: plan ?? undefined },
  };
}

beforeEach(() => {
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
});

afterEach(() => {
  cleanup();
});

describe('RunLogsModal', () => {
  it('renders three tabs and disables the failure-bundle tab when state is not terminal-failed', () => {
    const run = makeRun({ state: 'idle' });
    const readFileText = vi.fn().mockResolvedValue('');

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    expect(screen.getByTestId('run-logs-tab-telemetry')).toBeTruthy();
    expect(screen.getByTestId('run-logs-tab-plan')).toBeTruthy();
    const bundleTab = screen.getByTestId('run-logs-tab-bundle') as HTMLButtonElement;
    expect(bundleTab.disabled).toBe(true);
  });

  it('enables the failure-bundle tab when the run is in `failed`', () => {
    const run = makeRun({ state: 'failed' });
    const readFileText = vi.fn().mockResolvedValue('');

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    const bundleTab = screen.getByTestId('run-logs-tab-bundle') as HTMLButtonElement;
    expect(bundleTab.disabled).toBe(false);
  });

  it('enables the failure-bundle tab when the run is in `escalated`', () => {
    const run = makeRun({ state: 'escalated' });
    const readFileText = vi.fn().mockResolvedValue('');

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    const bundleTab = screen.getByTestId('run-logs-tab-bundle') as HTMLButtonElement;
    expect(bundleTab.disabled).toBe(false);
  });

  it('Telemetry tab calls readFileText with `<projectDir>/.terminalx/pipeline-telemetry/<runId>.jsonl`', async () => {
    const run = makeRun({ state: 'idle' });
    const readFileText = vi.fn().mockResolvedValue('');

    render(
      <RunLogsModal
        run={run}
        projectDir="/Users/me/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(readFileText).toHaveBeenCalledWith(
        '/Users/me/proj/.terminalx/pipeline-telemetry/run-test.jsonl',
      );
    });
  });

  it('renders one row per JSONL line with newest first', async () => {
    const run = makeRun({ state: 'idle' });
    const lines = [
      JSON.stringify({ at: '2026-05-09T10:00:00Z', event: 'state_change', from: 'idle', to: 'planning' }),
      JSON.stringify({ at: '2026-05-09T10:01:00Z', event: 'capability_install', ok: true }),
      JSON.stringify({ at: '2026-05-09T10:02:00Z', event: 'state_change', from: 'planning', to: 'building' }),
    ].join('\n');
    const readFileText = vi.fn().mockResolvedValue(lines);

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('run-logs-telemetry-row')).toHaveLength(3);
    });
    const rows = screen.getAllByTestId('run-logs-telemetry-row');
    // Newest first.
    expect(rows[0].textContent).toContain('2026-05-09T10:02:00Z');
    expect(rows[2].textContent).toContain('2026-05-09T10:00:00Z');
  });

  it('search box filters telemetry rows by substring', async () => {
    const run = makeRun({ state: 'idle' });
    const lines = [
      JSON.stringify({ at: 't1', event: 'state_change', to: 'planning' }),
      JSON.stringify({ at: 't2', event: 'capability_install' }),
      JSON.stringify({ at: 't3', event: 'guardrails_install' }),
    ].join('\n');
    const readFileText = vi.fn().mockResolvedValue(lines);

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('run-logs-telemetry-row')).toHaveLength(3);
    });

    fireEvent.change(screen.getByTestId('run-logs-search'), {
      target: { value: 'capability' },
    });

    const rows = screen.getAllByTestId('run-logs-telemetry-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('capability_install');
  });

  it('Plan/Spec tab calls readFileText with planPath AND specPath rooted at worktree', async () => {
    const run = makeRun({
      state: 'idle',
      worktreePath: '/Users/x/proj',
      plan: makePlan({ planPath: 'docs/plans/2026-05-09-foo.md', specPath: 'docs/spec-foo.md' }),
    });
    const readFileText = vi.fn().mockResolvedValue('# heading\n\nbody');

    render(
      <RunLogsModal
        run={run}
        projectDir="/Users/x/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('run-logs-tab-plan'));

    await waitFor(() => {
      expect(readFileText).toHaveBeenCalledWith('/Users/x/proj/docs/plans/2026-05-09-foo.md');
      expect(readFileText).toHaveBeenCalledWith('/Users/x/proj/docs/spec-foo.md');
    });
    expect(screen.getByTestId('run-logs-plan-pane')).toBeTruthy();
    expect(screen.getByTestId('run-logs-spec-pane')).toBeTruthy();
  });

  it('Plan/Spec tab shows the missing-plan body when no plan artifact exists', () => {
    const run = makeRun({ state: 'idle', plan: null });
    const readFileText = vi.fn().mockResolvedValue('');

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('run-logs-tab-plan'));

    expect(screen.getByTestId('run-logs-plan-missing')).toBeTruthy();
  });

  it('Failure bundle tab shows tarball path when run.state === failed', () => {
    const run = makeRun({ state: 'failed' });
    const readFileText = vi.fn().mockResolvedValue('');
    const bundleSummary = vi.fn().mockResolvedValue(makeSummary());

    render(
      <RunLogsModal
        run={run}
        projectDir="/Users/me/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
        bundleSummary={bundleSummary}
      />,
    );

    fireEvent.click(screen.getByTestId('run-logs-tab-bundle'));

    const path = screen.getByTestId('run-logs-bundle-path');
    expect(path.textContent).toBe('/Users/me/proj/.terminalx/failure-bundles/run-test.tar.gz');
    expect(screen.getByTestId('run-logs-bundle-reveal')).toBeTruthy();
  });

  it('Reveal button calls openShell with the failure-bundle parent dir', async () => {
    const run = makeRun({ state: 'failed' });
    const readFileText = vi.fn().mockResolvedValue('');
    const openShell = vi.fn().mockResolvedValue(undefined);
    const bundleSummary = vi.fn().mockResolvedValue(makeSummary());

    render(
      <RunLogsModal
        run={run}
        projectDir="/Users/me/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={openShell}
        bundleSummary={bundleSummary}
      />,
    );

    fireEvent.click(screen.getByTestId('run-logs-tab-bundle'));
    fireEvent.click(screen.getByTestId('run-logs-bundle-reveal'));

    await waitFor(() => {
      expect(openShell).toHaveBeenCalledWith('/Users/me/proj/.terminalx/failure-bundles');
    });
  });

  it('Failure bundle tab calls bundleSummary with the tarball path on activation', async () => {
    const run = makeRun({ state: 'failed' });
    const readFileText = vi.fn().mockResolvedValue('');
    const bundleSummary = vi.fn().mockResolvedValue(makeSummary());

    render(
      <RunLogsModal
        run={run}
        projectDir="/Users/me/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
        bundleSummary={bundleSummary}
      />,
    );

    fireEvent.click(screen.getByTestId('run-logs-tab-bundle'));

    await waitFor(() => {
      expect(bundleSummary).toHaveBeenCalledWith(
        '/Users/me/proj/.terminalx/failure-bundles/run-test.tar.gz',
      );
    });
  });

  it('Failure bundle tab renders size, telemetry count, run state, retry counters, last events, and git status', async () => {
    const run = makeRun({ state: 'failed' });
    const readFileText = vi.fn().mockResolvedValue('');
    const summary = makeSummary({
      bytes: 4096,
      telemetry_line_count: 12,
      last_events: ['state_change@t1', 'capability_install@t2', 'merger_invoked@t3'],
      run_state: 'failed',
      failure_reason: 'reviewer_blocker',
      retry_counters: { build: '2', review: '1' },
      git_status: '3 modified, 1 added, 0 deleted, 2 untracked',
      artifacts_present: true,
    });
    const bundleSummary = vi.fn().mockResolvedValue(summary);

    render(
      <RunLogsModal
        run={run}
        projectDir="/Users/me/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
        bundleSummary={bundleSummary}
      />,
    );

    fireEvent.click(screen.getByTestId('run-logs-tab-bundle'));

    const block = await screen.findByTestId('run-logs-bundle-summary');
    expect(block).toBeTruthy();
    expect(screen.getByTestId('run-logs-bundle-summary-size').textContent).toContain('4.0 KB');
    expect(
      screen.getByTestId('run-logs-bundle-summary-telemetry-count').textContent,
    ).toContain('12');
    expect(screen.getByTestId('run-logs-bundle-summary-state').textContent).toContain('failed');
    expect(screen.getByTestId('run-logs-bundle-summary-reason').textContent).toContain(
      'reviewer_blocker',
    );
    expect(screen.getByTestId('run-logs-bundle-summary-retries').textContent).toContain(
      'build=2',
    );
    expect(screen.getByTestId('run-logs-bundle-summary-retries').textContent).toContain(
      'review=1',
    );
    expect(screen.getByTestId('run-logs-bundle-summary-git-status').textContent).toContain(
      '3 modified',
    );
    expect(screen.getAllByTestId('run-logs-bundle-summary-last-event-row')).toHaveLength(3);
    expect(
      screen.queryByTestId('run-logs-bundle-summary-artifacts-missing'),
    ).toBeNull();
  });

  it('Failure bundle tab shows the artifacts-missing footnote when artifacts.json is absent', async () => {
    const run = makeRun({ state: 'failed' });
    const summary = makeSummary({ artifacts_present: false, telemetry_line_count: 1 });
    const bundleSummary = vi.fn().mockResolvedValue(summary);

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={vi.fn().mockResolvedValue('')}
        openShell={vi.fn()}
        bundleSummary={bundleSummary}
      />,
    );
    fireEvent.click(screen.getByTestId('run-logs-tab-bundle'));

    expect(
      await screen.findByTestId('run-logs-bundle-summary-artifacts-missing'),
    ).toBeTruthy();
  });

  it('Failure bundle tab shows the loading state until bundleSummary resolves', async () => {
    const run = makeRun({ state: 'failed' });
    let resolve!: (s: FailureBundleSummary) => void;
    const pending = new Promise<FailureBundleSummary>((r) => {
      resolve = r;
    });
    const bundleSummary = vi.fn().mockReturnValue(pending);

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={vi.fn().mockResolvedValue('')}
        openShell={vi.fn()}
        bundleSummary={bundleSummary}
      />,
    );
    fireEvent.click(screen.getByTestId('run-logs-tab-bundle'));

    expect(screen.getByTestId('run-logs-bundle-summary-loading')).toBeTruthy();

    resolve(makeSummary());
    await waitFor(() => {
      expect(screen.queryByTestId('run-logs-bundle-summary-loading')).toBeNull();
      expect(screen.getByTestId('run-logs-bundle-summary')).toBeTruthy();
    });
  });

  it('Failure bundle tab surfaces the IPC error on summary failure', async () => {
    const run = makeRun({ state: 'failed' });
    const bundleSummary = vi.fn().mockRejectedValue(new Error('open r-test.tar.gz: nope'));

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={vi.fn().mockResolvedValue('')}
        openShell={vi.fn()}
        bundleSummary={bundleSummary}
      />,
    );
    fireEvent.click(screen.getByTestId('run-logs-tab-bundle'));

    const err = await screen.findByTestId('run-logs-bundle-summary-error');
    expect(err.textContent).toContain('nope');
  });

  it('Escape key calls onClose', () => {
    const run = makeRun({ state: 'idle' });
    const onClose = vi.fn();
    const readFileText = vi.fn().mockResolvedValue('');

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={onClose}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Close button calls onClose', () => {
    const run = makeRun({ state: 'idle' });
    const onClose = vi.fn();
    const readFileText = vi.fn().mockResolvedValue('');

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={onClose}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('run-logs-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the error state when telemetry read rejects', async () => {
    const run = makeRun({ state: 'idle' });
    const readFileText = vi
      .fn()
      .mockRejectedValue(new Error('forbidden path /tmp/proj/.terminalx/...'));

    render(
      <RunLogsModal
        run={run}
        projectDir="/tmp/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
      />,
    );

    const err = await screen.findByTestId('run-logs-telemetry-error');
    expect(err.textContent).toContain('forbidden');
  });
});
