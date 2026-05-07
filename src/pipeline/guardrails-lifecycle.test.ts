import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import {
  setPipelineTelemetryEmitter,
  type TelemetryEvent,
} from '@/stores/pipelineStore';

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

  describe('telemetry (Phase 2c-ii.7)', () => {
    let captured: TelemetryEvent[];

    beforeEach(() => {
      captured = [];
      setPipelineTelemetryEmitter(ev => captured.push(ev));
    });

    afterEach(() => {
      setPipelineTelemetryEmitter(null);
    });

    it('emits guardrails_install with ok:true after a successful IPC', async () => {
      installMock.mockResolvedValueOnce(undefined);

      handleGuardrailsLifecycle({
        runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
        from: 'idle', to: 'planning', trigger: 'start',
      });

      // Promise.then runs as a microtask — flush.
      await Promise.resolve();
      await Promise.resolve();

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        event: 'guardrails_install',
        runId: 'r1',
        projectId: 'p1',
        ok: true,
      });
      expect(typeof captured[0].at).toBe('number');
    });

    it('emits guardrails_uninstall on terminal-state crossing', async () => {
      installMock.mockResolvedValueOnce(undefined);
      uninstallMock.mockResolvedValueOnce(undefined);

      handleGuardrailsLifecycle({
        runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
        from: 'idle', to: 'planning', trigger: 'start',
      });
      handleGuardrailsLifecycle({
        runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
        from: 'merging', to: 'done', trigger: 'merge_done',
      });
      await Promise.resolve();
      await Promise.resolve();

      const uninstallEv = captured.find(e => e.event === 'guardrails_uninstall');
      expect(uninstallEv).toBeTruthy();
      expect(uninstallEv).toMatchObject({
        event: 'guardrails_uninstall',
        runId: 'r1',
        projectId: 'p1',
        ok: true,
      });
    });

    it('on IPC failure, emits ok:false with truncated error', async () => {
      const huge = 'x'.repeat(1200);
      installMock.mockRejectedValueOnce(new Error(huge));

      handleGuardrailsLifecycle({
        runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
        from: 'idle', to: 'planning', trigger: 'start',
      });
      await Promise.resolve();
      await Promise.resolve();

      const ev = captured.find(e => e.event === 'guardrails_install');
      expect(ev).toMatchObject({
        event: 'guardrails_install',
        runId: 'r1',
        projectId: 'p1',
        ok: false,
      });
      // Narrow union for `error` access.
      if (ev && ev.event === 'guardrails_install') {
        expect(ev.error).toBeDefined();
        expect(ev.error!.length).toBeLessThanOrEqual(500);
      }
    });
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
