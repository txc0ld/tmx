import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Mock IPC before component imports.
vi.mock('@/utils/ipc', () => ({
  pipelineMergerRequestToken: vi.fn(),
  pipelineMergerRun: vi.fn(),
}));

import {
  pipelineMergerRequestToken,
  pipelineMergerRun,
  type MergerResult,
} from '@/utils/ipc';
import { MergerConfirmModal } from './MergerConfirmModal';
import {
  usePipelineStore,
  setPipelineTelemetryEmitter,
  type TelemetryEvent,
} from '@/stores/pipelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { useToastStore } from '@/stores/toastStore';
import type { PipelineRun } from '@/types';

const mockRequestToken = vi.mocked(pipelineMergerRequestToken);
const mockRun = vi.mocked(pipelineMergerRun);

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-test-1',
    templateId: 'tmpl-anth-trio',
    projectId: 'proj-1',
    worktreePath: '/tmp/wt/run-test-1',
    branch: 'feat/r-abc',
    baseBranch: 'main',
    state: 'awaiting_merge_approval',
    artifacts: {
      builds: [
        {
          stage: 'builder',
          branch: 'feat/r-abc',
          headSha: 'abcdef1234567890',
          round: 1,
          commits: [
            { sha: 'aaa1111aaa', subject: 'feat: add foo', files: ['a.ts'] },
            { sha: 'bbb2222bbb', subject: 'fix: tighten bar', files: ['b.ts'] },
          ],
          filesChanged: ['a.ts', 'b.ts'],
          testsAdded: [],
          ciStatus: 'green',
          confidence: 'verified',
        },
      ],
      reviews: [
        {
          stage: 'reviewer',
          reviewer: 'opus',
          verdict: 'approve',
          round: 1,
          comments: [],
          summary: 'looks good to me',
          confidence: 'verified',
        },
        {
          stage: 'reviewer',
          reviewer: 'codex',
          verdict: 'approve',
          round: 1,
          comments: [],
          summary: 'consensus reached',
          confidence: 'verified',
        },
      ],
      ciResults: [],
      questions: [],
    },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 1,
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
    effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3 },
    templateDualReviewer: false,
    ...overrides,
  };
}

function seedStores(run: PipelineRun) {
  usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
  useProjectStore.setState({
    projects: [
      {
        id: 'proj-1',
        name: 'Test',
        icon: '',
        color: '',
        description: '',
        cwd: '/tmp/proj-1',
      },
    ],
    active: 'proj-1',
    loading: false,
    cloning: false,
  } as ReturnType<typeof useProjectStore.getState>);
}

function resetStores() {
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  useToastStore.getState().clearToasts();
}

