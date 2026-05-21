import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// IPC mock — must come before the lifecycle import since the module reads
// `pipelineFailureBundleGenerate` at top level.
vi.mock('@/utils/ipc', () => ({
  pipelineFailureBundleGenerate: vi.fn(async () => ({
    bundle_path: '/tmp/.terminalx/failure-bundles/r1.tar.gz',
    size_bytes: 1024,
    entries: ['telemetry.jsonl', 'artifacts.json', 'preflight.json'],
  })),
}));

import {
  handleFailureBundleLifecycle,
  resetFailureBundleLifecycleForTest,
} from './failure-bundle-lifecycle';
import { pipelineFailureBundleGenerate } from '@/utils/ipc';
import { useProjectStore } from '@/stores/projectStore';
import { usePipelineStore, type LifecycleEvent } from '@/stores/pipelineStore';
import type { PipelineRun, PipelineState, RunFingerprint } from '@/types';

const generateMock = pipelineFailureBundleGenerate as unknown as ReturnType<typeof vi.fn>;

const PROJECT = {
  id: 'p-1',
  name: 'Fixture',
  icon: '🧪',
  color: '#fff',
  description: '',
  cwd: '/proj/fixture',
};

const FINGERPRINT: RunFingerprint = {
  templateId: 'tx.pipeline.test',
  templateHash: 'abc',
  skillHashes: {},
  rolePromptHashes: {},
  models: {},
  capabilityManifests: {},
  terminalxVersion: '0.1.0',
};

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'r-1',
    templateId: 'tx.pipeline.test',
    projectId: 'p-1',
    worktreePath: '/proj/fixture/.tx-worktrees/r-1',
    branch: 'feat/x',
    baseBranch: 'main',
    state: 'idle',
    artifacts: {
      builds: [],
      reviews: [],
      ciResults: [],
      questions: [],
      redTeamReports: [],
    },
    retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 },
    startedAt: 0,
    escalationLog: [],
    tiles: {},
    fingerprint: FINGERPRINT,
    planLineage: [],
    ...overrides,
  } as PipelineRun;
}

function makeEvent(overrides: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return {
    runId: 'r-1',
    projectId: 'p-1',
    worktreePath: '/proj/fixture/.tx-worktrees/r-1',
    from: 'idle',
    to: 'failed' as PipelineState,
    trigger: 'abort',
    ...overrides,
  };
}

beforeEach(() => {
  resetFailureBundleLifecycleForTest();
  generateMock.mockClear();
  generateMock.mockResolvedValue({
    bundle_path: '/tmp/x.tar.gz',
    size_bytes: 1024,
    entries: ['telemetry.jsonl'],
  });
  useProjectStore.setState({ projects: [PROJECT], active: 'p-1' });
  usePipelineStore.setState({ runs: { 'r-1': makeRun() }, activeRunIds: [] });
});

afterEach(() => {
  // Don't leak runs / projects across files in the suite.
  useProjectStore.setState({ projects: [], active: '' });
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
});

describe('failure-bundle lifecycle', () => {
  it('does nothing on a non-terminal transition', async () => {
    handleFailureBundleLifecycle(makeEvent({ from: 'idle', to: 'planning' }));
    // Yield so any (incorrectly fired) async generate gets a chance to race.
    await Promise.resolve();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('does nothing on a successful terminal state (done)', async () => {
    handleFailureBundleLifecycle(makeEvent({ from: 'merging', to: 'done', trigger: 'merge_done' }));
    await Promise.resolve();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('fires on transition into failed', () => {
    handleFailureBundleLifecycle(makeEvent({ from: 'building', to: 'failed', trigger: 'abort' }));
    expect(generateMock).toHaveBeenCalledTimes(1);
    const arg = generateMock.mock.calls[0][0];
    expect(arg.runId).toBe('r-1');
    expect(arg.projectDir).toBe('/proj/fixture');
    expect(arg.branch).toBe('feat/x');
    expect(arg.baseBranch).toBe('main');
    expect(arg.terminalxVersion).toBe('0.1.0');
  });

  it('fires on transition into escalated', () => {
    handleFailureBundleLifecycle(makeEvent({ from: 'reviewing', to: 'escalated', trigger: 'budget_exhausted' }));
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('serializes artifacts as JSON in the IPC payload', () => {
    usePipelineStore.setState({
      runs: {
        'r-1': makeRun({
          artifacts: {
            builds: [],
            reviews: [],
            ciResults: [],
            questions: [],
            redTeamReports: [],
            plan: {
              stage: 'planner',
              branch: 'feat/x',
              specPath: '/wt/docs/spec.md',
              planPath: '/wt/docs/plan.md',
              tasks: [],
              summary: 'fixture',
              planCommitSha: 'deadbeef',
              confidence: 'verified',
            },
          },
        }),
      },
    });
    handleFailureBundleLifecycle(makeEvent({ from: 'building', to: 'failed' }));
    const arg = generateMock.mock.calls[0][0];
    const parsed = JSON.parse(arg.artifactsJson);
    expect(parsed.plan.planCommitSha).toBe('deadbeef');
  });

  it('is idempotent within a run — second failure transition is a no-op', () => {
    handleFailureBundleLifecycle(makeEvent({ from: 'building', to: 'failed' }));
    handleFailureBundleLifecycle(makeEvent({ from: 'failed', to: 'failed' }));
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('isolates bookkeeping between runs', () => {
    usePipelineStore.setState({
      runs: { 'r-1': makeRun(), 'r-2': makeRun({ id: 'r-2' }) },
    });
    handleFailureBundleLifecycle(makeEvent({ runId: 'r-1', from: 'building', to: 'failed' }));
    handleFailureBundleLifecycle(makeEvent({ runId: 'r-2', from: 'building', to: 'failed' }));
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it('logs and skips when the run is missing from the store', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleFailureBundleLifecycle(makeEvent({ runId: 'unknown-run', from: 'building', to: 'failed' }));
    expect(generateMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs and skips when the project cwd is missing', () => {
    useProjectStore.setState({ projects: [], active: '' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleFailureBundleLifecycle(makeEvent({ from: 'building', to: 'failed' }));
    expect(generateMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows IPC failures (does not throw)', async () => {
    generateMock.mockRejectedValueOnce(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      handleFailureBundleLifecycle(makeEvent({ from: 'building', to: 'failed' })),
    ).not.toThrow();
    // Yield so the rejected promise's catch runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to "{}" when artifacts can\'t be serialized', () => {
    // Construct a run whose artifacts contain a circular reference, forcing
    // JSON.stringify to throw.
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    usePipelineStore.setState({
      runs: {
        'r-1': makeRun({
          artifacts: circular as unknown as PipelineRun['artifacts'],
        }),
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleFailureBundleLifecycle(makeEvent({ from: 'building', to: 'failed' }));
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0].artifactsJson).toBe('{}');
    warn.mockRestore();
  });
});
