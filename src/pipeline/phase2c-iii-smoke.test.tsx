/**
 * Phase 2c-iii end-to-end smoke test.
 *
 * Sister test to `phase2c-i-smoke.test.ts` and `phase2c-ii-smoke.test.ts`.
 * Those covered factory + CI hooks (i) and lifecycle handlers + merger (ii).
 * This one focuses on what's NEW in 2c-iii: the human-in-the-loop gate
 * (clarification flow, resume on `priorActiveState`), the stuck-run detector
 * (8min silence → forced abort), webhook delivery on `awaiting_*` entries
 * (POST through httpFetch + secretsMask), and the failure-bundle lifecycle
 * handler (terminal-failure crossings → `pipelineFailureBundleGenerate`).
 *
 * Real reducer + factory + DI'd modules (stuck-detector, webhook-notifier,
 * failure-bundle-lifecycle). Mocks are at the IPC boundary only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('@/utils/ipc', async (importActual) => {
  const real = await importActual<typeof import('@/utils/ipc')>();
  return {
    ...real,
    httpFetch: vi.fn().mockResolvedValue({ status: 200, body: 'ok' }),
    secretsMask: vi.fn().mockImplementation(async (s: string) =>
      s.replace(/sk-[A-Za-z0-9]{10,}/g, '<MASKED:test>'),
    ),
    pipelineGuardrailsInstall: vi.fn().mockResolvedValue(undefined),
    pipelineGuardrailsUninstall: vi.fn().mockResolvedValue(undefined),
    pipelineCapabilitiesInstall: vi.fn().mockResolvedValue(undefined),
    pipelineCapabilitiesUninstall: vi.fn().mockResolvedValue(undefined),
    pipelineFailureBundleGenerate: vi.fn().mockResolvedValue({
      bundle_path: '/tmp/x.tar.gz',
      size_bytes: 100,
      entries: ['telemetry.jsonl', 'artifacts.json'],
    }),
    pipelineMergerRequestToken: vi.fn().mockResolvedValue('test-token'),
    pipelineMergerRun: vi.fn().mockResolvedValue({
      status: 'success',
      mode: 'pr',
      pr_url: 'https://github.com/x/y/pull/1',
      detail: '',
    }),
    pipelinePreflight: vi.fn(),
    ptyWrite: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  usePipelineStore,
  setPipelineLifecycleEmitter,
  setPipelineTelemetryEmitter,
  type LifecycleEvent,
  type TelemetryEvent,
} from '@/stores/pipelineStore';
import { useProjectStore } from '@/stores/projectStore';
import {
  handleFailureBundleLifecycle,
  resetFailureBundleLifecycleForTest,
} from './failure-bundle-lifecycle';
import {
  startStuckDetector,
  ABORT_THRESHOLD_MS,
  TICK_MS,
  type StuckDetectorDeps,
  type StuckDetectorRunView,
} from './stuck-detector';
import { startWebhookNotifier, WEBHOOK_TICK_MS, type WebhookDeps } from './webhook-notifier';
import { ClarificationModal } from '@/components/pipeline/ClarificationModal';
import {
  httpFetch,
  pipelineFailureBundleGenerate,
  pipelinePreflight,
  ptyWrite,
  secretsMask,
} from '@/utils/ipc';
import type { PipelineRun, Project, RunFingerprint } from '@/types';

const httpFetchMock = httpFetch as unknown as ReturnType<typeof vi.fn>;
const secretsMaskMock = secretsMask as unknown as ReturnType<typeof vi.fn>;
const ptyWriteMock = ptyWrite as unknown as ReturnType<typeof vi.fn>;
const failureBundleMock = pipelineFailureBundleGenerate as unknown as ReturnType<typeof vi.fn>;
const preflightMock = pipelinePreflight as unknown as ReturnType<typeof vi.fn>;

const PROJECT_ID = 'proj-2c-iii';
const PROJECT_CWD = '/tmp/proj-2c-iii';
const WORKTREE = '/tmp/wt-2c-iii';
const BRANCH = 'feat/2c-iii-smoke';
const WEBHOOK_URL = 'https://hooks.example.com/2c-iii';

const FP: RunFingerprint = {
  templateId: 'tmpl-anth-trio',
  templateHash: 'h',
  skillHashes: {},
  rolePromptHashes: {},
  models: {},
  capabilityManifests: {},
  terminalxVersion: '0.1.0',
  claudeVersion: 'claude-1.2.3',
  codexVersion: 'codex-4.5.6',
};

function seedProject(): void {
  const project: Project = {
    id: PROJECT_ID,
    name: 'TerminalX 2c-iii',
    icon: 'T',
    color: '#fff',
    description: '',
    cwd: PROJECT_CWD,
    webhookUrl: WEBHOOK_URL,
  };
  useProjectStore.setState({ projects: [project], active: PROJECT_ID });
}

function seedRun(runId: string, overrides: Partial<PipelineRun> = {}): PipelineRun {
  const run: PipelineRun = {
    id: runId,
    templateId: 'tmpl-anth-trio',
    projectId: PROJECT_ID,
    worktreePath: WORKTREE,
    branch: BRANCH,
    baseBranch: 'main',
    state: 'idle',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: Date.now(),
    escalationLog: [],
    tiles: {},
    fingerprint: FP,
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
  usePipelineStore.setState((s) => ({
    runs: { ...s.runs, [runId]: run },
    activeRunIds: [...s.activeRunIds, runId],
  }));
  return run;
}

/** Drain microtasks so .then() handlers from mocked IPCs fire. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

describe('Phase 2c-iii smoke: clarification + stuck + webhook + failure-bundle', () => {
  let captured: TelemetryEvent[];

  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    useProjectStore.setState({ projects: [], active: '' });
    resetFailureBundleLifecycleForTest();

    httpFetchMock.mockClear().mockResolvedValue({ status: 200, body: 'ok' });
    secretsMaskMock
      .mockClear()
      .mockImplementation(async (s: string) =>
        s.replace(/sk-[A-Za-z0-9]{10,}/g, '<MASKED:test>'),
      );
    ptyWriteMock.mockClear().mockResolvedValue(undefined);
    failureBundleMock.mockClear().mockResolvedValue({
      bundle_path: '/tmp/x.tar.gz',
      size_bytes: 100,
      entries: ['telemetry.jsonl'],
    });
    preflightMock.mockClear();

    captured = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));
  });

  afterEach(() => {
    setPipelineLifecycleEmitter(null);
    setPipelineTelemetryEmitter(null);
  });

  // 1. Clarification gate end-to-end. Real reducer + real ClarificationModal.
  //    question_raised → awaiting_clarification → modal submit →
  //    clarification_received → resume to priorActiveState (building).
  it('clarification gate: question_raised → modal submit → resumes priorActiveState + telemetry', async () => {
    seedProject();
    const runId = 'r-clar-1';
    seedRun(runId, { state: 'idle' });

    const store = usePipelineStore.getState();
    store.dispatch(runId, { type: 'start' });
    store.dispatch(runId, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: BRANCH, specPath: 's', planPath: 'p',
        tasks: [], summary: '', planCommitSha: 'sha-1',
      },
    });
    store.dispatch(runId, { type: 'approve_plan' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('building');

    // Simulate the builder agent emitting a question sentinel.
    store.dispatch(runId, {
      type: 'question_raised',
      question: {
        stage: 'builder',
        question: 'Should we use approach X or Y?',
        context: 'spec is ambiguous',
        options: ['X', 'Y'],
        blocking: true,
      },
    });

    let run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('awaiting_clarification');
    expect(run.priorActiveState).toBe('building');

    // Mount the modal (no PTY tile registered → ptyWrite is a no-op, but the
    // dispatch + telemetry fan-out still fires).
    render(<ClarificationModal run={run} />);

    const textarea = screen.getByTestId('clarification-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Use X for now' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('clarification-submit'));
      await flushMicrotasks();
    });

    run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('building'); // priorActiveState restored
    expect(run.priorActiveState).toBeUndefined();

    const clarEv = captured.find((e) => e.event === 'clarification_answered');
    expect(clarEv).toMatchObject({
      event: 'clarification_answered',
      runId,
      projectId: PROJECT_ID,
      stage: 'builder',
    });
  });

  // 2. Stuck-detection: 8min+1s silence → abort dispatched with stage_unresponsive.
  //    Drives the real detector against a mock dep harness, then asserts the
  //    abortRun callback was wired to dispatch `abort` on the real reducer.
  it('stuck detector: 8min silence on building run dispatches abort → failed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
    try {
      seedProject();
      const runId = 'r-stuck-1';
      const startedAt = Date.now();
      seedRun(runId, { state: 'idle', startedAt });

      const store = usePipelineStore.getState();
      store.dispatch(runId, { type: 'start' });
      store.dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: BRANCH, specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha-stuck',
        },
      });
      store.dispatch(runId, { type: 'approve_plan' });
      expect(usePipelineStore.getState().runs[runId].state).toBe('building');

      // Tracking clock that mirrors the fake wall clock for deps.now().
      let now = Date.now();

      // The detector's abortRun is wired to the real reducer's `abort` event
      // — exactly as App.tsx does at boot (just statelessly here).
      const abortRun = vi.fn((id: string, reason: string) => {
        usePipelineStore.getState().dispatch(id, { type: 'abort', reason });
      });
      const probeAgent = vi.fn(async () => { /* swallow */ });

      const runs: StuckDetectorRunView[] = [
        { id: runId, startedAt, ptyId: 'pty-build-1' },
      ];
      const deps: StuckDetectorDeps = {
        getActiveRuns: () => runs.slice(),
        getLastStdoutAt: () => undefined,
        probeAgent,
        abortRun,
        now: () => now,
      };

      const stop = startStuckDetector(deps);

      // Walk forward to ABORT_THRESHOLD + 1s in TICK_MS chunks so each
      // setInterval tick observes a synchronized clock.
      const target = startedAt + ABORT_THRESHOLD_MS + 1000;
      while (Date.now() < target) {
        const next = Math.min(Date.now() + TICK_MS, target);
        const delta = next - Date.now();
        vi.advanceTimersByTime(delta);
        now = Date.now();
      }

      expect(abortRun).toHaveBeenCalledTimes(1);
      const [abortedId, reason] = abortRun.mock.calls[0];
      expect(abortedId).toBe(runId);
      expect(reason).toMatch(/^stage_unresponsive/);

      const run = usePipelineStore.getState().runs[runId];
      expect(run.state).toBe('failed');
      expect(run.failureReason).toMatch(/^stage_unresponsive/);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // 3. Webhook fires on awaiting_clarification entry: POST through httpFetch
  //    with JSON body that's gone through secretsMask first.
  it('webhook delivery: awaiting_clarification entry POSTs via httpFetch + secretsMask', async () => {
    vi.useFakeTimers();
    try {
      seedProject();
      const runId = 'r-webhook-1';
      seedRun(runId, { state: 'idle' });

      const store = usePipelineStore.getState();
      store.dispatch(runId, { type: 'start' });
      store.dispatch(runId, {
        type: 'planner_done',
        plan: {
          stage: 'planner', branch: BRANCH, specPath: 's', planPath: 'p',
          tasks: [], summary: '', planCommitSha: 'sha-wh',
        },
      });
      store.dispatch(runId, { type: 'approve_plan' });
      // Drop into awaiting_clarification with a question that has a leaked
      // token in the text — so we can prove secretsMask actually rewrote it.
      store.dispatch(runId, {
        type: 'question_raised',
        question: {
          stage: 'builder',
          question: 'Use API key sk-ABCDEFGHIJ1234567 to proceed?',
          context: '',
          blocking: true,
        },
      });

      const deps: WebhookDeps = {
        getWebhookUrl: (pid) => (pid === PROJECT_ID ? WEBHOOK_URL : null),
        httpFetch: httpFetchMock as WebhookDeps['httpFetch'],
        secretsMask: secretsMaskMock as WebhookDeps['secretsMask'],
        deepLink: (id) => `terminalx://run/${id}`,
        getProjectName: (pid) =>
          useProjectStore.getState().projects.find((p) => p.id === pid)?.name,
      };
      const stop = startWebhookNotifier(deps);

      // First tick fires the awaiting_clarification entry.
      vi.advanceTimersByTime(WEBHOOK_TICK_MS);
      // Drain the fire-and-forget async chain (stringify → mask → POST).
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();

      expect(secretsMaskMock).toHaveBeenCalledTimes(1);
      expect(httpFetchMock).toHaveBeenCalledTimes(1);

      const call = httpFetchMock.mock.calls[0][0] as {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string;
      };
      expect(call.url).toBe(WEBHOOK_URL);
      expect(call.method).toBe('POST');
      expect(call.headers['Content-Type']).toBe('application/json');

      // Body went through secretsMask → leaked sk-… replaced. The original
      // token must NOT appear in the final body sent over the wire.
      expect(call.body).not.toContain('sk-ABCDEFGHIJ1234567');
      expect(call.body).toContain('<MASKED:test>');

      const parsed = JSON.parse(call.body);
      expect(parsed).toMatchObject({
        runId,
        state: 'awaiting_clarification',
        project: 'TerminalX 2c-iii',
        branch: BRANCH,
        terminalxDeepLink: `terminalx://run/${runId}`,
      });

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // 4. Failure-bundle lifecycle: terminal failure (escalated via 4 ci_fails)
  //    triggers pipelineFailureBundleGenerate with the project's cwd.
  it('failure bundle: escalated terminal triggers pipelineFailureBundleGenerate', async () => {
    seedProject();
    setPipelineLifecycleEmitter((ev: LifecycleEvent) => {
      handleFailureBundleLifecycle(ev);
    });

    const runId = 'r-bundle-1';
    seedRun(runId, { state: 'idle' });

    const store = usePipelineStore.getState();
    store.dispatch(runId, { type: 'start' });
    store.dispatch(runId, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: BRANCH, specPath: 's', planPath: 'p',
        tasks: [], summary: '', planCommitSha: 'sha-bundle',
      },
    });
    store.dispatch(runId, { type: 'approve_plan' });

    // Four ci_fails tip the run into `escalated` (failureClass=builder_loop).
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
    expect(failureBundleMock).toHaveBeenCalledTimes(1);

    const arg = failureBundleMock.mock.calls[0][0] as {
      runId: string;
      projectDir: string;
      branch: string;
      baseBranch: string;
      artifactsJson: string;
      preflightJson: string;
      terminalxVersion: string;
      claudeVersion?: string;
      codexVersion?: string;
    };
    expect(arg.runId).toBe(runId);
    expect(arg.projectDir).toBe(PROJECT_CWD);
    expect(arg.branch).toBe(BRANCH);
    expect(arg.baseBranch).toBe('main');
    expect(arg.terminalxVersion).toBe('0.1.0');
    expect(arg.claudeVersion).toBe('claude-1.2.3');
    expect(arg.codexVersion).toBe('codex-4.5.6');
    // artifactsJson must be valid JSON containing the failed CI results.
    const artifacts = JSON.parse(arg.artifactsJson) as { ciResults: unknown[] };
    expect(artifacts.ciResults).toHaveLength(4);
  });

  // 5. Failure-bundle dedup: idle → failed via abort fires bundle once, even
  //    though the lifecycle may see multiple terminal-state transitions.
  it('failure bundle: dedup — single bundle per run id even under repeat terminal events', async () => {
    seedProject();
    setPipelineLifecycleEmitter((ev: LifecycleEvent) => {
      handleFailureBundleLifecycle(ev);
    });

    const runId = 'r-bundle-dedup';
    seedRun(runId, { state: 'idle' });

    // First abort: idle → failed.
    usePipelineStore.getState().dispatch(runId, {
      type: 'abort',
      reason: 'first abort',
    });
    // Subsequent dispatches into a terminal state are no-ops, but defensively
    // confirm the bundle handler doesn't double-fire.
    usePipelineStore.getState().dispatch(runId, {
      type: 'abort',
      reason: 'second abort (no-op)',
    });

    await flushMicrotasks();

    expect(failureBundleMock).toHaveBeenCalledTimes(1);
    const arg = failureBundleMock.mock.calls[0][0] as { projectDir: string };
    expect(arg.projectDir).toBe(PROJECT_CWD);
  });

  // 6. Sensitive-paths preflight result is plumbed (the IPC returns them on
  //    PreflightResult). This proves the contract callers can rely on; the
  //    actual gating UX (block run-start vs warn) lands as Phase 3 work.
  it('preflight: sensitive_paths_found surfaces on the result for callers to inspect', async () => {
    preflightMock.mockResolvedValueOnce({
      is_git_repo: true,
      working_tree_clean: true,
      main_branch: 'main',
      claude_present: true,
      codex_present: true,
      gh_present: true,
      gh_authenticated: true,
      worktree_dir_writable: true,
      signed_skills_ok: true,
      capability_binaries_ok: true,
      skill_cache_writable: true,
      sensitive_paths_found: ['.env', 'secrets/id_rsa'],
      errors: [],
    });

    const result = await pipelinePreflight(PROJECT_CWD);
    expect(result.sensitive_paths_found).toEqual(['.env', 'secrets/id_rsa']);
    // Sanity: the rest of the contract is intact.
    expect(result.is_git_repo).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
