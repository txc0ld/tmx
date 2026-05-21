import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for TerminalX E2E tests.
 *
 * The tests run against the Vite dev server (`pnpm dev`) — NOT the full
 * Tauri runtime. There's no PTY spawn, no Rust IPC, no agent process.
 * Instead, `e2e/setup/mockTauri.ts` is injected at page boot and stubs
 * `window.__TAURI_INTERNALS__.invoke` so every `invoke('foo', …)` call
 * resolves with a deterministic in-memory fixture. This keeps E2E light
 * (Chromium only, no native deps) while still exercising the full
 * frontend launch flow — the kind of integration that unit tests miss
 * (e.g. "ingestPtyChunk only called from tests" type regressions where
 * the wiring between two real modules was wrong).
 *
 * Tests live in `e2e/`; Vitest's include glob (`src/**`) does NOT pick
 * them up, so `pnpm test` and `pnpm test:e2e` stay disjoint.
 */
export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['**/setup/**'],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'e2e/test-results',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
