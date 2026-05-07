/**
 * Phase 2c-ii end-to-end smoke test.
 *
 * Sister test to `phase2c-i-smoke.test.ts`. That suite covers the
 * factory → CI hook → escalation → re-plan path. This one focuses on
 * what's NEW in 2c-ii: the lifecycle handlers (guardrails install/uninstall +
 * per-role capability install/uninstall), the merger confirm-token flow, and
 * the discriminated-union telemetry events that wrap them.
 *
 * The smoke wires real handlers (`handleGuardrailsLifecycle`,
 * `handleCapabilitiesLifecycle`) into pipelineStore via the lifecycle
 * emitter — exactly as App.tsx does at boot — and drives `createRunFromTemplate`
 * + the reducer through every state transition. Only the four lifecycle IPCs
 * and the two merger IPCs are mocked; everything else uses real code paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/ipc', async (importActual) => {
  const real = await importActual<typeof import('@/utils/ipc')>();
  return {
    ...real,
    pipelineGuardrailsInstall: vi.fn().mockResolvedValue(undefined),
    pipelineGuardrailsUninstall: vi.fn().mockResolvedValue(undefined),
    pipelineCapabilitiesInstall: vi.fn().mockResolvedValue(undefined),
    pipelineCapabilitiesUninstall: vi.fn().mockResolvedValue(undefined),
    pipelineMergerRequestToken: vi.fn().mockResolvedValue('test-token'),
    pipelineMergerRun: vi.fn().mockResolvedValue({
      status: 'success',
      mode: 'pr',
      pr_url: 'https://github.com/x/y/pull/1',
      detail: '',
    }),
    readFileText: vi.fn().mockResolvedValue('# stub skill content'),
  };
});

import {
  usePipelineStore,
  setPipelineLifecycleEmitter,
  setPipelineTelemetryEmitter,
  emitTelemetry,
  type LifecycleEvent,
  type TelemetryEvent,
} from '@/stores/pipelineStore';
import {
  handleGuardrailsLifecycle,
  resetGuardrailsLifecycleForTest,
} from './guardrails-lifecycle';
import {
  handleCapabilitiesLifecycle,
  resetCapabilitiesLifecycleForTest,
} from './capabilities-lifecycle';
import { defaultRoleCapabilities } from './role-capabilities';
import { createRunFromTemplate, type RunFactoryDeps } from './run-factory';
import { helloWorldTemplate } from './templates';
import {
  pipelineGuardrailsInstall,
  pipelineGuardrailsUninstall,
  pipelineCapabilitiesInstall,
  pipelineCapabilitiesUninstall,
  pipelineMergerRequestToken,
  pipelineMergerRun,
} from '@/utils/ipc';

const guardInstall = pipelineGuardrailsInstall as unknown as ReturnType<typeof vi.fn>;
const guardUninstall = pipelineGuardrailsUninstall as unknown as ReturnType<typeof vi.fn>;
const capInstall = pipelineCapabilitiesInstall as unknown as ReturnType<typeof vi.fn>;
const capUninstall = pipelineCapabilitiesUninstall as unknown as ReturnType<typeof vi.fn>;
const mergerRequestToken = pipelineMergerRequestToken as unknown as ReturnType<typeof vi.fn>;
const mergerRun = pipelineMergerRun as unknown as ReturnType<typeof vi.fn>;

const WORKTREE = '/tmp/wt-2c-ii';
const BRANCH = 'feat/2c-ii-smoke';
const PROJECT_ID = 'proj-2c-ii';

const stubDeps = (overrides: Partial<RunFactoryDeps> = {}): RunFactoryDeps => ({
  readSkillContent: async (name) => `# ${name}\nstub body`,
  readRolePrompt: async () => null,
  readRoleCapabilities: async () => null,
  readInvariants: async () => null,
  ...overrides,
});

/** Drain microtasks so .then() handlers from mocked IPCs fire. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** Create + return a new pipeline run id, with a deterministic fingerprint. */
async function newRun(runId: string): Promise<string> {
  const tpl = helloWorldTemplate();
  const { runId: id } = await createRunFromTemplate({
    runId,
    template: tpl,
    projectId: PROJECT_ID,
    worktreePath: WORKTREE,
    branch: BRANCH,
    terminalxVersion: '0.1.0',
    deps: stubDeps(),
  });
  return id;
}

