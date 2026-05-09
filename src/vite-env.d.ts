/// <reference types="vite/client" />

declare module '*.css';

interface Window {
  /**
   * Set by the Playwright mock-Tauri init script (`e2e/setup/mockTauri.init.js`)
   * BEFORE the SPA bundle executes. Production / local dev never sets this,
   * so anything gated on it is dead code in shipping binaries.
   */
  __E2E_MOCK_INSTALLED__?: boolean;
  /**
   * E2E test seam, populated in `main.tsx` only when the mock-Tauri bridge
   * is installed. Tests reach into Zustand stores through this handle to
   * seed a project / active state / pipeline run without round-tripping
   * through the (stubbed) projectStore disk loader.
   */
  __TX_E2E__?: {
    projectStore: typeof import('@/stores/projectStore').useProjectStore;
    canvasStore: typeof import('@/stores/canvasStore').useCanvasStore;
    pipelineStore: typeof import('@/stores/pipelineStore').usePipelineStore;
  };
}
