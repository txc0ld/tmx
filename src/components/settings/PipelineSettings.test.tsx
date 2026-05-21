import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { PipelineSettings } from './PipelineSettings';
import {
  useSettingsStore,
  DEFAULT_PIPELINE_PREFS,
} from '@/stores/settingsStore';

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

describe('PipelineSettings', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installMemoryLocalStorage();
    useSettingsStore.setState({ pipelinePrefs: { ...DEFAULT_PIPELINE_PREFS } });
  });

  afterEach(() => {
    cleanup();
    restore();
  });

  it('renders the three preference rows with default values', () => {
    render(<PipelineSettings />);
    const template = screen.getByTestId('pipeline-prefs-template') as HTMLSelectElement;
    expect(template.value).toBe('tx.pipeline.anthropic-trio');

    const pattern = screen.getByTestId('pipeline-prefs-branch-pattern') as HTMLInputElement;
    expect(pattern.value).toBe('pipeline/run-{date}-{shortId}');

    const checkbox = screen.getByTestId('pipeline-prefs-auto-approve') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('changing template select updates the store', () => {
    render(<PipelineSettings />);
    const template = screen.getByTestId('pipeline-prefs-template') as HTMLSelectElement;
    fireEvent.change(template, { target: { value: 'tx.pipeline.hello-world' } });
    expect(useSettingsStore.getState().pipelinePrefs.defaultTemplate).toBe(
      'tx.pipeline.hello-world',
    );
  });

  it('typing in branch pattern input updates the store', () => {
    render(<PipelineSettings />);
    const pattern = screen.getByTestId('pipeline-prefs-branch-pattern') as HTMLInputElement;
    fireEvent.change(pattern, { target: { value: 'feat/{date}-{shortId}' } });
    expect(useSettingsStore.getState().pipelinePrefs.branchPattern).toBe(
      'feat/{date}-{shortId}',
    );
  });

  it('toggling auto-approve checkbox updates the store', () => {
    render(<PipelineSettings />);
    const checkbox = screen.getByTestId('pipeline-prefs-auto-approve') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(useSettingsStore.getState().pipelinePrefs.autoApproveTrivial).toBe(true);
    fireEvent.click(checkbox);
    expect(useSettingsStore.getState().pipelinePrefs.autoApproveTrivial).toBe(false);
  });

  it('shows a valid-pattern preview when the expansion is well-formed', () => {
    render(<PipelineSettings />);
    const preview = screen.getByTestId('pipeline-prefs-branch-preview');
    // Default pattern produces a valid branch — preview starts with "→ ".
    expect(preview.textContent ?? '').toMatch(/^→\s+pipeline\/run-\d{4}-\d{2}-\d{2}-a1b2$/);
  });

  it('shows an inline validation error for patterns that produce invalid branches', () => {
    render(<PipelineSettings />);
    const pattern = screen.getByTestId('pipeline-prefs-branch-pattern') as HTMLInputElement;
    fireEvent.change(pattern, { target: { value: 'foo bar/{date}' } });
    const preview = screen.getByTestId('pipeline-prefs-branch-preview');
    expect(preview.textContent ?? '').toMatch(/Pattern must produce a valid branch name/);
  });

  it('renders the retention-days input with the default value', () => {
    render(<PipelineSettings />);
    const input = screen.getByTestId('pipeline-prefs-retention-days') as HTMLInputElement;
    expect(input.value).toBe('30');
  });

  it('typing in retention-days input updates the store', () => {
    render(<PipelineSettings />);
    const input = screen.getByTestId('pipeline-prefs-retention-days') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7' } });
    expect(useSettingsStore.getState().pipelinePrefs.retentionDays).toBe(7);
  });

  it('treats 0 in retention-days as "disabled"', () => {
    render(<PipelineSettings />);
    const input = screen.getByTestId('pipeline-prefs-retention-days') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    expect(useSettingsStore.getState().pipelinePrefs.retentionDays).toBe(0);
  });
});
