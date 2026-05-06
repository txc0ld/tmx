import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RunFingerprint } from '@/types';
import type { ManifestSet, Step } from './verification-chain';
import type { VerificationStepResult } from '@/utils/ipc';

// Mock the IPC module so the watcher never touches Tauri. We capture the
// `onFsChange` callback in a closure so each test can fire synthetic events
// and we can assert the watcher subscribed to the expected directory.
const mocks = vi.hoisted(() => ({
  watchDirectory: vi.fn<(path: string) => Promise<void>>(),
  unwatchDirectory: vi.fn<(path: string) => Promise<void>>(),
  fsChangeHandlers: [] as ((path: string) => void)[],
  onFsChange: vi.fn(),
}));

vi.mock('@/utils/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/utils/ipc')>('@/utils/ipc');
  mocks.watchDirectory.mockResolvedValue(undefined);
  mocks.unwatchDirectory.mockResolvedValue(undefined);
  mocks.onFsChange.mockImplementation(async (cb: (path: string) => void) => {
    mocks.fsChangeHandlers.push(cb);
    return () => {
      const i = mocks.fsChangeHandlers.indexOf(cb);
      if (i !== -1) mocks.fsChangeHandlers.splice(i, 1);
    };
  });
  return {
    ...actual,
    watchDirectory: mocks.watchDirectory,
    unwatchDirectory: mocks.unwatchDirectory,
    onFsChange: mocks.onFsChange,
  };
});

import { startCommitWatcher } from './ci-watcher';
import { usePipelineStore } from '@/stores/pipelineStore';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

const WORKTREE = '/tmp/wt';
const BRANCH = 'feat/x';
const HEADS_DIR = `${WORKTREE}/.git/refs/heads`;
const REF_PATH = `${HEADS_DIR}/${BRANCH}`;

function fireFsChange(path: string): void {
  for (const cb of mocks.fsChangeHandlers) cb(path);
}

function makeStepResult(
  status: 'pass' | 'fail',
  kind: Step['kind'],
  output = '',
): VerificationStepResult {
  return {
    status,
    kind,
    exit_code: status === 'pass' ? 0 : 1,
    duration_ms: 42,
    output,
    timed_out: false,
  };
}

/** Drive the watcher to the point where the chain has fully run. */
async function flushWatcher(): Promise<void> {
  // 1. Trip the debounce timer.
  await vi.advanceTimersByTimeAsync(300);
  // 2. Let any queued microtasks (await readHeadSha / readManifests / runStep) settle.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function createBuildingRun(runId = 'r1'): string {
  const id = usePipelineStore.getState().createRun({
    runId, templateId: 't', projectId: 'p1',
    worktreePath: WORKTREE, branch: BRANCH, fingerprint: FP,
  });
  usePipelineStore.getState().dispatch(id, { type: 'start' });
  usePipelineStore.getState().dispatch(id, { type: 'planner_done', plan: {
    stage: 'planner', branch: BRANCH, specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ci',
  }});
  usePipelineStore.getState().dispatch(id, { type: 'approve_plan' });
  return id;
}

