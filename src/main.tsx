import React from 'react';
import ReactDOM from 'react-dom/client';
import { useThemeStore } from '@/stores/themeStore';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';

// Apply theme CSS vars before first render
useThemeStore.getState().applyCurrentTheme();

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
