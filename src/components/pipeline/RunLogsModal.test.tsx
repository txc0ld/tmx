import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { PipelineRun, PlanArtifact, RunFingerprint, PipelineState } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';
import { initialRunState } from '@/pipeline/state-machine';
import { RunLogsModal } from './RunLogsModal';

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

    render(
      <RunLogsModal
        run={run}
        projectDir="/Users/me/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={vi.fn()}
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

    render(
      <RunLogsModal
        run={run}
        projectDir="/Users/me/proj"
        onClose={vi.fn()}
        readFileText={readFileText}
        openShell={openShell}
      />,
    );

    fireEvent.click(screen.getByTestId('run-logs-tab-bundle'));
    fireEvent.click(screen.getByTestId('run-logs-bundle-reveal'));

    await waitFor(() => {
      expect(openShell).toHaveBeenCalledWith('/Users/me/proj/.terminalx/failure-bundles');
    });
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
