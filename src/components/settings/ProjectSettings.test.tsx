import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

import { ProjectSettings, validateWebhookUrl } from './ProjectSettings';
import { useProjectStore } from '@/stores/projectStore';
import type { Project } from '@/types';

// Stub the IPC wrappers — projectStore.updateProject calls
// updateProjectInStore -> invoke('update_project'), which would fail under
// happy-dom without a Tauri host. We assert against the resulting in-memory
// store state, so the IPC just needs to resolve.
vi.mock('@/utils/ipc', async (importActual) => {
  const real = await importActual<typeof import('@/utils/ipc')>();
  return {
    ...real,
    loadProjects: vi.fn().mockResolvedValue([]),
    addProjectToStore: vi.fn().mockResolvedValue(undefined),
    updateProjectInStore: vi.fn().mockResolvedValue(undefined),
    deleteProjectFromStore: vi.fn().mockResolvedValue(undefined),
  };
});

function seed(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Demo',
    icon: 'D',
    color: '#CCFF00',
    description: '',
    cwd: '/Users/foo/code',
    ...overrides,
  };
}

function installStore(projects: Project[], active = projects[0]?.id ?? '') {
  useProjectStore.setState({ projects, active });
}

describe('validateWebhookUrl', () => {
  it('accepts https URLs', () => {
    expect(validateWebhookUrl('https://hooks.example.com/abc').ok).toBe(true);
  });

  it('rejects http://', () => {
    const v = validateWebhookUrl('http://hooks.example.com/abc');
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/https/);
  });

  it('rejects non-URL garbage', () => {
    const v = validateWebhookUrl('not a url');
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/valid URL/);
  });

  it('treats empty as ok (clear-the-field)', () => {
    expect(validateWebhookUrl('').ok).toBe(true);
    expect(validateWebhookUrl('   ').ok).toBe(true);
  });
});

describe('ProjectSettings', () => {
  beforeEach(() => {
    // reset store between tests
    useProjectStore.setState({ projects: [], active: '' });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ projects: [], active: '' });
  });

  it('renders empty state when no project is active', () => {
    render(<ProjectSettings />);
    expect(screen.getByTestId('settings-panel-project-empty')).toBeTruthy();
  });

  it('renders the existing webhookUrl in the input', () => {
    installStore([seed({ webhookUrl: 'https://hooks.example.com/abc' })]);
    render(<ProjectSettings />);
    const input = screen.getByTestId('project-webhook-input') as HTMLInputElement;
    expect(input.value).toBe('https://hooks.example.com/abc');
  });

  it('rejects http:// URLs and disables save', () => {
    installStore([seed()]);
    render(<ProjectSettings />);
    const input = screen.getByTestId('project-webhook-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'http://hooks.example.com/abc' } });

    const status = screen.getByTestId('project-webhook-status');
    expect(status.textContent || '').toMatch(/https/);

    const save = screen.getByTestId('project-settings-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('save persists via updateProject', async () => {
    installStore([seed()]);
    render(<ProjectSettings />);
    const input = screen.getByTestId('project-webhook-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://hooks.example.com/zzz' } });

    const save = screen.getByTestId('project-settings-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(save);
      // let the awaited updateProjectInStore microtask flush
      await Promise.resolve();
    });

    const stored = useProjectStore.getState().projects[0];
    expect(stored.webhookUrl).toBe('https://hooks.example.com/zzz');
  });

  it('cancel resets the draft to the persisted value', () => {
    installStore([seed({ webhookUrl: 'https://hooks.example.com/orig' })]);
    render(<ProjectSettings />);
    const input = screen.getByTestId('project-webhook-input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'https://other.example.com/' } });
    expect(input.value).toBe('https://other.example.com/');

    fireEvent.click(screen.getByTestId('project-settings-cancel'));
    expect(input.value).toBe('https://hooks.example.com/orig');
  });

  it('clearing the input + save removes the webhookUrl', async () => {
    installStore([seed({ webhookUrl: 'https://hooks.example.com/abc' })]);
    render(<ProjectSettings />);
    const input = screen.getByTestId('project-webhook-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });

    const save = screen.getByTestId('project-settings-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(save);
      await Promise.resolve();
    });

    expect(useProjectStore.getState().projects[0].webhookUrl).toBeUndefined();
  });
});
