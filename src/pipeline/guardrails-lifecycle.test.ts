import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/utils/ipc', () => ({
  pipelineGuardrailsInstall: vi.fn(async () => undefined),
  pipelineGuardrailsUninstall: vi.fn(async () => undefined),
}));

import {
  handleGuardrailsLifecycle,
  resetGuardrailsLifecycleForTest,
} from './guardrails-lifecycle';
import {
  pipelineGuardrailsInstall,
  pipelineGuardrailsUninstall,
} from '@/utils/ipc';

const installMock = pipelineGuardrailsInstall as unknown as ReturnType<typeof vi.fn>;
const uninstallMock = pipelineGuardrailsUninstall as unknown as ReturnType<typeof vi.fn>;

describe('guardrails lifecycle', () => {
  beforeEach(() => {
    resetGuardrailsLifecycleForTest();
    installMock.mockClear();
    uninstallMock.mockClear();
  });

  it('installs on first transition out of idle', () => {
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith('/wt/r1');
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it('does not re-install on later transitions in the same run', () => {
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'planning', to: 'awaiting_plan_approval', trigger: 'planner_done',
    });
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'awaiting_plan_approval', to: 'building', trigger: 'approve_plan',
    });
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('uninstalls on first crossing into a terminal state', () => {
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'merging', to: 'done', trigger: 'merge_done',
    });
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(uninstallMock).toHaveBeenCalledWith('/wt/r1');
  });

  it('isolates bookkeeping between runs', () => {
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    handleGuardrailsLifecycle({
      runId: 'r2', projectId: 'p1', worktreePath: '/wt/r2',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    expect(installMock).toHaveBeenCalledTimes(2);
    expect(installMock).toHaveBeenNthCalledWith(1, '/wt/r1');
    expect(installMock).toHaveBeenNthCalledWith(2, '/wt/r2');
  });

  it('is a no-op when worktreePath is empty', () => {
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    expect(installMock).not.toHaveBeenCalled();
  });

  it('install + uninstall both fire on a single idle → terminal transition', () => {
    // e.g. abort during preflight: `idle → failed`. Both effects must fire
    // so the hook is installed (briefly) and then cleaned up.
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'failed', trigger: 'abort',
    });
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(uninstallMock).toHaveBeenCalledTimes(1);
  });

  it('handles re-entry from escalated → planning without re-installing', () => {
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    // Run escalates …
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'reviewing', to: 'escalated', trigger: 'abort',
    });
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    // … then user replans (escalated → planning).
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'escalated', to: 'planning', trigger: 'replan_requested',
    });
    // Re-entry should NOT re-install (idempotent at the IPC layer too,
    // but bookkeeping skips the IPC entirely).
    expect(installMock).toHaveBeenCalledTimes(1);
    // Run finishes — uninstall fires again for the new terminal crossing.
    handleGuardrailsLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'merging', to: 'done', trigger: 'merge_done',
    });
    expect(uninstallMock).toHaveBeenCalledTimes(2);
  });
});
