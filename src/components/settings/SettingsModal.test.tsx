import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { SettingsModal } from './SettingsModal';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * happy-dom 20+ ships a stubbed `localStorage` (no methods) unless launched with
 * `--localstorage-file=memory`. The settings store calls it inside try/catch so
 * production is fine, but tests need a real impl to assert persistence. Stub a
 * minimal in-memory Storage on `window` for the duration of this suite.
 */
function installMemoryLocalStorage(): () => void {
  const original = window.localStorage;
  const data = new Map<string, string>();
  const stub = {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
  } as Storage;
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true });
  return () => {
    Object.defineProperty(window, 'localStorage', { value: original, configurable: true });
  };
}

describe('SettingsModal', () => {
  let restoreLocalStorage: () => void;

  beforeEach(() => {
    restoreLocalStorage = installMemoryLocalStorage();
    useSettingsStore.setState({ open: true, category: 'project' });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ open: false, category: 'project' });
    restoreLocalStorage();
  });

  it('renders all five category buttons', () => {
    render(<SettingsModal />);
    expect(screen.getByTestId('settings-category-project')).toBeTruthy();
    expect(screen.getByTestId('settings-category-agents')).toBeTruthy();
    expect(screen.getByTestId('settings-category-pipeline')).toBeTruthy();
    expect(screen.getByTestId('settings-category-plugins')).toBeTruthy();
    expect(screen.getByTestId('settings-category-about')).toBeTruthy();
  });

  it('switches body content when a sidebar item is clicked', () => {
    render(<SettingsModal />);
    expect(screen.getByTestId('settings-panel-project')).toBeTruthy();

    fireEvent.click(screen.getByTestId('settings-category-pipeline'));

    expect(screen.getByTestId('settings-panel-pipeline')).toBeTruthy();
    expect(screen.queryByTestId('settings-panel-project')).toBeNull();
  });

  it('persists active category to localStorage and re-mounts at last-viewed', () => {
    const { unmount } = render(<SettingsModal />);
    fireEvent.click(screen.getByTestId('settings-category-plugins'));
    expect(window.localStorage.getItem('tx-settings-active-category')).toBe('plugins');
    unmount();

    // Simulate a fresh in-memory store but keep localStorage — mirrors what
    // the create() initialiser does on real app boot.
    const persisted = window.localStorage.getItem('tx-settings-active-category');
    useSettingsStore.setState({
      open: true,
      category: persisted as 'project' | 'agents' | 'pipeline' | 'plugins' | 'about',
    });

    render(<SettingsModal />);
    expect(screen.getByTestId('settings-panel-plugins')).toBeTruthy();
  });

  it('Escape key triggers close()', () => {
    render(<SettingsModal />);
    expect(useSettingsStore.getState().open).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useSettingsStore.getState().open).toBe(false);
  });

  it('click on overlay outside the inner card does NOT close', () => {
    render(<SettingsModal />);
    expect(useSettingsStore.getState().open).toBe(true);

    const overlay = screen.getByTestId('settings-modal-overlay');
    fireEvent.click(overlay);

    // Stays open — settings sub-panels host in-progress edits, so accidental
    // overlay clicks must not dismiss.
    expect(useSettingsStore.getState().open).toBe(true);
  });
});
