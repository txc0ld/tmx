import React from 'react';
import ReactDOM from 'react-dom/client';
import { useThemeStore } from '@/stores/themeStore';
import { useProjectStore } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';

// Apply theme CSS vars before first render
useThemeStore.getState().applyCurrentTheme();

// E2E test seam — exposed only when the Playwright mock-Tauri bridge has
// already been installed (i.e. NEVER in production or local dev). The
// bridge sets `window.__E2E_MOCK_INSTALLED__` from `addInitScript` before
// the SPA bundle runs, so this branch is gated on real test context.
// Tests use these handles to seed a project + project-active state without
// going through the (mock-IPC-backed) projectStore disk loader.
if (typeof window !== 'undefined' && window.__E2E_MOCK_INSTALLED__) {
  window.__TX_E2E__ = {
    projectStore: useProjectStore,
    canvasStore: useCanvasStore,
    pipelineStore: usePipelineStore,
  };
}

window.addEventListener('error', (event) => {
  console.error('[global:error]', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[global:unhandledrejection]', event.reason);
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root was not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
