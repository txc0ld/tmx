import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  makeRunPersistenceLifecycleHandler,
  hydrateRunsFromDisk,
  persistRun,
  reconcileHydratedRun,
  serializeRun,
  snapshotPath,
  RUN_PERSISTENCE_SUBDIR,
  type RunPersistenceDeps,
} from './run-persistence';
import { usePipelineStore, type LifecycleEvent } from '@/stores/pipelineStore';
import type { PipelineRun, PipelineState, RunFingerprint } from '@/types';
import type { FileTreeNode } from '@/utils/ipc';

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
    state: 'idle' as PipelineState,
    artifacts: {
      builds: [],
      reviews: [],
      ciResults: [],
      questions: [],
      redTeamReports: [],
    },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 0,
    escalationLog: [],
    tiles: {},
    fingerprint: FINGERPRINT,
    planLineage: [],
    runMode: 'standard',
    autoApprovePlan: false,
    useDualReviewer: false,
    runRedTeam: false,
    effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3 },
    templateDualReviewer: false,
    ...overrides,
  } as PipelineRun;
}

type WriteFn = RunPersistenceDeps['writeFileText'];
type ReadFn = RunPersistenceDeps['readFileText'];
type TreeFn = RunPersistenceDeps['readFileTree'];

function makeWriteMock(): ReturnType<typeof vi.fn<WriteFn>> {
  return vi.fn<WriteFn>(async () => undefined);
}
function makeReadMock(impl?: ReadFn): ReturnType<typeof vi.fn<ReadFn>> {
  return vi.fn<ReadFn>(impl ?? (async () => ''));
}
function makeTreeMock(impl?: TreeFn): ReturnType<typeof vi.fn<TreeFn>> {
  return vi.fn<TreeFn>(impl ?? (async () => []));
}

function makeDeps(overrides: Partial<RunPersistenceDeps> = {}): RunPersistenceDeps {
  return {
    resolveProjectCwd: () => '/proj/fixture',
    writeFileText: makeWriteMock(),
    readFileText: makeReadMock(),
    readFileTree: makeTreeMock(),
    ...overrides,
  };
}

beforeEach(() => {
  // Wipe the runs map between tests.
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
});

