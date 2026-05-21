import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Critical-path E2E for the pipeline launch flow.
 *
 * The unit-test suite has 776 tests but they're all module-scoped — none
 * of them mount `<App />`, click the real Pipeline button, type into the
 * real `<StartPipelineRunModal>`, and assert that `pipelineStore.runs`
 * contains a fresh run after the launch flow's IPC tour. The
 * `ingestPtyChunk only called from tests` regression that motivated this
 * scaffold is exactly the kind of integration gap that this test catches:
 * a bug where the wiring between modules was wrong even though every
 * module's unit tests were green.
 *
 * Strategy:
 *   1. Inject the mock-Tauri bridge BEFORE the SPA bundle runs so every
 *      `invoke()` resolves with deterministic fixtures (no PTYs spawned,
 *      no real worktree on disk, no skill installs).
 *   2. Navigate to `/`, wait for the SPA to mount.
 *   3. Seed a project + active state through the `__TX_E2E__` test seam
 *      (faster + more deterministic than driving the project sidebar).
 *   4. Click the real Pipeline button.
 *   5. Type into the real modal, click Submit.
 *   6. Assert: modal closes; pipelineStore has a run; the run's tiles
 *      list includes a `pipeline-controller` tile id.
 *   7. Take a screenshot for visual regression baselines.
 */

const MOCK_INIT_SCRIPT = path.join(
  __dirname,
  'setup',
  'mockTauri.init.js',
);

test.beforeEach(async ({ page }) => {
  // Pipe browser console to the test runner so a failed mock surfaces in
  // the test output instead of being silently swallowed.
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      // eslint-disable-next-line no-console
      console.log(`[browser ${t}]`, msg.text());
    }
  });
  page.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log('[browser pageerror]', err.message);
  });

  await page.addInitScript({ path: MOCK_INIT_SCRIPT });
});

test('user can launch a pipeline run from the TopBar', async ({ page }) => {
  await page.goto('/');

  // SPA boot — wait for the test seam to populate. `__TX_E2E__` is set
  // synchronously in main.tsx after Zustand stores import, so this lands
  // within a few ms of first paint.
  await page.waitForFunction(() => Boolean(window.__TX_E2E__), null, {
    timeout: 10_000,
  });

  // Seed a project. `addProject` would round-trip through (mocked) IPC
  // which is fine, but the simpler path is direct state mutation: set
  // both the project and the active id through the public store API.
  await page.evaluate(() => {
    const seam = window.__TX_E2E__!;
    const project = {
      id: 'e2e-project',
      name: 'E2E Project',
      icon: 'box',
      color: '#22aaff',
      description: 'Seeded by Playwright',
      cwd: '/tmp/e2e-project',
      gitUrl: undefined,
      branch: 'main',
      webhookUrl: undefined,
      webhookCadence: 'entry-only' as const,
    };
    // Directly set state — bypasses the IPC roundtrip (mocked anyway) and
    // sidesteps the canvas-switch side effect race that addProject has.
    seam.projectStore.setState({
      projects: [project],
      active: project.id,
      loading: false,
    });
    seam.canvasStore.getState().switchProject(project.id);
  });

  // Pipeline button is data-testid'd in TopBar.tsx. It's enabled once the
  // active project resolves; the seed above is synchronous so the button
  // should be ready immediately on next tick.
  const pipelineBtn = page.getByTestId('topbar-pipeline-button');
  await expect(pipelineBtn).toBeEnabled();
  await pipelineBtn.click();

  // Modal renders.
  const modal = page.getByTestId('start-pipeline-run-modal');
  await expect(modal).toBeVisible();

  // Fill the form. Goal textarea, leave branch + template at their
  // defaults — the modal seeds a fresh branch name on mount.
  const goal = page.getByTestId('start-pipeline-run-goal');
  await goal.fill('test E2E launch');

  const submit = page.getByTestId('start-pipeline-run-submit');
  await expect(submit).toBeEnabled();
  await submit.click();

  // Modal closes on success — assert disappearance, not just the close
  // event, so a "stuck on success" regression fails the test.
  await expect(modal).toBeHidden({ timeout: 10_000 });

  // pipelineStore now has a run.
  const runSummary = await page.evaluate(() => {
    const runs = window.__TX_E2E__!.pipelineStore.getState().runs;
    const ids = Object.keys(runs);
    if (ids.length === 0) return null;
    const first = runs[ids[0]];
    return {
      id: first.id,
      state: first.state,
      projectId: first.projectId,
      worktreePath: first.worktreePath,
    };
  });

  expect(runSummary).not.toBeNull();
  expect(runSummary!.projectId).toBe('e2e-project');
  // The launch flow inserts the run in `idle`. Phase 2c+ planner kick
  // would transition to `planning`, but since we haven't wired the agent
  // PTY mock to emit a sentinel, `idle` is the expected resting state.
  expect(['idle', 'planning']).toContain(runSummary!.state);
  expect(runSummary!.worktreePath).toContain(runSummary!.id);

  // Pipeline controller + agent tiles are on the canvas. Assert via
  // canvasStore (the source of truth) rather than DOM — TileShell
  // doesn't carry tile-id attributes today, so a DOM probe would
  // require a production code change to assert against.
  const tileTypes = await page.evaluate((projectId) => {
    const cs = window.__TX_E2E__!.canvasStore.getState();
    const tiles = cs.tiles[projectId] ?? [];
    return tiles.map((t) => t.type);
  }, 'e2e-project');

  expect(tileTypes).toContain('pipeline-controller');
  expect(tileTypes).toContain('agent');

  // Visual regression baseline. Stored under e2e/test-results/ which is
  // gitignored — committed snapshots would live in `e2e/__screenshots__/`
  // if/when we add `toHaveScreenshot()` later.
  await page.screenshot({
    path: 'e2e/test-results/pipeline-launch.png',
    fullPage: true,
  });
});