/**
 * Drive a run idle → planning → awaiting_plan_approval → building → reviewing →
 * awaiting_merge_approval, leaving it ready for the merger flow.
 */
function driveToAwaitingMergeApproval(runId: string): void {
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
      planCommitSha: 'sha-plan-v1',
    },
  });
  store.dispatch(runId, { type: 'approve_plan' });
  store.dispatch(runId, {
    type: 'builder_done',
    build: {
      stage: 'builder',
      branch: BRANCH,
      headSha: 'sha-build-1',
      round: 1,
      commits: [],
      filesChanged: [],
      testsAdded: [],
      ciStatus: 'green',
    },
  });
  store.dispatch(runId, {
    type: 'reviewer_done',
    verdict: {
      stage: 'reviewer',
      reviewer: 'opus',
      verdict: 'approve',
      round: 1,
      comments: [],
      summary: 'looks good',
    },
  });
}

describe('Phase 2c-ii smoke: lifecycle + merger + telemetry', () => {
  let captured: TelemetryEvent[];

  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    resetGuardrailsLifecycleForTest();
    resetCapabilitiesLifecycleForTest();

    guardInstall.mockClear().mockResolvedValue(undefined);
    guardUninstall.mockClear().mockResolvedValue(undefined);
    capInstall.mockClear().mockResolvedValue(undefined);
    capUninstall.mockClear().mockResolvedValue(undefined);
    mergerRequestToken.mockClear().mockResolvedValue('test-token');
    mergerRun.mockClear().mockResolvedValue({
      status: 'success',
      mode: 'pr',
      pr_url: 'https://github.com/x/y/pull/1',
      detail: '',
    });

    captured = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));
    setPipelineLifecycleEmitter((ev: LifecycleEvent) => {
      handleGuardrailsLifecycle(ev);
      handleCapabilitiesLifecycle(ev);
    });
  });

  afterEach(() => {
    setPipelineLifecycleEmitter(null);
    setPipelineTelemetryEmitter(null);
  });

  // 1. Guardrails install fires on idle → planning, uninstall on terminal,
  //    each emitting telemetry.
  it('guardrails: install on transition out of idle, uninstall on terminal', async () => {
    const runId = await newRun('r-guard-1');
    driveToAwaitingMergeApproval(runId);
    usePipelineStore.getState().dispatch(runId, { type: 'approve_merge' });
    usePipelineStore.getState().dispatch(runId, { type: 'merge_done' });

    await flushMicrotasks();

    expect(guardInstall).toHaveBeenCalledTimes(1);
    expect(guardInstall).toHaveBeenCalledWith(WORKTREE);
    expect(guardUninstall).toHaveBeenCalledTimes(1);
    expect(guardUninstall).toHaveBeenCalledWith(WORKTREE);

    const installEv = captured.find((e) => e.event === 'guardrails_install');
    const uninstallEv = captured.find((e) => e.event === 'guardrails_uninstall');
    expect(installEv).toMatchObject({
      event: 'guardrails_install',
      runId,
      projectId: PROJECT_ID,
      ok: true,
    });
    expect(uninstallEv).toMatchObject({
      event: 'guardrails_uninstall',
      runId,
      projectId: PROJECT_ID,
      ok: true,
    });
  });

  // 2. Capabilities: install/uninstall per role transition.
  it('capabilities: planner → builder → reviewer → uninstall on terminal', async () => {
    const runId = await newRun('r-caps-1');
    driveToAwaitingMergeApproval(runId);
    usePipelineStore.getState().dispatch(runId, { type: 'approve_merge' });
    usePipelineStore.getState().dispatch(runId, { type: 'merge_done' });

    await flushMicrotasks();

    // Install order: planner (idle → planning), builder (after awaiting_plan
    // step, into building), reviewer (building → reviewing).
    expect(capInstall).toHaveBeenCalledTimes(3);
    expect(capInstall).toHaveBeenNthCalledWith(1, {
      worktreeDir: WORKTREE,
      role: 'planner',
      capabilities: defaultRoleCapabilities('planner'),
    });
    expect(capInstall).toHaveBeenNthCalledWith(2, {
      worktreeDir: WORKTREE,
      role: 'builder',
      capabilities: defaultRoleCapabilities('builder'),
    });
    expect(capInstall).toHaveBeenNthCalledWith(3, {
      worktreeDir: WORKTREE,
      role: 'reviewer',
      capabilities: defaultRoleCapabilities('reviewer'),
    });

    // Uninstalls track every role-leaving transition. Concretely:
    //   planning → awaiting_plan_approval (drop planner)
    //   building → reviewing               (drop builder)
    //   reviewing → awaiting_merge_approval (drop reviewer)
    // Terminal (merging → done) doesn't add another uninstall — the active
    // role was already cleared on reviewing → awaiting_merge_approval.
    expect(capUninstall).toHaveBeenCalledTimes(3);
    expect(capUninstall).toHaveBeenNthCalledWith(1, {
      worktreeDir: WORKTREE,
      role: 'planner',
    });
    expect(capUninstall).toHaveBeenNthCalledWith(2, {
      worktreeDir: WORKTREE,
      role: 'builder',
    });
    expect(capUninstall).toHaveBeenNthCalledWith(3, {
      worktreeDir: WORKTREE,
      role: 'reviewer',
    });

    // Each install + uninstall emits telemetry.
    const installs = captured.filter((e) => e.event === 'capability_install');
    const uninstalls = captured.filter((e) => e.event === 'capability_uninstall');
    expect(installs.map((e) => e.event === 'capability_install' && e.role)).toEqual([
      'planner',
      'builder',
      'reviewer',
    ]);
    expect(uninstalls.map((e) => e.event === 'capability_uninstall' && e.role)).toEqual([
      'planner',
      'builder',
      'reviewer',
    ]);
    for (const ev of [...installs, ...uninstalls]) {
      expect(ev).toMatchObject({ runId, projectId: PROJECT_ID, ok: true });
    }
  });

  // 3. Merger flow — drive the IPCs the way MergerConfirmModal does, verify
  //    the token/run pair plus telemetry. The full button-click flow is
  //    covered by MergerConfirmModal.test.tsx; here we only prove that the
  //    lifecycle composition (caps + guardrails + telemetry) plays nice
  //    with the merger transitions.
  it('merger: token requested + passed to run, success transitions to done', async () => {
    const runId = await newRun('r-merger-1');
    driveToAwaitingMergeApproval(runId);

    let run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('awaiting_merge_approval');

    // Mirror the modal's sequence (see MergerConfirmModal.tsx):
    //   approve_merge → emit merger_invoked → request token → run merger →
    //   emit merger_completed → merge_done | merge_failed.
    const store = usePipelineStore.getState();
    store.dispatch(runId, { type: 'approve_merge' });
    emitTelemetry({
      at: Date.now(),
      event: 'merger_invoked',
      runId,
      projectId: PROJECT_ID,
    });

    const token = await pipelineMergerRequestToken(runId);
    const result = await pipelineMergerRun({
      runId,
      projectDir: '/proj',
      branch: BRANCH,
      baseBranch: 'main',
      confirmToken: token,
    });

    emitTelemetry({
      at: Date.now(),
      event: 'merger_completed',
      runId,
      projectId: PROJECT_ID,
      status: result.status,
      mode: result.mode,
      detail: result.detail || undefined,
    });
    store.dispatch(runId, { type: 'merge_done' });

    await flushMicrotasks();

    expect(mergerRequestToken).toHaveBeenCalledTimes(1);
    expect(mergerRequestToken).toHaveBeenCalledWith(runId);
    expect(mergerRun).toHaveBeenCalledTimes(1);
    expect(mergerRun).toHaveBeenCalledWith({
      runId,
      projectDir: '/proj',
      branch: BRANCH,
      baseBranch: 'main',
      confirmToken: 'test-token',
    });

    run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('done');

    const invoked = captured.find((e) => e.event === 'merger_invoked');
    const completed = captured.find((e) => e.event === 'merger_completed');
    expect(invoked).toMatchObject({
      event: 'merger_invoked',
      runId,
      projectId: PROJECT_ID,
    });
    expect(completed).toMatchObject({
      event: 'merger_completed',
      runId,
      projectId: PROJECT_ID,
      status: 'success',
      mode: 'pr',
    });

    // Guardrails uninstalled on done; capability uninstalls still match the
    // role-leaving pattern from case 2.
    expect(guardUninstall).toHaveBeenCalledTimes(1);
  });

  // 4. Direct idle → failed (preflight abort): both install AND uninstall
  //    fire on the same transition. The reducer routes `abort` from idle to
  //    `failed`, and the guardrails handler is explicit about both effects
  //    firing on a single boundary-crossing transition.
  it('idle → failed (abort) fires guardrails install + uninstall in one shot', async () => {
    const runId = await newRun('r-abort-1');
    usePipelineStore.getState().dispatch(runId, {
      type: 'abort',
      reason: 'preflight failed',
    });

    await flushMicrotasks();

    expect(guardInstall).toHaveBeenCalledTimes(1);
    expect(guardUninstall).toHaveBeenCalledTimes(1);

    // No capability install/uninstall — abort from idle leaves no active
    // role to scope (idle has no role; failed is terminal).
    expect(capInstall).not.toHaveBeenCalled();
    expect(capUninstall).not.toHaveBeenCalled();

    const installEv = captured.find((e) => e.event === 'guardrails_install');
    const uninstallEv = captured.find((e) => e.event === 'guardrails_uninstall');
    expect(installEv).toMatchObject({ runId, ok: true });
    expect(uninstallEv).toMatchObject({ runId, ok: true });
  });

  // 5. Replan re-entry (escalated → planning): planner caps re-installed.
  it('escalated → planning replan re-installs planner caps', async () => {
    const runId = await newRun('r-replan-1');
    const store = usePipelineStore.getState();

    // Drive idle → planning → escalated via 4 ci_fails (after a planner_done +
    // approve_plan to legally enter `building`).
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
        planCommitSha: 'sha-plan-v1',
      },
    });
    store.dispatch(runId, { type: 'approve_plan' });
    for (let i = 0; i < 4; i++) {
      store.dispatch(runId, {
        type: 'ci_fail',
        result: {
          sha: `sha-${i}`,
          status: 'fail',
          step: 'test',
          command: 'npm test',
          durationMs: 1,
          failures: [],
        },
      });
    }

    await flushMicrotasks();
    expect(usePipelineStore.getState().runs[runId].state).toBe('escalated');

    // Snapshot install counts so we can assert NEW calls after replan.
    const installsBefore = capInstall.mock.calls.length;
    const guardUninstallsBefore = guardUninstall.mock.calls.length;

    usePipelineStore.getState().dispatch(runId, {
      type: 'replan_requested',
      reason: 'four ci_fails',
    });

    await flushMicrotasks();
    expect(usePipelineStore.getState().runs[runId].state).toBe('planning');

    // A fresh planner caps install fires on escalated → planning.
    expect(capInstall.mock.calls.length).toBe(installsBefore + 1);
    const lastInstall = capInstall.mock.calls[capInstall.mock.calls.length - 1];
    expect(lastInstall[0]).toMatchObject({
      worktreeDir: WORKTREE,
      role: 'planner',
    });

    // Guardrails install is NOT fired again (deduped by run-id bookkeeping),
    // and the prior uninstall flag resets so a future terminal crossing fires.
    expect(guardInstall).toHaveBeenCalledTimes(1);
    expect(guardUninstall.mock.calls.length).toBe(guardUninstallsBefore);
  });

  // 6. Telemetry event shape — assert the discriminated union is honored.
  it('telemetry event shape: lifecycle has {ok, role?}, merger has {status?, mode?, detail?}', async () => {
    const runId = await newRun('r-shape-1');
    driveToAwaitingMergeApproval(runId);
    usePipelineStore.getState().dispatch(runId, { type: 'approve_merge' });
    emitTelemetry({
      at: Date.now(),
      event: 'merger_invoked',
      runId,
      projectId: PROJECT_ID,
    });
    emitTelemetry({
      at: Date.now(),
      event: 'merger_completed',
      runId,
      projectId: PROJECT_ID,
      status: 'success',
      mode: 'pr',
    });
    usePipelineStore.getState().dispatch(runId, { type: 'merge_done' });
    await flushMicrotasks();

    for (const ev of captured) {
      expect(typeof ev.at).toBe('number');
      expect(ev.runId).toBe(runId);
      expect(ev.projectId).toBe(PROJECT_ID);

      switch (ev.event) {
        case 'state_change':
          expect(typeof ev.from).toBe('string');
          expect(typeof ev.to).toBe('string');
          expect(typeof ev.trigger).toBe('string');
          break;
        case 'guardrails_install':
        case 'guardrails_uninstall':
          expect(typeof ev.ok).toBe('boolean');
          // role MUST be undefined on guardrails events (worktree-wide).
          expect((ev as { role?: unknown }).role).toBeUndefined();
          break;
        case 'capability_install':
        case 'capability_uninstall':
          expect(typeof ev.ok).toBe('boolean');
          expect(typeof ev.role).toBe('string');
          break;
        case 'merger_invoked':
          // No status / mode / detail on invoked.
          expect((ev as { status?: unknown }).status).toBeUndefined();
          expect((ev as { mode?: unknown }).mode).toBeUndefined();
          break;
        case 'merger_completed':
          expect(['success', 'failure', 'invalid_token']).toContain(ev.status);
          expect(['pr', 'local', 'unknown']).toContain(ev.mode);
          break;
      }
    }

    // Sanity: at least one of every category we exercised landed.
    expect(captured.some((e) => e.event === 'guardrails_install')).toBe(true);
    expect(captured.some((e) => e.event === 'guardrails_uninstall')).toBe(true);
    expect(captured.some((e) => e.event === 'capability_install')).toBe(true);
    expect(captured.some((e) => e.event === 'capability_uninstall')).toBe(true);
    expect(captured.some((e) => e.event === 'merger_invoked')).toBe(true);
    expect(captured.some((e) => e.event === 'merger_completed')).toBe(true);
    expect(captured.some((e) => e.event === 'state_change')).toBe(true);
  });

  // 7. Capability install error → telemetry has ok:false with truncated error.
  it('capability install IPC failure surfaces as ok:false telemetry with truncated error', async () => {
    const huge = 'x'.repeat(1200);
    capInstall.mockRejectedValueOnce(new Error(huge));

    const runId = await newRun('r-err-1');
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    await flushMicrotasks();

    const ev = captured.find((e) => e.event === 'capability_install');
    expect(ev).toMatchObject({
      event: 'capability_install',
      runId,
      role: 'planner',
      ok: false,
    });
    if (ev && ev.event === 'capability_install') {
      expect(ev.error).toBeDefined();
      expect(ev.error!.length).toBeLessThanOrEqual(500);
    }
  });
});
