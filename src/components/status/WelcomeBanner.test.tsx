import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { WelcomeBanner, _setOpenLinkForTest } from './WelcomeBanner';
import {
  _resetHealthCheckCacheForTest,
  _setHealthProbeForTest,
} from '@/hooks/useHealthCheck';
import type { HealthReport } from '@/utils/ipc';
import { useProjectStore } from '@/stores/projectStore';
import type { Project } from '@/types';

const ALL_GOOD: HealthReport = {
  claude: true,
  codex: true,
  gemini: true,
  gitInstalled: true,
};

/**
 * happy-dom 20+ ships a stubbed `localStorage` (no methods) unless launched
 * with `--localstorage-file=memory`. WelcomeBanner gates on dismissed-flag
 * persistence so we need a real in-memory impl. Mirrors the pattern used
 * by SettingsModal.test.tsx.
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

function setProjects(projects: Project[]): void {
  // Drive the zustand store directly — `loadFromDisk` would round-trip
  // through the Tauri IPC which jsdom can't satisfy.
  useProjectStore.setState({ projects, active: projects[0]?.id ?? '' });
}

function makeProject(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    icon: '🚀',
    color: '#abcdef',
    description: '',
    cwd: '/tmp/' + id,
    gitUrl: undefined,
    branch: undefined,
  } as unknown as Project;
}

describe('WelcomeBanner', () => {
  let restoreLocalStorage: () => void;

  beforeEach(() => {
    restoreLocalStorage = installMemoryLocalStorage();
    _resetHealthCheckCacheForTest();
    setProjects([]);
  });
  afterEach(() => {
    _setHealthProbeForTest(null);
    _setOpenLinkForTest(null);
    _resetHealthCheckCacheForTest();
    setProjects([]);
    restoreLocalStorage();
  });

  it('shows the no-projects message when zero projects exist', async () => {
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    render(<WelcomeBanner />);

    // The banner renders synchronously on the no-projects branch — health
    // is still null but `noProjects` is enough.
    const banner = screen.getByTestId('welcome-banner');
    expect(banner.textContent).toMatch(/add a project in the sidebar/i);
    // Pipeline shortcut hint is in the copy.
    expect(banner.textContent).toContain('⌘⇧P');
  });

  it('shows the missing-claude warning when health reports it missing', async () => {
    setProjects([makeProject('p1')]);
    _setHealthProbeForTest(() =>
      Promise.resolve({ ...ALL_GOOD, claude: false }),
    );
    render(<WelcomeBanner />);

    // Banner does NOT render until the health probe resolves (because
    // there IS a project — only the health-missing case can trigger it).
    await waitFor(() => {
      expect(screen.queryByTestId('welcome-banner')).not.toBeNull();
    });
    const banner = screen.getByTestId('welcome-banner');
    expect(banner.textContent).toMatch(/Claude Code CLI not on PATH/i);
    // Install-instructions CTA wired to the test stub.
    const opened: string[] = [];
    _setOpenLinkForTest(async (url) => { opened.push(url); });
    fireEvent.click(screen.getByTestId('welcome-banner-cta-claude-missing'));
    await waitFor(() => {
      expect(opened).toEqual(['https://docs.claude.com/en/docs/claude-code/quickstart']);
    });
  });

  it('combines no-projects + missing-claude when both are true', async () => {
    _setHealthProbeForTest(() =>
      Promise.resolve({ ...ALL_GOOD, claude: false }),
    );
    render(<WelcomeBanner />);

    await waitFor(() => {
      // Both lines visible — no-projects (synchronous) plus claude-missing
      // (after the health probe resolves).
      expect(
        screen.getByTestId('welcome-banner').textContent,
      ).toMatch(/Claude Code CLI not on PATH/i);
    });
    const banner = screen.getByTestId('welcome-banner');
    expect(banner.textContent).toMatch(/add a project in the sidebar/i);
    expect(banner.textContent).toMatch(/Claude Code CLI not on PATH/i);
  });

  it('hides itself when projects exist AND health is all good', async () => {
    setProjects([makeProject('p1')]);
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    render(<WelcomeBanner />);

    // Wait for the health probe to land — banner should never render.
    // Use a microtask flush so the promise from setHealthProbe resolves.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('welcome-banner')).toBeNull();
  });

  it('dismiss persists across re-mounts via localStorage', async () => {
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    const { unmount } = render(<WelcomeBanner />);

    expect(screen.getByTestId('welcome-banner')).toBeTruthy();
    fireEvent.click(screen.getByTestId('welcome-banner-dismiss'));
    expect(screen.queryByTestId('welcome-banner')).toBeNull();
    expect(localStorage.getItem('tx-welcome-dismissed')).toBe('1');

    unmount();

    // Fresh mount with the same conditions — should stay hidden because
    // the localStorage flag persists.
    render(<WelcomeBanner />);
    expect(screen.queryByTestId('welcome-banner')).toBeNull();
  });
});
