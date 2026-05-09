/**
 * Smoke test for the launch flow's template selector.
 *
 * Verifies that `templateId` routes through to the right template factory
 * by reading back the planner tile's `config.mode` (helloWorld stamps
 * `'planner-stub'`, Anthropic Trio stamps `'planner'`).
 *
 * Mocks live at the IPC + Tauri-path boundary; the run-factory, instantiate
 * pipeline, and Zustand stores all run for real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn().mockResolvedValue('/tmp/tx-test'),
  homeDir: vi.fn().mockResolvedValue('/tmp/tx-home'),
}));

vi.mock('@/utils/ipc', async (importActual) => {
  const real = await importActual<typeof import('@/utils/ipc')>();
  return {
    ...real,
    pipelinePreflight: vi.fn().mockResolvedValue({
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
      sensitive_paths_found: [],
      errors: [],
    }),
    pipelineWorktreeCreate: vi.fn().mockResolvedValue({ path: '/tmp/wt', branch: 'feat/x' }),
    pipelineWorktreeDestroy: vi.fn().mockResolvedValue(undefined),
    pipelineGuardrailsInstall: vi.fn().mockResolvedValue(undefined),
    pipelineCapabilitiesInstall: vi.fn().mockResolvedValue(undefined),
    pipelineTelemetryLog: vi.fn().mockResolvedValue(undefined),
    pipelineReadRolePrompt: vi.fn().mockRejectedValue(new Error('no such file')),
    readFileText: vi.fn().mockRejectedValue(new Error('no such file')),
    writeFileText: vi.fn().mockResolvedValue(undefined),
  };
});

import { launchPipelineRun } from './launch';
import { useProjectStore } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { AgentTile, PipelineRun, PipelineState } from '@/types';

const PROJECT_ID = 'proj-launch-test';
const PROJECT_CWD = '/tmp/proj-launch-test';

function seedProject() {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: 'Launch Test',
        icon: 'P',
        color: '#fff',
        description: 'test',
        cwd: PROJECT_CWD,
      },
    ],
    active: PROJECT_ID,
  });
}

function plannerTileMode(): string | undefined {
  const tiles = useCanvasStore.getState().tiles[PROJECT_ID] ?? [];
  const planner = tiles.find(
    (t): t is AgentTile => t.type === 'agent' && t.pipelineRole === 'planner',
  );
  return planner?.mode;
}

describe('launchPipelineRun template selection', () => {
  beforeEach(() => {
    seedProject();
    useCanvasStore.setState({ tiles: {}, wires: {}, activeProject: PROJECT_ID });
    usePipelineStore.setState({ runs: {} });
  });

  it('uses helloWorld template when templateId is tx.pipeline.hello-world', async () => {
    const result = await launchPipelineRun({
      goal: 'smoke',
      branch: 'feat/smoke',
      templateId: 'tx.pipeline.hello-world',
      confirmSensitivePaths: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(plannerTileMode()).toBe('planner-stub');
  });

  it('uses anthropicTrio template when templateId is tx.pipeline.anthropic-trio', async () => {
    const result = await launchPipelineRun({
      goal: 'real run',
      branch: 'feat/trio',
      templateId: 'tx.pipeline.anthropic-trio',
      confirmSensitivePaths: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(plannerTileMode()).toBe('planner');
  });

  it('falls back to anthropicTrio when templateId is unknown (logs warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await launchPipelineRun({
      goal: 'fallback',
      branch: 'feat/fallback',
      templateId: 'tx.pipeline.does-not-exist',
      confirmSensitivePaths: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(plannerTileMode()).toBe('planner');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown templateId "tx.pipeline.does-not-exist"'),
    );
    warn.mockRestore();
  });
});


describe('launchPipelineRun concurrent-run guard', () => {
  beforeEach(() => {
    seedProject();
    useCanvasStore.setState({ tiles: {}, wires: {}, activeProject: PROJECT_ID });
    usePipelineStore.setState({ runs: {} });
  });

  function fakeRun(overrides: Partial<PipelineRun> & { state: PipelineState }): PipelineRun {
    return {
      id: 'run-existing',
      templateId: 'tx.pipeline.anthropic-trio',
      projectId: PROJECT_ID,
      worktreePath: '/tmp/wt-existing',
      branch: 'feat/existing',
      baseBranch: 'main',
      artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
      retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 },
      startedAt: Date.now(),
      escalationLog: [],
      tiles: {},
      fingerprint: {
        templateId: 'tx',
        templateVersion: '1',
        terminalxVersion: '0.1.0',
        hash: 'h',
      } as unknown as PipelineRun['fingerprint'],
      planLineage: [],
      runMode: 'standard',
      autoApprovePlan: false,
      useDualReviewer: false,
      runRedTeam: false,
      effectiveRetryBudgets: { reviewerReject: 1, ciFail: 1, planReject: 1 },
      templateRetryBudget: { reviewerReject: 1, ciFail: 1, planReject: 1 },
      templateDualReviewer: false,
      ...overrides,
    };
  }

  it('rejects a second concurrent run on the same project', async () => {
    const existing = fakeRun({ state: 'building' });
    const result = await launchPipelineRun(
      {
        goal: 'second',
        branch: 'feat/second',
        templateId: 'tx.pipeline.hello-world',
        confirmSensitivePaths: async () => true,
      },
      { getStoreState: () => ({ runs: { [existing.id]: existing } }) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already-active');
    expect(result.error).toMatch(/Already have a pipeline run in building/);
    expect(result.error).toContain(existing.id);
  });

  it('allows a launch when the only run on the project is terminal', async () => {
    const existing = fakeRun({ state: 'done', endedAt: Date.now() });
    const result = await launchPipelineRun(
      {
        goal: 'next',
        branch: 'feat/next',
        templateId: 'tx.pipeline.hello-world',
        confirmSensitivePaths: async () => true,
      },
      { getStoreState: () => ({ runs: { [existing.id]: existing } }) },
    );
    expect(result.ok).toBe(true);
  });

  it('bypasses the guard when force: true', async () => {
    const existing = fakeRun({ state: 'planning' });
    const result = await launchPipelineRun(
      {
        goal: 'forced',
        branch: 'feat/forced',
        templateId: 'tx.pipeline.hello-world',
        confirmSensitivePaths: async () => true,
        force: true,
      },
      { getStoreState: () => ({ runs: { [existing.id]: existing } }) },
    );
    expect(result.ok).toBe(true);
  });
});
