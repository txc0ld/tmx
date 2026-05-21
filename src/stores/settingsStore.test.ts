import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  useSettingsStore,
  DEFAULT_PIPELINE_PREFS,
  expandBranchPattern,
} from './settingsStore';

/** happy-dom 20+ ships a stubbed `localStorage` (no methods). Install a
 *  minimal in-memory Storage on `window` for the suite. Mirrors the helper
 *  in `SettingsModal.test.tsx`. */
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

describe('settingsStore — pipeline prefs', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installMemoryLocalStorage();
    // Reset to defaults so tests don't leak across each other.
    useSettingsStore.setState({ pipelinePrefs: { ...DEFAULT_PIPELINE_PREFS } });
  });

  afterEach(() => {
    restore();
  });

  it('exposes default pipeline prefs', () => {
    const prefs = useSettingsStore.getState().pipelinePrefs;
    expect(prefs.defaultTemplate).toBe('tx.pipeline.anthropic-trio');
    expect(prefs.branchPattern).toBe('pipeline/run-{date}-{shortId}');
    expect(prefs.autoApproveTrivial).toBe(false);
    expect(prefs.retentionDays).toBe(30);
  });

  it('setPipelinePrefs persists retentionDays and survives reload', () => {
    useSettingsStore.getState().setPipelinePrefs({ retentionDays: 7 });
    expect(useSettingsStore.getState().pipelinePrefs.retentionDays).toBe(7);
    const persisted = JSON.parse(window.localStorage.getItem('tx-pipeline-prefs') ?? '{}');
    expect(persisted.retentionDays).toBe(7);
  });

  it('clamps negative retentionDays to the default', () => {
    useSettingsStore.getState().setPipelinePrefs({ retentionDays: -3 });
    expect(useSettingsStore.getState().pipelinePrefs.retentionDays).toBe(30);
  });

  it('clamps very-large retentionDays to MAX_RETENTION_DAYS', () => {
    useSettingsStore.getState().setPipelinePrefs({ retentionDays: 1_000_000 });
    expect(useSettingsStore.getState().pipelinePrefs.retentionDays).toBe(3650);
  });

  it('treats 0 as a valid "disabled" sentinel', () => {
    useSettingsStore.getState().setPipelinePrefs({ retentionDays: 0 });
    expect(useSettingsStore.getState().pipelinePrefs.retentionDays).toBe(0);
  });

  it('floors fractional retentionDays to integer days', () => {
    useSettingsStore.getState().setPipelinePrefs({ retentionDays: 14.7 });
    expect(useSettingsStore.getState().pipelinePrefs.retentionDays).toBe(14);
  });

  it('setPipelinePrefs patches the prefs and persists to localStorage', () => {
    useSettingsStore.getState().setPipelinePrefs({ autoApproveTrivial: true });
    expect(useSettingsStore.getState().pipelinePrefs.autoApproveTrivial).toBe(true);
    // Branch pattern unchanged.
    expect(useSettingsStore.getState().pipelinePrefs.branchPattern).toBe(
      'pipeline/run-{date}-{shortId}',
    );

    const persisted = JSON.parse(window.localStorage.getItem('tx-pipeline-prefs') ?? '{}');
    expect(persisted.autoApproveTrivial).toBe(true);
    expect(persisted.defaultTemplate).toBe('tx.pipeline.anthropic-trio');
  });

  it('setPipelinePrefs accepts a different template and persists it', () => {
    useSettingsStore.getState().setPipelinePrefs({
      defaultTemplate: 'tx.pipeline.hello-world',
    });
    expect(useSettingsStore.getState().pipelinePrefs.defaultTemplate).toBe(
      'tx.pipeline.hello-world',
    );
    const persisted = JSON.parse(window.localStorage.getItem('tx-pipeline-prefs') ?? '{}');
    expect(persisted.defaultTemplate).toBe('tx.pipeline.hello-world');
  });
});

describe('expandBranchPattern', () => {
  it('expands {date} and {shortId} tokens', () => {
    const out = expandBranchPattern('pipeline/run-{date}-{shortId}', {
      now: new Date('2026-05-09T00:00:00Z'),
      shortIdSource: () => 'abcd',
    });
    expect(out.branch).toBe('pipeline/run-2026-05-09-abcd');
    expect(out.valid).toBe(true);
  });

  it('marks invalid when the result contains disallowed characters', () => {
    const out = expandBranchPattern('foo bar/{date}', {
      now: new Date('2026-05-09T00:00:00Z'),
      shortIdSource: () => 'abcd',
    });
    expect(out.valid).toBe(false);
  });

  it('accepts patterns with no tokens', () => {
    const out = expandBranchPattern('feat/static', {
      now: new Date('2026-05-09T00:00:00Z'),
      shortIdSource: () => 'abcd',
    });
    expect(out.branch).toBe('feat/static');
    expect(out.valid).toBe(true);
  });

  it('expands multiple occurrences', () => {
    const out = expandBranchPattern('{date}/{shortId}/{shortId}', {
      now: new Date('2026-05-09T00:00:00Z'),
      shortIdSource: () => 'abcd',
    });
    expect(out.branch).toBe('2026-05-09/abcd/abcd');
    expect(out.valid).toBe(true);
  });
});