describe('startCommitWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    mocks.watchDirectory.mockClear();
    mocks.unwatchDirectory.mockClear();
    mocks.fsChangeHandlers.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs full chain and dispatches one ci_pass per passing step', async () => {
    const runId = createBuildingRun();

    const chain: Step[] = [
      { kind: 'lint', command: 'npm run lint' },
      { kind: 'test', command: 'npm run test' },
    ];
    const runStep = vi.fn(async (s: Step) => makeStepResult('pass', s.kind));
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({ templateOverride: chain }),
      readHeadSha: async () => 'sha-aaa',
      runStep,
    });

    expect(mocks.watchDirectory).toHaveBeenCalledWith(HEADS_DIR);

    fireFsChange(REF_PATH);
    await flushWatcher();

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('building');
    expect(run.artifacts.ciResults).toHaveLength(2);
    expect(run.artifacts.ciResults.map(r => r.status)).toEqual(['pass', 'pass']);
    expect(run.artifacts.ciResults.map(r => r.step)).toEqual(['lint', 'test']);
    expect(run.artifacts.ciResults[0].sha).toBe('sha-aaa');
    expect(runStep).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stops the chain on the first failing step', async () => {
    const runId = createBuildingRun();

    const chain: Step[] = [
      { kind: 'lint', command: 'npm run lint' },
      { kind: 'test', command: 'npm run test' },
    ];
    const runStep = vi.fn(async (s: Step) =>
      s.kind === 'lint'
        ? makeStepResult('fail', 'lint', 'lint exploded')
        : makeStepResult('pass', s.kind),
    );
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({ templateOverride: chain }),
      readHeadSha: async () => 'sha-bbb',
      runStep,
    });

    fireFsChange(REF_PATH);
    await flushWatcher();

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('building'); // ci_fail in building stays in building
    expect(run.retryCounters.ciFail).toBe(1);
    expect(run.artifacts.ciResults).toHaveLength(1);
    expect(run.artifacts.ciResults[0].status).toBe('fail');
    expect(run.artifacts.ciResults[0].step).toBe('lint');
    expect(runStep).toHaveBeenCalledTimes(1); // test step never invoked

    stop();
  });

  it('emits a vacuous ci_pass when the chain is empty', async () => {
    const runId = createBuildingRun();

    const runStep = vi.fn();
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({}),
      readHeadSha: async () => 'sha-ccc',
      runStep,
    });

    fireFsChange(REF_PATH);
    await flushWatcher();

    const run = usePipelineStore.getState().runs[runId];
    expect(run.artifacts.ciResults).toHaveLength(1);
    expect(run.artifacts.ciResults[0].status).toBe('pass');
    expect(run.artifacts.ciResults[0].step).toBe('all');
    expect(run.artifacts.ciResults[0].command).toMatch(/vacuous/);
    expect(runStep).not.toHaveBeenCalled();

    stop();
  });

  it('debounces a burst of fs-change events into a single chain run', async () => {
    const runId = createBuildingRun();

    const chain: Step[] = [{ kind: 'test', command: 'npm test' }];
    const runStep = vi.fn(async (s: Step) => makeStepResult('pass', s.kind));
    const readHead = vi.fn(async () => 'sha-ddd');
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({ templateOverride: chain }),
      readHeadSha: readHead,
      runStep,
    });

    // Fire 5 events within the 250ms window.
    fireFsChange(`${REF_PATH}.lock`);
    await vi.advanceTimersByTimeAsync(50);
    fireFsChange(REF_PATH);
    await vi.advanceTimersByTimeAsync(50);
    fireFsChange(REF_PATH);
    await vi.advanceTimersByTimeAsync(50);
    fireFsChange(REF_PATH);

    await flushWatcher();

    const run = usePipelineStore.getState().runs[runId];
    expect(run.artifacts.ciResults).toHaveLength(1);
    expect(readHead).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledTimes(1);

    stop();
  });

  it('ignores fs-change events for other branches', async () => {
    const runId = createBuildingRun();

    const runStep = vi.fn(async (s: Step) => makeStepResult('pass', s.kind));
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({
        templateOverride: [{ kind: 'test', command: 'npm test' }],
      }),
      readHeadSha: async () => 'sha-eee',
      runStep,
    });

    fireFsChange(`${HEADS_DIR}/some-other-branch`);
    fireFsChange(`${HEADS_DIR}/main`);
    await flushWatcher();

    expect(usePipelineStore.getState().runs[runId].artifacts.ciResults).toHaveLength(0);
    expect(runStep).not.toHaveBeenCalled();

    stop();
  });

  it('does not dispatch when the run has left building before the chain starts', async () => {
    const runId = createBuildingRun();

    const runStep = vi.fn(async (s: Step) => makeStepResult('pass', s.kind));
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({
        templateOverride: [{ kind: 'test', command: 'npm test' }],
      }),
      readHeadSha: async () => 'sha-fff',
      runStep,
    });

    // User aborts mid-flight.
    usePipelineStore.getState().dispatch(runId, { type: 'abort', reason: 'user-cancel' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('failed');

    fireFsChange(REF_PATH);
    await flushWatcher();

    expect(usePipelineStore.getState().runs[runId].artifacts.ciResults).toHaveLength(0);
    expect(runStep).not.toHaveBeenCalled();

    stop();
  });

  it('cleanup unwatches the dir and ignores subsequent fs-change events', async () => {
    const runId = createBuildingRun();

    const runStep = vi.fn(async (s: Step) => makeStepResult('pass', s.kind));
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({
        templateOverride: [{ kind: 'test', command: 'npm test' }],
      }),
      readHeadSha: async () => 'sha-ggg',
      runStep,
    });

    stop();

    fireFsChange(REF_PATH);
    await flushWatcher();

    expect(mocks.unwatchDirectory).toHaveBeenCalledWith(HEADS_DIR);
    expect(runStep).not.toHaveBeenCalled();
  });
});
