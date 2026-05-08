import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { PipelineRun, PlanArtifact, RunFingerprint } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';
import { initialRunState } from '@/pipeline/state-machine';
import { PlanPreviewModal } from './PlanPreviewModal';

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

function makeRun(plan: PlanArtifact | null = makePlan(), worktreePath = '/tmp/wt'): PipelineRun {
  const run = initialRunState({
    runId: 'run-test',
    templateId: 'tpl',
    projectId: 'proj',
    worktreePath,
    branch: 'feat/x',
    fingerprint: fakeFingerprint,
  });
  return {
    ...run,
    state: 'awaiting_plan_approval',
    artifacts: { ...run.artifacts, plan: plan ?? undefined },
  };
}

beforeEach(() => {
  // Seed the store with the run so dispatch() lands on a real entry.
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
});

afterEach(() => {
  cleanup();
});

describe('PlanPreviewModal', () => {
  it('renders heading + button row when given a plan', async () => {
    const run = makeRun();
    usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
    const readFileText = vi.fn().mockResolvedValue('# My plan\n\nbody text');

    render(
      <PlanPreviewModal run={run} onClose={vi.fn()} readFileText={readFileText} />,
    );

    expect(screen.getByText('Review plan')).toBeTruthy();
    expect(screen.getByTestId('plan-preview-approve')).toBeTruthy();
    expect(screen.getByTestId('plan-preview-cancel')).toBeTruthy();
    // Wait for read to resolve so the heading parses out of the markdown.
    await waitFor(() => {
      expect(screen.getByTestId('plan-preview-content')).toBeTruthy();
    });
    // # heading rendered as <h1>.
    expect(screen.getByRole('heading', { level: 1, name: 'My plan' })).toBeTruthy();
  });

  it('calls readFileText with worktreePath + planPath', async () => {
    const run = makeRun(
      makePlan({ planPath: 'docs/plans/2026-05-09-foo.md' }),
      '/Users/x/proj',
    );
    usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
    const readFileText = vi.fn().mockResolvedValue('plan body');

    render(
      <PlanPreviewModal run={run} onClose={vi.fn()} readFileText={readFileText} />,
    );

    await waitFor(() => {
      expect(readFileText).toHaveBeenCalledTimes(1);
    });
    expect(readFileText).toHaveBeenCalledWith('/Users/x/proj/docs/plans/2026-05-09-foo.md');
  });

  it('Approve button dispatches approve_plan and calls onClose', async () => {
    const run = makeRun();
    usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
    const onClose = vi.fn();
    const readFileText = vi.fn().mockResolvedValue('body');

    render(
      <PlanPreviewModal run={run} onClose={onClose} readFileText={readFileText} />,
    );

    fireEvent.click(screen.getByTestId('plan-preview-approve'));

    expect(onClose).toHaveBeenCalledTimes(1);
    // Reducer transitions awaiting_plan_approval → building on approve_plan.
    expect(usePipelineStore.getState().runs[run.id].state).toBe('building');
  });

  it('Cancel button calls onClose and does NOT advance the run', async () => {
    const run = makeRun();
    usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
    const onClose = vi.fn();
    const readFileText = vi.fn().mockResolvedValue('body');

    render(
      <PlanPreviewModal run={run} onClose={onClose} readFileText={readFileText} />,
    );

    fireEvent.click(screen.getByTestId('plan-preview-cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
    // Run state unchanged.
    expect(usePipelineStore.getState().runs[run.id].state).toBe('awaiting_plan_approval');
  });

  it('Escape key calls onClose without dispatching', async () => {
    const run = makeRun();
    usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
    const onClose = vi.fn();
    const readFileText = vi.fn().mockResolvedValue('body');

    render(
      <PlanPreviewModal run={run} onClose={onClose} readFileText={readFileText} />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(usePipelineStore.getState().runs[run.id].state).toBe('awaiting_plan_approval');
  });

  it('shows the loading state while readFileText is in flight', () => {
    const run = makeRun();
    usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
    // Returns a never-resolving promise so the loading state persists.
    const readFileText = vi.fn().mockReturnValue(new Promise<string>(() => {}));

    render(
      <PlanPreviewModal run={run} onClose={vi.fn()} readFileText={readFileText} />,
    );

    expect(screen.getByTestId('plan-preview-loading')).toBeTruthy();
    expect(screen.queryByTestId('plan-preview-content')).toBeNull();
    expect(screen.queryByTestId('plan-preview-error')).toBeNull();
  });

  it('shows the error state when readFileText rejects', async () => {
    const run = makeRun();
    usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
    const readFileText = vi
      .fn()
      .mockRejectedValue(new Error('forbidden path /tmp/wt/docs/plan.md'));

    render(
      <PlanPreviewModal run={run} onClose={vi.fn()} readFileText={readFileText} />,
    );

    const err = await screen.findByTestId('plan-preview-error');
    expect(err.textContent).toContain('forbidden path /tmp/wt/docs/plan.md');
    expect(screen.queryByTestId('plan-preview-content')).toBeNull();
  });

  it('disables the Approve button and shows the no-plan body when plan is missing', () => {
    const run = makeRun(null);
    usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
    const readFileText = vi.fn().mockResolvedValue('body');

    render(
      <PlanPreviewModal run={run} onClose={vi.fn()} readFileText={readFileText} />,
    );

    const approve = screen.getByTestId('plan-preview-approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByTestId('plan-preview-no-plan')).toBeTruthy();
    // No read attempted when there's no plan path to read from.
    expect(readFileText).not.toHaveBeenCalled();
  });
});