describe('persistRun', () => {
  it('writes the serialized run to <cwd>/.terminalx/pipeline-runs/<id>.json', async () => {
    const writeFileText = makeWriteMock();
    const deps = makeDeps({ writeFileText });
    const run = makeRun({ id: 'abc-123', state: 'planning' });

    await persistRun(run, deps);

    expect(writeFileText).toHaveBeenCalledTimes(1);
    const call = writeFileText.mock.calls[0];
    const path = call[0];
    const contents = call[1];
    expect(path).toBe(`/proj/fixture/${RUN_PERSISTENCE_SUBDIR}/abc-123.json`);
    expect(snapshotPath('/proj/fixture', 'abc-123')).toBe(path);
    const parsed = JSON.parse(contents);
    expect(parsed.id).toBe('abc-123');
    expect(parsed.state).toBe('planning');
  });

  it('skips writes when runId fails the [A-Za-z0-9_-]+ regex', async () => {
    const writeFileText = makeWriteMock();
    const deps = makeDeps({ writeFileText });

    await persistRun(makeRun({ id: '../etc/passwd' }), deps);
    await persistRun(makeRun({ id: 'has spaces' }), deps);
    await persistRun(makeRun({ id: '' }), deps);

    expect(writeFileText).not.toHaveBeenCalled();
  });

  it('no-ops when project cwd cannot be resolved', async () => {
    const writeFileText = makeWriteMock();
    const deps = makeDeps({
      resolveProjectCwd: () => null,
      writeFileText,
    });
    await persistRun(makeRun(), deps);
    expect(writeFileText).not.toHaveBeenCalled();
  });

  it('swallows writeFileText errors with a console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeFileText = vi.fn<WriteFn>(async () => {
      throw new Error('disk full');
    });
    const deps = makeDeps({ writeFileText });
    // Should not throw.
    await persistRun(makeRun(), deps);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('lifecycle handler', () => {
  it('writes the latest run snapshot when a state_change event fires', () => {
    const run = makeRun({ id: 'r-1', state: 'building' });
    usePipelineStore.setState({ runs: { 'r-1': run }, activeRunIds: ['r-1'] });
    const writeFileText = makeWriteMock();
    const deps = makeDeps({ writeFileText });
    const handler = makeRunPersistenceLifecycleHandler(deps);

    const ev: LifecycleEvent = {
      runId: 'r-1',
      projectId: 'p-1',
      worktreePath: run.worktreePath,
      from: 'planning',
      to: 'building',
      trigger: 'approve_plan',
    };
    handler(ev);

    // The handler is fire-and-forget; flush the microtask queue.
    return Promise.resolve().then(() => {
      expect(writeFileText).toHaveBeenCalledTimes(1);
      const call = writeFileText.mock.calls[0];
      expect(call[0]).toBe(snapshotPath('/proj/fixture', 'r-1'));
      const parsed = JSON.parse(call[1]);
      expect(parsed.state).toBe('building');
    });
  });

  it('no-ops when the run id is missing from the store', () => {
    const writeFileText = makeWriteMock();
    const deps = makeDeps({ writeFileText });
    const handler = makeRunPersistenceLifecycleHandler(deps);
    handler({
      runId: 'ghost',
      projectId: 'p-1',
      worktreePath: '/proj/fixture',
      from: 'idle',
      to: 'planning',
      trigger: 'start',
    });
    expect(writeFileText).not.toHaveBeenCalled();
  });
});

describe('reconcileHydratedRun', () => {
  it('marks an active-state run as failed with the disconnected reason', () => {
    const run = makeRun({ state: 'building' });
    const reconciled = reconcileHydratedRun(run);
    expect(reconciled.state).toBe('failed');
    expect(reconciled.failureReason).toBe(
      'app reloaded during active state — agents disconnected',
    );
    expect(reconciled.failureClass).toBe('unknown');
    expect(reconciled.endedAt).toBeGreaterThan(0);
  });

  it.each<PipelineState>([
    'planning',
    'building',
    'reviewing',
    'awaiting_dual_reviewer',
    'awaiting_tiebreaker',
    'awaiting_red_team',
    'merging',
  ])('marks active state %s as failed', (state) => {
    const run = makeRun({ state });
    expect(reconcileHydratedRun(run).state).toBe('failed');
  });

  it.each<PipelineState>([
    'awaiting_plan_approval',
    'awaiting_clarification',
    'awaiting_merge_approval',
    'idle',
  ])('leaves %s untouched', (state) => {
    const run = makeRun({ state });
    expect(reconcileHydratedRun(run).state).toBe(state);
    expect(reconcileHydratedRun(run).failureReason).toBeUndefined();
  });

  it.each<PipelineState>(['done', 'failed', 'escalated'])(
    'leaves terminal state %s untouched',
    (state) => {
      const run = makeRun({ state });
      const out = reconcileHydratedRun(run);
      expect(out.state).toBe(state);
    },
  );

  // Phase 3b: the agentsDisconnected flag drives the controller-tile
  // banner + the builder-kick lifecycle short-circuit. Hydrated awaiting_*
  // runs get it set; everything else is left alone.
  it.each<PipelineState>([
    'awaiting_plan_approval',
    'awaiting_clarification',
    'awaiting_merge_approval',
  ])('flags hydrated awaiting state %s with agentsDisconnected = true', (state) => {
    const run = makeRun({ state });
    expect(run.agentsDisconnected).toBeUndefined();
    const out = reconcileHydratedRun(run);
    expect(out.agentsDisconnected).toBe(true);
    expect(out.state).toBe(state);
  });

  it('does not flag idle runs with agentsDisconnected', () => {
    const out = reconcileHydratedRun(makeRun({ state: 'idle' }));
    expect(out.agentsDisconnected).toBeUndefined();
  });

  it.each<PipelineState>(['done', 'failed', 'escalated'])(
    'does not flag terminal state %s with agentsDisconnected',
    (state) => {
      const out = reconcileHydratedRun(makeRun({ state }));
      expect(out.agentsDisconnected).toBeUndefined();
    },
  );

  it('active-state runs reclassified to failed are not flagged disconnected', () => {
    // The reclassified record is terminal — no banner needed.
    const out = reconcileHydratedRun(makeRun({ state: 'building' }));
    expect(out.state).toBe('failed');
    expect(out.agentsDisconnected).toBeUndefined();
  });
});

describe('createRun', () => {
  it('newly created runs do not have agentsDisconnected set', () => {
    const id = usePipelineStore.getState().createRun({
      runId: 'fresh-1',
      templateId: 'tx.pipeline.test',
      projectId: 'p-1',
      worktreePath: '/wt',
      branch: 'feat/x',
      fingerprint: FINGERPRINT,
    });
    const run = usePipelineStore.getState().runs[id];
    expect(run).toBeDefined();
    // Must default to falsy/undefined so the controller banner doesn't
    // render on brand-new runs and the builder-kick lifecycle proceeds
    // normally.
    expect(run.agentsDisconnected).toBeUndefined();
  });
});

describe('hydrateRunsFromDisk', () => {
  it('reads every .json file under .terminalx/pipeline-runs/ and rebuilds runs', async () => {
    const runA = makeRun({ id: 'r-a', state: 'awaiting_plan_approval' });
    const runB = makeRun({ id: 'r-b', state: 'building' });
    const tree: FileTreeNode[] = [
      { name: 'r-a.json', path: '/proj/fixture/.terminalx/pipeline-runs/r-a.json', node_type: 'File', children: null },
      { name: 'r-b.json', path: '/proj/fixture/.terminalx/pipeline-runs/r-b.json', node_type: 'File', children: null },
      { name: 'README.txt', path: '/proj/fixture/.terminalx/pipeline-runs/README.txt', node_type: 'File', children: null },
    ];
    const readFileTree = makeTreeMock(async () => tree);
    const readFileText = makeReadMock(async (p: string) => {
      if (p.endsWith('r-a.json')) return serializeRun(runA);
      if (p.endsWith('r-b.json')) return serializeRun(runB);
      throw new Error('unexpected path: ' + p);
    });
    const writeFileText = makeWriteMock();
    const deps = makeDeps({ readFileTree, readFileText, writeFileText });

    const count = await hydrateRunsFromDisk('/proj/fixture', deps);
    expect(count).toBe(2);

    const runs = usePipelineStore.getState().runs;
    expect(runs['r-a']).toBeDefined();
    expect(runs['r-b']).toBeDefined();
    // Awaiting state preserved.
    expect(runs['r-a'].state).toBe('awaiting_plan_approval');
    // Active state reclassified to failed by the on-reload policy.
    expect(runs['r-b'].state).toBe('failed');
    expect(runs['r-b'].failureReason).toContain('app reloaded');
  });

  it('returns 0 when the directory is missing', async () => {
    const readFileTree = vi.fn<TreeFn>(async () => {
      throw new Error('ENOENT');
    });
    const deps = makeDeps({ readFileTree });
    const count = await hydrateRunsFromDisk('/proj/fixture', deps);
    expect(count).toBe(0);
    expect(usePipelineStore.getState().runs).toEqual({});
  });

  it('skips malformed snapshots without breaking the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodRun = makeRun({ id: 'r-good', state: 'awaiting_plan_approval' });
    const tree: FileTreeNode[] = [
      { name: 'r-good.json', path: '/x/r-good.json', node_type: 'File', children: null },
      { name: 'r-bad.json', path: '/x/r-bad.json', node_type: 'File', children: null },
    ];
    const readFileText = makeReadMock(async (p: string) => {
      if (p.endsWith('r-good.json')) return serializeRun(goodRun);
      return '{not json';
    });
    const deps = makeDeps({
      readFileTree: makeTreeMock(async () => tree),
      readFileText,
    });
    const count = await hydrateRunsFromDisk('/proj/fixture', deps);
    expect(count).toBe(1);
    expect(usePipelineStore.getState().runs['r-good']).toBeDefined();
    expect(usePipelineStore.getState().runs['r-bad']).toBeUndefined();
    warn.mockRestore();
  });

  it('is idempotent across two hydration calls for the same projectDir', async () => {
    // Per-session dedup is enforced in App.tsx by `hydratedProjectIds`, but
    // hydrateRunsFromDisk itself must also be safe to call repeatedly: a
    // second call re-reads the same JSON, _hydrateForTest merges by id, so
    // existing runs are simply replaced with the same value. No throw, no
    // loss of other runs already in the store.
    const runA = makeRun({ id: 'r-a', state: 'awaiting_plan_approval' });
    const tree: FileTreeNode[] = [
      { name: 'r-a.json', path: '/proj/fixture/.terminalx/pipeline-runs/r-a.json', node_type: 'File', children: null },
    ];
    const deps = makeDeps({
      readFileTree: makeTreeMock(async () => tree),
      readFileText: makeReadMock(async () => serializeRun(runA)),
    });

    const c1 = await hydrateRunsFromDisk('/proj/fixture', deps);
    const c2 = await hydrateRunsFromDisk('/proj/fixture', deps);

    expect(c1).toBe(1);
    expect(c2).toBe(1);
    const runs = usePipelineStore.getState().runs;
    expect(Object.keys(runs)).toEqual(['r-a']);
    expect(runs['r-a'].state).toBe('awaiting_plan_approval');
  });

  it('hydrating two different project dirs in sequence keeps both projects runs', async () => {
    // Cross-project storage by run id is the contract: switching projects
    // mid-session must not clobber the previous project's runs. This test
    // mirrors the App.tsx project-switch hydration flow.
    const runA = makeRun({ id: 'r-projA', projectId: 'p-a', state: 'awaiting_plan_approval' });
    const runB = makeRun({ id: 'r-projB', projectId: 'p-b', state: 'awaiting_clarification' });

    const treeA: FileTreeNode[] = [
      { name: 'r-projA.json', path: '/proj/a/.terminalx/pipeline-runs/r-projA.json', node_type: 'File', children: null },
    ];
    const treeB: FileTreeNode[] = [
      { name: 'r-projB.json', path: '/proj/b/.terminalx/pipeline-runs/r-projB.json', node_type: 'File', children: null },
    ];

    const depsA = makeDeps({
      readFileTree: makeTreeMock(async () => treeA),
      readFileText: makeReadMock(async () => serializeRun(runA)),
    });
    const depsB = makeDeps({
      readFileTree: makeTreeMock(async () => treeB),
      readFileText: makeReadMock(async () => serializeRun(runB)),
    });

    await hydrateRunsFromDisk('/proj/a', depsA);
    await hydrateRunsFromDisk('/proj/b', depsB);

    const runs = usePipelineStore.getState().runs;
    expect(runs['r-projA']).toBeDefined();
    expect(runs['r-projB']).toBeDefined();
    expect(runs['r-projA'].projectId).toBe('p-a');
    expect(runs['r-projB'].projectId).toBe('p-b');
    // Both runs survive — neither hydration call clobbered the other.
    expect(Object.keys(runs).sort()).toEqual(['r-projA', 'r-projB']);
  });

  it('persists the reconciled-failed state back to disk', async () => {
    const runActive = makeRun({ id: 'r-active', state: 'building' });
    const tree: FileTreeNode[] = [
      { name: 'r-active.json', path: '/x/r-active.json', node_type: 'File', children: null },
    ];
    const writeFileText = makeWriteMock();
    const deps = makeDeps({
      readFileTree: makeTreeMock(async () => tree),
      readFileText: makeReadMock(async () => serializeRun(runActive)),
      writeFileText,
    });
    await hydrateRunsFromDisk('/proj/fixture', deps);
    // Flush microtasks for the fire-and-forget rewrite.
    await Promise.resolve();
    await Promise.resolve();
    expect(writeFileText).toHaveBeenCalled();
    const call = writeFileText.mock.calls[0];
    const written = JSON.parse(call[1]);
    expect(written.state).toBe('failed');
  });
});
