import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useHealthCheck,
  _resetHealthCheckCacheForTest,
  _setHealthProbeForTest,
} from './useHealthCheck';
import type { HealthReport } from '@/utils/ipc';

const ALL_GOOD: HealthReport = {
  claude: true,
  codex: true,
  gemini: true,
  gitInstalled: true,
};

describe('useHealthCheck', () => {
  beforeEach(() => {
    _resetHealthCheckCacheForTest();
  });
  afterEach(() => {
    _setHealthProbeForTest(null);
    _resetHealthCheckCacheForTest();
  });

  it('returns null on first render then resolves to ok=true when all probes pass', async () => {
    _setHealthProbeForTest(() => Promise.resolve(ALL_GOOD));
    const { result } = renderHook(() => useHealthCheck());

    expect(result.current).toBeNull();

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current).toEqual({ ok: true, missing: [], gitOk: true });
  });

  it('reports missing claude in the missing list and ok=false', async () => {
    _setHealthProbeForTest(() =>
      Promise.resolve({ ...ALL_GOOD, claude: false }),
    );
    const { result } = renderHook(() => useHealthCheck());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual({
      ok: false,
      missing: ['claude'],
      gitOk: true,
    });
  });

  it('reports missing git and ok=false', async () => {
    _setHealthProbeForTest(() =>
      Promise.resolve({ ...ALL_GOOD, gitInstalled: false }),
    );
    const { result } = renderHook(() => useHealthCheck());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual({
      ok: false,
      missing: ['git'],
      gitOk: false,
    });
  });

  it('reports both missing in deterministic order', async () => {
    _setHealthProbeForTest(() =>
      Promise.resolve({ claude: false, codex: false, gemini: false, gitInstalled: false }),
    );
    const { result } = renderHook(() => useHealthCheck());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.missing).toEqual(['claude', 'git']);
    expect(result.current?.ok).toBe(false);
  });

  it('caches the probe — second mount does NOT trigger a second IPC call', async () => {
    const probe = vi.fn(() => Promise.resolve(ALL_GOOD));
    _setHealthProbeForTest(probe);

    const first = renderHook(() => useHealthCheck());
    await waitFor(() => expect(first.result.current).not.toBeNull());
    expect(probe).toHaveBeenCalledTimes(1);

    // Second hook instance — same module-level cache, should NOT re-probe.
    const second = renderHook(() => useHealthCheck());
    await waitFor(() => expect(second.result.current).not.toBeNull());
    expect(probe).toHaveBeenCalledTimes(1);
    expect(second.result.current).toEqual({ ok: true, missing: [], gitOk: true });
  });

  it('IPC failure falls back to "all good" so the banner does not flash a misleading warning', async () => {
    _setHealthProbeForTest(() => Promise.reject(new Error('IPC unavailable')));
    const { result } = renderHook(() => useHealthCheck());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual({ ok: true, missing: [], gitOk: true });
  });
});
