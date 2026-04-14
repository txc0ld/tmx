import React from 'react';
import ReactDOM from 'react-dom/client';
import { useThemeStore } from '@/stores/themeStore';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';

// Apply theme CSS vars before first render
useThemeStore.getState().applyCurrentTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
