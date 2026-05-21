import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { Project } from '@/types';

// Mock the IPC layer before importing the store. The factory is hoisted to
// the top of the file, so we can't reference top-level vi.fn instances —
// declare them inline and grab them via vi.mocked() after import.
vi.mock('@/utils/ipc', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/utils/ipc')>();
  return {
    ...real,
    loadProjects: vi.fn().mockResolvedValue([]),
    addProjectToStore: vi.fn().mockResolvedValue(undefined),
    updateProjectInStore: vi.fn().mockResolvedValue(undefined),
    deleteProjectFromStore: vi.fn().mockResolvedValue(undefined),
    gitClone: vi.fn().mockResolvedValue(undefined),
  };
});

import { useProjectStore } from './projectStore';
import * as ipc from '@/utils/ipc';

const loadProjects = vi.mocked(ipc.loadProjects);
const updateProjectInStore = vi.mocked(ipc.updateProjectInStore);

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

describe('projectStore — webhook fields', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], active: '', loading: false, cloning: false });
    updateProjectInStore.mockClear();
    loadProjects.mockReset().mockResolvedValue([]);
  });

  it('updateProject persists webhookUrl into the store', async () => {
    useProjectStore.setState({ projects: [seed()], active: 'p1' });
    await useProjectStore.getState().updateProject('p1', {
      webhookUrl: 'https://hooks.example.com/abc',
    });
    expect(useProjectStore.getState().projects[0].webhookUrl).toBe(
      'https://hooks.example.com/abc',
    );
  });

  it('updateProject persists webhookCadence into the store', async () => {
    useProjectStore.setState({
      projects: [seed({ webhookUrl: 'https://hooks.example.com/abc' })],
      active: 'p1',
    });
    await useProjectStore.getState().updateProject('p1', { webhookCadence: '1hr' });
    expect(useProjectStore.getState().projects[0].webhookCadence).toBe('1hr');
  });

  it('updateProject forwards webhookCadence to the IPC layer as webhook_cadence', async () => {
    useProjectStore.setState({
      projects: [seed({ webhookUrl: 'https://hooks.example.com/abc' })],
      active: 'p1',
    });
    await useProjectStore.getState().updateProject('p1', { webhookCadence: 'daily' });
    expect(updateProjectInStore).toHaveBeenCalledTimes(1);
    const payload = updateProjectInStore.mock.calls[0]![0]!;
    expect(payload.webhook_cadence).toBe('daily');
    expect(payload.webhook_url).toBe('https://hooks.example.com/abc');
  });

  it('updateProject can clear both webhookUrl and webhookCadence', async () => {
    useProjectStore.setState({
      projects: [seed({
        webhookUrl: 'https://hooks.example.com/abc',
        webhookCadence: '15min',
      })],
      active: 'p1',
    });
    await useProjectStore.getState().updateProject('p1', {
      webhookUrl: undefined,
      webhookCadence: undefined,
    });
    expect(useProjectStore.getState().projects[0].webhookUrl).toBeUndefined();
    expect(useProjectStore.getState().projects[0].webhookCadence).toBeUndefined();
  });

  it('loadFromDisk maps webhook_cadence into webhookCadence', async () => {
    loadProjects.mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'Demo',
        icon: 'D',
        color: '#CCFF00',
        description: '',
        cwd: '/Users/foo/code',
        webhook_url: 'https://hooks.example.com/abc',
        webhook_cadence: '4hr',
      },
    ]);
    await useProjectStore.getState().loadFromDisk();
    expect(useProjectStore.getState().projects[0].webhookCadence).toBe('4hr');
    expect(useProjectStore.getState().projects[0].webhookUrl).toBe(
      'https://hooks.example.com/abc',
    );
  });

  it('loadFromDisk drops unknown cadence values as a defensive measure', async () => {
    loadProjects.mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'Demo',
        icon: 'D',
        color: '#CCFF00',
        description: '',
        cwd: '/Users/foo/code',
        webhook_cadence: 'yearly', // not a valid WebhookCadence
      },
    ]);
    await useProjectStore.getState().loadFromDisk();
    expect(useProjectStore.getState().projects[0].webhookCadence).toBeUndefined();
  });

  it('id is never patched even if the caller tries', async () => {
    useProjectStore.setState({ projects: [seed()], active: 'p1' });
    // The store explicitly strips `id` out of the patch even if the caller
    // sneaks one through (e.g. via a Partial<Project> typed but unsafe input).
    await useProjectStore.getState().updateProject('p1', {
      id: 'hacked',
      webhookCadence: '1hr',
    });
    expect(useProjectStore.getState().projects[0].id).toBe('p1');
    expect(useProjectStore.getState().projects[0].webhookCadence).toBe('1hr');
  });
});
