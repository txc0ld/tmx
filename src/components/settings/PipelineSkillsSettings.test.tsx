import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from '@testing-library/react';

import {
  PipelineSkillsSettings,
  statusBadge,
  actionLabel,
} from './PipelineSkillsSettings';
import { useToastStore } from '@/stores/toastStore';
import * as ipc from '@/utils/ipc';

vi.mock('@/utils/ipc', async () => {
  const real = await vi.importActual<typeof import('@/utils/ipc')>('@/utils/ipc');
  return {
    ...real,
    pipelineSkillStatus: vi.fn(),
    pipelineForceInstallSkill: vi.fn(),
  };
});

const mockedStatus = ipc.pipelineSkillStatus as unknown as ReturnType<typeof vi.fn>;
const mockedForce = ipc.pipelineForceInstallSkill as unknown as ReturnType<typeof vi.fn>;

const seedStatuses = [
  { name: 'tx-pipeline-stage-handoff', installed: true, hash_ok: true },
  { name: 'tx-pipeline-reviewer', installed: true, hash_ok: false },
  { name: 'tx-pipeline-extra', installed: false, hash_ok: false },
];

describe('statusBadge / actionLabel pure helpers', () => {
  it('badges the three states correctly', () => {
    expect(statusBadge({ name: 'a', installed: false, hash_ok: false }).kind).toBe('missing');
    expect(statusBadge({ name: 'a', installed: true, hash_ok: true }).kind).toBe('ok');
    expect(statusBadge({ name: 'a', installed: true, hash_ok: false }).kind).toBe('mismatch');
  });

  it('picks the right action label per state', () => {
    expect(actionLabel({ name: 'a', installed: false, hash_ok: false })).toBe('Install');
    expect(actionLabel({ name: 'a', installed: true, hash_ok: true })).toBe('Update from bundle');
    expect(actionLabel({ name: 'a', installed: true, hash_ok: false })).toBe('Restore from bundle');
  });
});

describe('PipelineSkillsSettings', () => {
  beforeEach(() => {
    mockedStatus.mockReset();
    mockedForce.mockReset();
    useToastStore.getState().clearToasts();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the skill list with status badges for each state', async () => {
    mockedStatus.mockResolvedValueOnce(seedStatuses);

    render(<PipelineSkillsSettings />);

    await waitFor(() =>
      expect(
        screen.getByTestId('pipeline-skill-row-tx-pipeline-stage-handoff'),
      ).toBeTruthy(),
    );

    expect(
      screen.getByTestId('pipeline-skill-badge-tx-pipeline-stage-handoff').textContent || '',
    ).toMatch(/installed/);
    expect(
      screen.getByTestId('pipeline-skill-badge-tx-pipeline-reviewer').textContent || '',
    ).toMatch(/hash mismatch/);
    expect(
      screen.getByTestId('pipeline-skill-badge-tx-pipeline-extra').textContent || '',
    ).toMatch(/not installed/);

    // And the action labels match the per-row state.
    expect(
      screen.getByTestId('pipeline-skill-action-tx-pipeline-stage-handoff').textContent,
    ).toBe('Update from bundle');
    expect(
      screen.getByTestId('pipeline-skill-action-tx-pipeline-reviewer').textContent,
    ).toBe('Restore from bundle');
    expect(
      screen.getByTestId('pipeline-skill-action-tx-pipeline-extra').textContent,
    ).toBe('Install');
  });

  it('clicking the action button calls pipelineForceInstallSkill with that skill name', async () => {
    // Initial load + post-update refresh.
    mockedStatus.mockResolvedValue(seedStatuses);
    mockedForce.mockResolvedValueOnce(undefined);

    render(<PipelineSkillsSettings />);

    await waitFor(() =>
      expect(
        screen.getByTestId('pipeline-skill-action-tx-pipeline-stage-handoff'),
      ).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('pipeline-skill-action-tx-pipeline-stage-handoff'),
      );
      await Promise.resolve();
    });

    expect(mockedForce).toHaveBeenCalledTimes(1);
    expect(mockedForce).toHaveBeenCalledWith('tx-pipeline-stage-handoff');
  });

  it('successful update re-fetches status (calls pipelineSkillStatus twice)', async () => {
    mockedStatus.mockResolvedValue(seedStatuses);
    mockedForce.mockResolvedValueOnce(undefined);

    render(<PipelineSkillsSettings />);

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('pipeline-skill-action-tx-pipeline-extra'),
      );
      // wait for the chained refresh
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
  });

  it('failed update surfaces a toast and does not re-fetch', async () => {
    mockedStatus.mockResolvedValue(seedStatuses);
    mockedForce.mockRejectedValueOnce(new Error('boom: bundle missing'));

    render(<PipelineSkillsSettings />);

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(
        screen.getByTestId('pipeline-skill-action-tx-pipeline-reviewer'),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.length).toBeGreaterThan(0);
      expect(toasts.some(t => t.type === 'error' && /boom/.test(t.message))).toBe(true);
    });

    // No follow-up refresh on failure — still 1 call.
    expect(mockedStatus).toHaveBeenCalledTimes(1);
  });

  it('refresh-status button re-fetches', async () => {
    mockedStatus.mockResolvedValue(seedStatuses);
    render(<PipelineSkillsSettings />);

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByTestId('pipeline-skills-refresh'));
      await Promise.resolve();
    });

    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
  });

  it('surfaces a load error when the initial fetch rejects', async () => {
    mockedStatus.mockRejectedValueOnce(new Error('IPC down'));
    render(<PipelineSkillsSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('pipeline-skills-load-error').textContent || '').toMatch(/IPC down/);
    });
  });
});