describe('MergerConfirmModal', () => {
  beforeEach(() => {
    mockRequestToken.mockReset();
    mockRun.mockReset();
    resetStores();
  });

  it('renders headSha, commit subjects, and reviewer verdicts', () => {
    const run = makeRun();
    seedStores(run);

    render(<MergerConfirmModal run={run} />);

    // headSha truncated to 7 chars
    expect(screen.getByText(/abcdef1/)).toBeTruthy();

    // commit subjects
    const commits = screen.getByTestId('merger-modal-commits');
    expect(commits.textContent).toContain('feat: add foo');
    expect(commits.textContent).toContain('fix: tighten bar');

    // reviewer rows
    const reviews = screen.getByTestId('merger-modal-reviews');
    expect(reviews.textContent).toContain('opus');
    expect(reviews.textContent).toContain('looks good to me');
    expect(reviews.textContent).toContain('codex');
    expect(reviews.textContent).toContain('verified'); // confidence badge

    // both shell-command previews are visible
    expect(screen.getByText(/gh pr create --base main --head feat\/r-abc/)).toBeTruthy();
    expect(
      screen.getByText(/git switch main && git merge --no-ff feat\/r-abc/),
    ).toBeTruthy();
  });

  it('Merge click → approve_merge → request token → pipelineMergerRun → merge_done on success', async () => {
    const run = makeRun();
    seedStores(run);

    mockRequestToken.mockResolvedValue('tok-abc');
    const successResult: MergerResult = {
      status: 'success',
      mode: 'pr',
      pr_url: 'https://github.com/x/y/pull/42',
      detail: 'opened pr',
    };
    mockRun.mockResolvedValue(successResult);

    render(<MergerConfirmModal run={run} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('merger-modal-merge'));
    });

    expect(mockRequestToken).toHaveBeenCalledWith('run-test-1');
    expect(mockRun).toHaveBeenCalledWith({
      runId: 'run-test-1',
      projectDir: '/tmp/proj-1',
      branch: 'feat/r-abc',
      baseBranch: 'main',
      confirmToken: 'tok-abc',
    });

    // approve_merge transitioned to merging, then merge_done landed → done
    const finalState = usePipelineStore.getState().runs['run-test-1'].state;
    expect(finalState).toBe('done');

    // success toast surfaced
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some(t => t.type === 'success' && t.message.includes('PR'))).toBe(true);
  });

  it('Cancel click dispatches reject_merge', () => {
    const run = makeRun();
    seedStores(run);

    render(<MergerConfirmModal run={run} />);
    fireEvent.click(screen.getByTestId('merger-modal-cancel'));

    expect(usePipelineStore.getState().runs['run-test-1'].state).toBe('failed');
    expect(usePipelineStore.getState().runs['run-test-1'].failureReason).toBe('merge_rejected');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('invalid_token result dispatches merge_failed with detail', async () => {
    const run = makeRun();
    seedStores(run);

    mockRequestToken.mockResolvedValue('tok-bad');
    mockRun.mockResolvedValue({
      status: 'invalid_token',
      mode: 'unknown',
      pr_url: null,
      detail: 'token expired',
    });

    render(<MergerConfirmModal run={run} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('merger-modal-merge'));
    });

    const finalRun = usePipelineStore.getState().runs['run-test-1'];
    expect(finalRun.state).toBe('failed');
    expect(finalRun.failureReason).toBe('token expired');

    // The toast is the user-visible failure surface (the modal unmounts as
    // soon as state moves to `failed`, so an inline error block would never
    // render in production).
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some(t => t.message.includes('token expired'))).toBe(true);
  });

  it('Escape key triggers cancel', () => {
    const run = makeRun();
    seedStores(run);

    render(<MergerConfirmModal run={run} />);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(usePipelineStore.getState().runs['run-test-1'].state).toBe('failed');
    expect(usePipelineStore.getState().runs['run-test-1'].failureReason).toBe('merge_rejected');
  });

  describe('telemetry (Phase 2c-ii.7)', () => {
    let captured: TelemetryEvent[];

    beforeEach(() => {
      captured = [];
      setPipelineTelemetryEmitter(ev => captured.push(ev));
    });

    afterEach(() => {
      setPipelineTelemetryEmitter(null);
    });

    it('emits merger_invoked + merger_completed(success) around a successful merge', async () => {
      const run = makeRun();
      seedStores(run);

      mockRequestToken.mockResolvedValue('tok-abc');
      mockRun.mockResolvedValue({
        status: 'success',
        mode: 'pr',
        pr_url: 'https://github.com/x/y/pull/42',
        detail: 'opened pr',
      });

      render(<MergerConfirmModal run={run} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('merger-modal-merge'));
      });

      const invoked = captured.find(e => e.event === 'merger_invoked');
      const completed = captured.find(e => e.event === 'merger_completed');
      expect(invoked).toMatchObject({
        event: 'merger_invoked',
        runId: 'run-test-1',
        projectId: 'proj-1',
      });
      expect(completed).toMatchObject({
        event: 'merger_completed',
        runId: 'run-test-1',
        projectId: 'proj-1',
        status: 'success',
        mode: 'pr',
      });

      // Order: invoked must precede completed.
      const iIdx = captured.findIndex(e => e.event === 'merger_invoked');
      const cIdx = captured.findIndex(e => e.event === 'merger_completed');
      expect(iIdx).toBeLessThan(cIdx);
    });

    it('emits merger_completed(invalid_token) with truncated detail on failure', async () => {
      const run = makeRun();
      seedStores(run);

      mockRequestToken.mockResolvedValue('tok-bad');
      const huge = 'z'.repeat(1200);
      mockRun.mockResolvedValue({
        status: 'invalid_token',
        mode: 'unknown',
        pr_url: null,
        detail: huge,
      });

      render(<MergerConfirmModal run={run} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('merger-modal-merge'));
      });

      const completed = captured.find(e => e.event === 'merger_completed');
      expect(completed).toMatchObject({
        event: 'merger_completed',
        status: 'invalid_token',
        mode: 'unknown',
      });
      if (completed && completed.event === 'merger_completed') {
        expect(completed.detail).toBeDefined();
        expect(completed.detail!.length).toBeLessThanOrEqual(500);
      }
    });
  });

  it('disables both buttons while merge is in flight', async () => {
    const run = makeRun();
    seedStores(run);

    mockRequestToken.mockResolvedValue('tok-x');
    let resolveRun!: (r: MergerResult) => void;
    mockRun.mockReturnValue(
      new Promise<MergerResult>(res => {
        resolveRun = res;
      }),
    );

    render(<MergerConfirmModal run={run} />);
    const mergeBtn = screen.getByTestId('merger-modal-merge') as HTMLButtonElement;
    const cancelBtn = screen.getByTestId('merger-modal-cancel') as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(mergeBtn);
      // Let the microtask queue drain so state flips into submitting.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mergeBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);

    await act(async () => {
      resolveRun({ status: 'success', mode: 'local', pr_url: null, detail: '' });
      await Promise.resolve();
    });
  });
});
