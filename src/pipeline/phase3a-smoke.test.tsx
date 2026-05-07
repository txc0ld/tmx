/**
 * Phase 3a end-to-end smoke test.
 *
 * Sister test to `phase2c-{i,ii,iii}-smoke.test.tsx`. Phase 3a covered:
 *   - 3a.1: settings modal host (Zustand store + sidebar categories)
 *   - 3a.2: project sub-panel — webhookUrl form + https-only validation
 *   - 3a.3: sensitive-paths Acknowledge/Cancel modal + factory gate
 *   - 3a.4: pipeline-skills sub-panel — pipelineSkillStatus + force install
 *   - 3a.5: webhook re-cadence — Project.webhookCadence cumulative thresholds
 *   - 3a.6: marker convention unification (`_tx_pipeline_managed`) — Rust-side,
 *           covered by cargo tests.
 *   - 3a.7: sensitive-paths case-insensitive + symlink-aware — Rust-side.
 *
 * This file exercises the TS layer end-to-end with real reducer + real
 * settings store + real factory gate. IPC is mocked at the boundary only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// IPC-touching settings paths: project store calls `updateProjectInStore`,
// `PipelineSkillsSettings` calls `pipelineSkillStatus` + `pipelineForceInstallSkill`,
// the factory gate test stubs `pipelinePreflight`. Spread real exports so the rest
// of the surface (types, helpers) keeps working.
vi.mock('@/utils/ipc', async (importActual) => {
  const real = await importActual<typeof import('@/utils/ipc')>();
  return {
    ...real,
    loadProjects: vi.fn().mockResolvedValue([]),
    addProjectToStore: vi.fn().mockResolvedValue(undefined),
    updateProjectInStore: vi.fn().mockResolvedValue(undefined),
    deleteProjectFromStore: vi.fn().mockResolvedValue(undefined),
    pipelineSkillStatus: vi.fn(),
    pipelineForceInstallSkill: vi.fn(),
    httpFetch: vi.fn().mockResolvedValue({ status: 200, body: 'ok' }),
    secretsMask: vi.fn().mockImplementation(async (s: string) => s),
  };
});

import { SettingsModal } from '@/components/settings/SettingsModal';
import { useSettingsStore } from '@/stores/settingsStore';
import { ProjectSettings } from '@/components/settings/ProjectSettings';
import { PipelineSkillsSettings } from '@/components/settings/PipelineSkillsSettings';
import { useProjectStore } from '@/stores/projectStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import { createRunFromTemplate, type RunFactoryDeps } from './run-factory';
import { helloWorldTemplate } from './templates';
import {
  startWebhookNotifier,
  WEBHOOK_TICK_MS,
  type WebhookDeps,
} from './webhook-notifier';
import {
  pipelineSkillStatus,
  pipelineForceInstallSkill,
  httpFetch,
  secretsMask,
  type PreflightResult,
} from '@/utils/ipc';
import type { Project } from '@/types';

const mockedSkillStatus = pipelineSkillStatus as unknown as ReturnType<typeof vi.fn>;
const mockedForce = pipelineForceInstallSkill as unknown as ReturnType<typeof vi.fn>;
const httpFetchMock = httpFetch as unknown as ReturnType<typeof vi.fn>;
const secretsMaskMock = secretsMask as unknown as ReturnType<typeof vi.fn>;

const PROJECT_ID = 'proj-3a';
const PROJECT_CWD = '/tmp/proj-3a';
const WEBHOOK_URL = 'https://hooks.example.com/3a';

function seedProject(overrides: Partial<Project> = {}): Project {
  const project: Project = {
    id: PROJECT_ID,
    name: 'TerminalX 3a',
    icon: 'T',
    color: '#CCFF00',
    description: '',
    cwd: PROJECT_CWD,
    ...overrides,
  };
  useProjectStore.setState({ projects: [project], active: PROJECT_ID });
  return project;
}

function clean() {
  useProjectStore.setState({ projects: [], active: '' });
  useSettingsStore.setState({ open: false, category: 'project' });
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('Phase 3a smoke: settings modal + factory gate + skills + webhook cadence', () => {
  beforeEach(() => {
    clean();
    mockedSkillStatus.mockReset();
    mockedForce.mockReset();
    httpFetchMock.mockClear().mockResolvedValue({ status: 200, body: 'ok' });
    secretsMaskMock.mockClear().mockImplementation(async (s: string) => s);
  });

  afterEach(() => {
    cleanup();
    clean();
  });

  // 1. The settings modal host opens to a specific category through the
  //    Zustand store and renders its sidebar buttons + body.
  it('settings modal: openAt(category) flips state and renders panel', () => {
    seedProject();
    render(<SettingsModal />);

    // Initial: closed → nothing rendered.
    expect(screen.queryByTestId('settings-modal')).toBeNull();

    act(() => {
      useSettingsStore.getState().openAt('pipeline');
    });

    const state = useSettingsStore.getState();
    expect(state.open).toBe(true);
    expect(state.category).toBe('pipeline');

    // Modal renders, sidebar tabs all present, active panel is `pipeline`.
    expect(screen.getByTestId('settings-modal')).toBeTruthy();
    expect(screen.getByTestId('settings-category-project')).toBeTruthy();
    expect(screen.getByTestId('settings-category-pipeline')).toBeTruthy();
    expect(screen.getByTestId('settings-panel-pipeline')).toBeTruthy();
  });

  // 2. ProjectSettings persists webhookUrl AND the cadence radio through the
  //    real `updateProject` action — store ends up with the right shape.
  it('project sub-panel: typing a URL + saving updates the project store', async () => {
    seedProject();
    render(<ProjectSettings />);

    const input = screen.getByTestId('project-webhook-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://hooks.example.com/3a-typed' },
    });

    // Status flips to ready (validation ok + non-empty draft).
    expect(screen.getByTestId('project-webhook-status').textContent || '').toMatch(/ready/);

    await act(async () => {
      fireEvent.click(screen.getByTestId('project-settings-save'));
      await flushMicrotasks();
    });

    const project = useProjectStore.getState().projects.find((p) => p.id === PROJECT_ID);
    expect(project?.webhookUrl).toBe('https://hooks.example.com/3a-typed');
    // Default cadence ('entry-only') is normalized to undefined for tidy JSON.
    expect(project?.webhookCadence).toBeUndefined();
  });

  // 3. Sensitive-paths factory gate — user CANCELS → factory returns
  //    aborted:true and never inserts a run into the store.
  it('factory gate: cancel at sensitive-paths modal aborts run creation', async () => {
    seedProject();

    const preflightStub = vi.fn(async (): Promise<PreflightResult> => ({
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
    }));

    const confirm = vi.fn(async () => false);

    const deps: RunFactoryDeps = {
      readSkillContent: async () => null,
      readRolePrompt: async () => null,
      readRoleCapabilities: async () => null,
      readInvariants: async () => null,
      preflight: preflightStub,
      confirmSensitivePaths: confirm,
    };

    const result = await createRunFromTemplate({
      runId: 'run-cancel',
      template: helloWorldTemplate(),
      projectId: PROJECT_ID,
      worktreePath: '/tmp/wt',
      branch: 'feat/x',
      terminalxVersion: '0.1.0',
      projectDir: PROJECT_CWD,
      deps,
    });

    expect(result.aborted).toBe(true);
    expect(result.runId).toBe('');
    expect(preflightStub).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(['.env', 'secrets/id_rsa']);
    // Run was NOT inserted into the store.
    expect(usePipelineStore.getState().runs['run-cancel']).toBeUndefined();
  });

  // 4. Sensitive-paths factory gate — user ACKNOWLEDGES → factory creates
  //    the run normally.
  it('factory gate: acknowledge at sensitive-paths modal proceeds with run creation', async () => {
    seedProject();

    const deps: RunFactoryDeps = {
      readSkillContent: async (name) => `# ${name}\nbody`,
      readRolePrompt: async () => null,
      readRoleCapabilities: async () => null,
      readInvariants: async () => null,
      preflight: async () => ({
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
        sensitive_paths_found: ['.env'],
        errors: [],
      }),
      confirmSensitivePaths: async () => true,
    };

    const result = await createRunFromTemplate({
      runId: 'run-ack',
      template: helloWorldTemplate(),
      projectId: PROJECT_ID,
      worktreePath: '/tmp/wt',
      branch: 'feat/x',
      terminalxVersion: '0.1.0',
      projectDir: PROJECT_CWD,
      deps,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.runId).toBe('run-ack');
    expect(usePipelineStore.getState().runs['run-ack']).toBeDefined();
    expect(result.fingerprint.templateId).toBe(helloWorldTemplate().id);
  });

  // 5. PipelineSkillsSettings: clicking the per-row action button calls the
  //    force-install IPC with that skill's name (3a.4 contract).
  it('pipeline skills panel: click "Update from bundle" calls pipelineForceInstallSkill', async () => {
    mockedSkillStatus.mockResolvedValue([
      { name: 'tx-pipeline-stage-handoff', installed: true, hash_ok: true },
      { name: 'tx-pipeline-reviewer', installed: true, hash_ok: true },
    ]);
    mockedForce.mockResolvedValueOnce(undefined);

    render(<PipelineSkillsSettings />);

    await waitFor(() =>
      expect(
        screen.getByTestId('pipeline-skill-action-tx-pipeline-stage-handoff'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('pipeline-skill-action-tx-pipeline-stage-handoff'),
      );
      await flushMicrotasks();
    });

    expect(mockedForce).toHaveBeenCalledTimes(1);
    expect(mockedForce).toHaveBeenCalledWith('tx-pipeline-stage-handoff');
  });

  // 6. Webhook cadence — entry-only fires once on entry; 15min fires twice
  //    (entry + 15min reminder). Demonstrates 3a.5 cumulative thresholds.
  it('webhook cadence: entry-only fires once, 15min fires twice', async () => {
    vi.useFakeTimers();
    try {
      seedProject({ webhookUrl: WEBHOOK_URL, webhookCadence: 'entry-only' });

      // Manually push a run into awaiting_clarification — the only state that
      // matters for this test is `awaiting_*` so the notifier fires.
      usePipelineStore.setState({
        runs: {
          'r-cad': {
            id: 'r-cad',
            templateId: 'tmpl',
            projectId: PROJECT_ID,
            worktreePath: '/tmp/wt',
            branch: 'feat/cad',
            baseBranch: 'main',
            state: 'awaiting_clarification',
            artifacts: {
              builds: [],
              reviews: [],
              ciResults: [],
              questions: [
                {
                  stage: 'builder',
                  question: 'pick X or Y?',
                  context: '',
                  blocking: true,
                },
              ],
            },
            retryCounters: { reviewerReject: 0, ciFail: 0 },
            startedAt: Date.now(),
            escalationLog: [],
            tiles: {},
            fingerprint: {
              templateId: 'tmpl',
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
          },
        },
        activeRunIds: ['r-cad'],
      });

      const cadenceRef = { current: 'entry-only' as const };
      const deps: WebhookDeps = {
        getWebhookUrl: () => WEBHOOK_URL,
        getWebhookCadence: () =>
          cadenceRef.current as 'entry-only' | '15min',
        httpFetch: httpFetchMock as WebhookDeps['httpFetch'],
        secretsMask: secretsMaskMock as WebhookDeps['secretsMask'],
        deepLink: (id) => `terminalx://run/${id}`,
        getProjectName: () => 'TerminalX 3a',
      };

      const stop = startWebhookNotifier(deps);

      // First tick: entry POST.
      vi.advanceTimersByTime(WEBHOOK_TICK_MS);
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();

      expect(httpFetchMock).toHaveBeenCalledTimes(1);

      // Advance 16 minutes — entry-only must NOT re-fire.
      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      await flushMicrotasks();
      expect(httpFetchMock).toHaveBeenCalledTimes(1);

      stop();

      // Now switch to '15min' and prove a reminder fires at the 15min mark.
      // Reset bookkeeping by re-mounting the notifier on a fresh run id.
      httpFetchMock.mockClear();
      usePipelineStore.setState({ runs: {}, activeRunIds: [] });
      usePipelineStore.setState({
        runs: {
          'r-cad-2': {
            id: 'r-cad-2',
            templateId: 'tmpl',
            projectId: PROJECT_ID,
            worktreePath: '/tmp/wt',
            branch: 'feat/cad-2',
            baseBranch: 'main',
            state: 'awaiting_clarification',
            artifacts: {
              builds: [],
              reviews: [],
              ciResults: [],
              questions: [
                { stage: 'builder', question: 'q?', context: '', blocking: true },
              ],
            },
            retryCounters: { reviewerReject: 0, ciFail: 0 },
            startedAt: Date.now(),
            escalationLog: [],
            tiles: {},
            fingerprint: {
              templateId: 'tmpl',
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
          },
        },
        activeRunIds: ['r-cad-2'],
      });
      cadenceRef.current = '15min' as never;

      const stop2 = startWebhookNotifier({
        ...deps,
        getWebhookCadence: () => '15min',
      });

      // Entry tick.
      vi.advanceTimersByTime(WEBHOOK_TICK_MS);
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      expect(httpFetchMock).toHaveBeenCalledTimes(1);

      // Advance to 15min — reminder N=1 should fire.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      await flushMicrotasks();
      expect(httpFetchMock).toHaveBeenCalledTimes(2);

      stop2();
    } finally {
      vi.useRealTimers();
    }
  });

  // 7. Settings modal Escape key dismisses via the Zustand close().
  it('settings modal: Escape closes the modal via store.close()', () => {
    render(<SettingsModal />);

    act(() => {
      useSettingsStore.getState().openAt('project');
    });
    expect(screen.getByTestId('settings-modal')).toBeTruthy();

    // Modal's keydown listener is attached to `window`. Dispatch an Escape
    // there so the path runs end-to-end (instead of just calling close()).
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(useSettingsStore.getState().open).toBe(false);
    expect(screen.queryByTestId('settings-modal')).toBeNull();
  });
});
