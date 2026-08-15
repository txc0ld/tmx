import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Vitest's default include glob would otherwise pick up
    // `e2e/pipeline-launch.spec.ts` — that file uses `@playwright/test`
    // and only runs through `pnpm test:e2e`. Keep the two suites
    // disjoint so `pnpm test` stays at unit-test speed.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'e2e/**',
      '.claude/**',
      '.terminalx/**',
      '.tx-worktrees/**',
    ],
  },
});
