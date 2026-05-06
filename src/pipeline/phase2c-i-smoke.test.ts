/**
 * Phase 2c-i end-to-end smoke test.
 *
 * Wires the four 2c-i building blocks together — `createRunFromTemplate`
 * (full fingerprint), `startCommitWatcher` (CI hook), the state machine's
 * `replan_requested` carve-out, and `versionedPlanPath` — without spawning
 * real agents or hitting fs/IPC. All side effects (skill reads, fs watch,
 * step execution) are injected.
 *
 * Sister test to `phase2b-smoke.test.ts`; that one covers the
 * planner→builder→reviewer happy path. This one focuses on what's NEW in
 * 2c-i: full fingerprint wiring, CI hook flow, planLineage extension.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ManifestSet, Step } from './verification-chain';
import type { VerificationStepResult } from '@/utils/ipc';
import type { PlanArtifact } from '@/types';

// IPC mock: the CI watcher uses watchDirectory / unwatchDirectory / onFsChange,
// and the run factory's defaultRunFactoryDeps would use readFileText (we don't
// exercise that path here — we always pass stub deps directly).
const mocks = vi.hoisted(() => ({
  watchDirectory: vi.fn<(path: string) => Promise<void>>(),
  unwatchDirectory: vi.fn<(path: string) => Promise<void>>(),
  fsChangeHandlers: [] as ((path: string) => void)[],
  onFsChange: vi.fn(),
  readFileText: vi.fn(),
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
    readFileText: mocks.readFileText,
  };
});

import { usePipelineStore } from '@/stores/pipelineStore';
import { startCommitWatcher } from './ci-watcher';
import {
  createRunFromTemplate,
  type RunFactoryDeps,
} from './run-factory';
import { helloWorldTemplate } from './templates';
import { versionedPlanPath, nextPlanVersionSuffix } from './plan-versioning';

const WORKTREE = '/tmp/wt';
const BRANCH = 'feat/2c-i-smoke';
const HEADS_DIR = `${WORKTREE}/.git/refs/heads`;
const REF_PATH = `${HEADS_DIR}/${BRANCH}`;

const stubDeps = (overrides: Partial<RunFactoryDeps> = {}): RunFactoryDeps => ({
  // Default: every skill resolves to a stable canned body so fingerprints are deterministic.
  readSkillContent: async (name) => `# ${name}\nstub body`,
  readRolePrompt: async () => null,
  readRoleCapabilities: async () => null,
  readInvariants: async () => null,
  ...overrides,
});

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
    duration_ms: 7,
    output,
    timed_out: false,
  };
}

/** Trip the 250ms debounce + drain queued microtasks so the chain finishes. */
async function flushWatcher(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Fire one synthetic commit + wait for the chain to settle. */
async function simulateCommit(): Promise<void> {
  fireFsChange(REF_PATH);
  await flushWatcher();
}

/** Convenience: createRunFromTemplate + drive to `building`. */
async function createBuildingRun(opts: {
  runId: string;
  deps?: RunFactoryDeps;
  planCommitSha?: string;
}): Promise<string> {
  const tpl = helloWorldTemplate();
  const { runId } = await createRunFromTemplate({
    runId: opts.runId,
    template: tpl,
    projectId: 'proj-2c-i',
    worktreePath: WORKTREE,
    branch: BRANCH,
    terminalxVersion: '0.1.0',
    deps: opts.deps ?? stubDeps(),
  });
  const store = usePipelineStore.getState();
  store.dispatch(runId, { type: 'start' });
  store.dispatch(runId, {
    type: 'planner_done',
    plan: {
      stage: 'planner',
      branch: BRANCH,
      specPath: 'docs/spec.md',
      planPath: 'docs/plan.md',
      tasks: [],
      summary: '',
      planCommitSha: opts.planCommitSha ?? 'sha-plan-v1',
    },
  });
  store.dispatch(runId, { type: 'approve_plan' });
  return runId;
}

describe('Phase 2c-i smoke: factory → CI hook → escalation → re-plan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    mocks.watchDirectory.mockClear();
    mocks.unwatchDirectory.mockClear();
    mocks.fsChangeHandlers.length = 0;
    mocks.readFileText.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Factory wires computeFullFingerprint (not minimal).
  it('createRunFromTemplate populates skillHashes via computeFullFingerprint', async () => {
    const tpl = helloWorldTemplate();
    const seen: string[] = [];
    const deps = stubDeps({
      readSkillContent: async (name) => {
        seen.push(name);
        return `# ${name}\nbody for fingerprint`;
      },
    });

    const { runId, fingerprint } = await createRunFromTemplate({
      runId: 'r-smoke-fp', template: tpl, projectId: 'p',
      worktreePath: WORKTREE, branch: BRANCH,
      terminalxVersion: '0.1.0',
      deps,
    });

    // Every unique skill across all roles should be hashed (proves dedup +
    // full fingerprint, not the Phase 1 minimal one which only hashes the
    // template metadata).
    const expected = new Set<string>();
    for (const list of Object.values(tpl.pipeline.skillBindings)) {
      for (const s of list ?? []) expected.add(s);
    }
    expect(Object.keys(fingerprint.skillHashes).length).toBe(expected.size);
    expect(Object.keys(fingerprint.skillHashes).sort())
      .toEqual(Array.from(expected).sort());
    for (const h of Object.values(fingerprint.skillHashes)) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    // Templated skill `tx-pipeline-stage-handoff` is bound to planner AND builder
    // — confirm dedup happened (one read, one hash entry).
    const handoffReads = seen.filter(n => n === 'tx-pipeline-stage-handoff').length;
    expect(handoffReads).toBe(1);

    expect(usePipelineStore.getState().runs[runId].planLineage).toEqual([]);
  });

  // 2. Builder commit → verification chain → ci_pass.
  it('builder commit triggers verification chain and dispatches ci_pass per step', async () => {
    const runId = await createBuildingRun({ runId: 'r-smoke-pass' });

    const chain: Step[] = [
      { kind: 'lint', command: 'npm run lint' },
      { kind: 'test', command: 'npm run test' },
    ];
    const runStep = vi.fn(async (s: Step) => makeStepResult('pass', s.kind));
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({ templateOverride: chain }),
      readHeadSha: async () => 'sha-builder-1',
      runStep,
    });

    expect(mocks.watchDirectory).toHaveBeenCalledWith(HEADS_DIR);
    await simulateCommit();

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('building'); // ci_pass doesn't transition.
    expect(run.artifacts.ciResults).toHaveLength(2);
    expect(run.artifacts.ciResults.map(r => r.status)).toEqual(['pass', 'pass']);
    expect(run.artifacts.ciResults.every(r => r.sha === 'sha-builder-1')).toBe(true);
    expect(run.retryCounters.ciFail).toBe(0);
    expect(runStep).toHaveBeenCalledTimes(2);

    stop();
  });

  // 3. Builder commit → first failing step → ci_fail dispatched, counter++, state stays building.
  it('builder commit with failing lint dispatches ci_fail and increments retry counter', async () => {
    const runId = await createBuildingRun({ runId: 'r-smoke-fail' });

    const chain: Step[] = [
      { kind: 'lint', command: 'npm run lint' },
      { kind: 'test', command: 'npm run test' },
    ];
    const runStep = vi.fn(async (s: Step) =>
      s.kind === 'lint'
        ? makeStepResult('fail', 'lint', 'eslint exploded with 17 errors')
        : makeStepResult('pass', s.kind),
    );
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({ templateOverride: chain }),
      readHeadSha: async () => 'sha-broken-1',
      runStep,
    });

    await simulateCommit();

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('building'); // 1 fail < budget(3).
    expect(run.retryCounters.ciFail).toBe(1);
    expect(run.artifacts.ciResults).toHaveLength(1);
    expect(run.artifacts.ciResults[0].status).toBe('fail');
    expect(run.artifacts.ciResults[0].step).toBe('lint');
    expect(run.artifacts.ciResults[0].failures[0]?.output).toMatch(/eslint exploded/);
    // Chain stops at the first failure — `test` step is never called.
    expect(runStep).toHaveBeenCalledTimes(1);

    stop();
  });

  // 4. Four ci_fails exhaust the budget → escalated.
  it('CI fail budget exhaustion (4 fails) escalates the run with failureClass=builder_loop', async () => {
    const runId = await createBuildingRun({ runId: 'r-smoke-escalate' });

    const chain: Step[] = [{ kind: 'test', command: 'npm test' }];
    const runStep = vi.fn(async () => makeStepResult('fail', 'test', 'tests broke'));
    let head = 0;
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({ templateOverride: chain }),
      readHeadSha: async () => `sha-broken-${++head}`,
      runStep,
    });

    // Budget is 3 — the FOURTH ci_fail tips into escalated.
    for (let i = 0; i < 4; i++) {
      await simulateCommit();
    }

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('escalated');
    expect(run.failureClass).toBe('builder_loop');
    expect(run.retryCounters.ciFail).toBe(4);
    expect(run.artifacts.ciResults).toHaveLength(4);
    expect(run.endedAt).toBeDefined();

    stop();
  });

  // 5. From escalated, replan_requested → planning; new planner_done extends planLineage.
  it('replan_requested from escalated re-enters planning and extends planLineage', async () => {
    const runId = await createBuildingRun({
      runId: 'r-smoke-replan',
      planCommitSha: 'sha-plan-v1',
    });
    const store = usePipelineStore.getState();

    // Drive to escalated via 4 ci_fails (no need for the watcher here — direct
    // dispatch is faster and the previous test already proves the watcher path).
    for (let i = 0; i < 4; i++) {
      store.dispatch(runId, {
        type: 'ci_fail',
        result: {
          sha: `sha-${i}`, status: 'fail', step: 'test',
          command: 'npm test', durationMs: 1, failures: [],
        },
      });
    }
    let run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('escalated');
    expect(run.planLineage).toEqual(['sha-plan-v1']);

    // Compute where the v2 plan file would land BEFORE re-planning, using the
    // current lineage length. lineage=1 → suffix `-v2` → `docs/plan-v2.md`.
    const v2Path = versionedPlanPath('docs/plan.md', run.planLineage.length);
    expect(v2Path).toBe('docs/plan-v2.md');
    expect(nextPlanVersionSuffix(run.planLineage.length)).toBe('-v2');

    // The narrow carve-out: replan_requested re-enters planning.
    usePipelineStore.getState().dispatch(runId, {
      type: 'replan_requested',
      reason: 'four ci_fails — strategy needs rethinking',
    });
    run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('planning');
    expect(run.endedAt).toBeUndefined();
    expect(run.escalationLog[run.escalationLog.length - 1]?.decision).toBe('replan');

    // Fresh planner_done with a NEW commit appends to planLineage.
    usePipelineStore.getState().dispatch(runId, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: BRANCH,
        specPath: 'docs/spec.md',
        planPath: v2Path,
        tasks: [], summary: '',
        planCommitSha: 'sha-plan-v2',
      },
    });
    run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('awaiting_plan_approval');
    expect(run.planLineage).toEqual(['sha-plan-v1', 'sha-plan-v2']);
    expect(run.artifacts.plan?.planPath).toBe('docs/plan-v2.md');

    // And the v3 path now follows from the extended lineage.
    expect(versionedPlanPath('docs/plan.md', run.planLineage.length))
      .toBe('docs/plan-v3.md');
  });

  // 6. Optional happy chain through the watcher — proves CI hook composes
  //    cleanly with the rest of the state machine on a passing build.
  it('happy chain: building → CI passes → builder_done → reviewing', async () => {
    const runId = await createBuildingRun({ runId: 'r-smoke-happy' });

    const chain: Step[] = [{ kind: 'test', command: 'npm test' }];
    const runStep = vi.fn(async (s: Step) => makeStepResult('pass', s.kind));
    const stop = await startCommitWatcher({
      runId, worktreePath: WORKTREE, branch: BRANCH,
      readManifests: async (): Promise<ManifestSet> => ({ templateOverride: chain }),
      readHeadSha: async () => 'sha-happy',
      runStep,
    });

    await simulateCommit();
    let run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('building');
    expect(run.artifacts.ciResults).toHaveLength(1);
    expect(run.artifacts.ciResults[0].status).toBe('pass');

    // Builder finishes (state→reviewing). The watcher should no longer fire
    // even if another commit lands — the chain's `state === 'building'` guard
    // bails. Dispatch the builder_done directly (controller-runtime is the
    // production driver; phase2b-smoke covers that path).
    usePipelineStore.getState().dispatch(runId, {
      type: 'builder_done',
      build: {
        stage: 'builder', branch: BRANCH, headSha: 'sha-happy',
        round: 1, commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
      },
    });
    run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('reviewing');

    // Late commit during reviewing must be a no-op for the watcher.
    runStep.mockClear();
    await simulateCommit();
    expect(runStep).not.toHaveBeenCalled();
    expect(usePipelineStore.getState().runs[runId].artifacts.ciResults).toHaveLength(1);

    const plan: PlanArtifact = usePipelineStore.getState().runs[runId].artifacts.plan!;
    expect(plan.planCommitSha).toBe('sha-plan-v1');
    expect(usePipelineStore.getState().runs[runId].planLineage).toEqual(['sha-plan-v1']);

    stop();
  });
});
