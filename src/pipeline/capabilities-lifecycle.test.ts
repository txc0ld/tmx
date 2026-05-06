import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/utils/ipc', () => ({
  pipelineCapabilitiesInstall: vi.fn(async () => undefined),
  pipelineCapabilitiesUninstall: vi.fn(async () => undefined),
}));

import {
  handleCapabilitiesLifecycle,
  resetCapabilitiesLifecycleForTest,
} from './capabilities-lifecycle';
import { defaultRoleCapabilities } from './role-capabilities';
import {
  pipelineCapabilitiesInstall,
  pipelineCapabilitiesUninstall,
} from '@/utils/ipc';

const installMock = pipelineCapabilitiesInstall as unknown as ReturnType<typeof vi.fn>;
const uninstallMock = pipelineCapabilitiesUninstall as unknown as ReturnType<typeof vi.fn>;

describe('capabilities lifecycle', () => {
  beforeEach(() => {
    resetCapabilitiesLifecycleForTest();
    installMock.mockClear();
    uninstallMock.mockClear();
  });

  it('installs planner caps on transition INTO planning', () => {
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith({
      worktreeDir: '/wt/r1',
      role: 'planner',
      capabilities: defaultRoleCapabilities('planner'),
    });
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it('uninstalls planner + installs builder on planning → building', () => {
    // Get to planning first.
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    installMock.mockClear();

    // Move via awaiting_plan_approval (no role) — should uninstall planner here.
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'planning', to: 'awaiting_plan_approval', trigger: 'planner_done',
    });
    expect(uninstallMock).toHaveBeenCalledWith({ worktreeDir: '/wt/r1', role: 'planner' });
    expect(installMock).not.toHaveBeenCalled();

    // Approve → building → install builder.
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'awaiting_plan_approval', to: 'building', trigger: 'approve_plan',
    });
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith({
      worktreeDir: '/wt/r1',
      role: 'builder',
      capabilities: defaultRoleCapabilities('builder'),
    });
  });

  it('uninstalls builder + installs reviewer on building → reviewing', () => {
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'planning', to: 'awaiting_plan_approval', trigger: 'planner_done',
    });
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'awaiting_plan_approval', to: 'building', trigger: 'approve_plan',
    });
    installMock.mockClear();
    uninstallMock.mockClear();

    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'building', to: 'reviewing', trigger: 'builder_done',
    });

    expect(uninstallMock).toHaveBeenCalledWith({ worktreeDir: '/wt/r1', role: 'builder' });
    expect(installMock).toHaveBeenCalledWith({
      worktreeDir: '/wt/r1',
      role: 'reviewer',
      capabilities: defaultRoleCapabilities('reviewer'),
    });
  });

  it('uninstalls active role on transition into a terminal state', () => {
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    installMock.mockClear();

    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'planning', to: 'failed', trigger: 'abort',
    });
    expect(uninstallMock).toHaveBeenCalledWith({ worktreeDir: '/wt/r1', role: 'planner' });
    expect(installMock).not.toHaveBeenCalled();
  });

  it('re-installs planner on awaiting_plan_approval → planning re-entry (replan)', () => {
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'planning', to: 'awaiting_plan_approval', trigger: 'planner_done',
    });
    installMock.mockClear();
    uninstallMock.mockClear();

    // User rejects plan → re-enter planning. Planner caps were uninstalled
    // when we left, so we should re-install on the way back in.
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'awaiting_plan_approval', to: 'planning', trigger: 'replan_requested',
    });
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith({
      worktreeDir: '/wt/r1',
      role: 'planner',
      capabilities: defaultRoleCapabilities('planner'),
    });
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it('is a no-op when worktreePath is empty', () => {
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    expect(installMock).not.toHaveBeenCalled();
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it('isolates bookkeeping between runs', () => {
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    handleCapabilitiesLifecycle({
      runId: 'r2', projectId: 'p1', worktreePath: '/wt/r2',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    expect(installMock).toHaveBeenCalledTimes(2);
    expect(installMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      worktreeDir: '/wt/r1', role: 'planner',
    }));
    expect(installMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      worktreeDir: '/wt/r2', role: 'planner',
    }));
  });

  it('does not re-install the same role on internal transitions', () => {
    // Going planning → planning should not happen via real states, but a
    // hypothetical no-op transition that arrives here must not fire IPC.
    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'idle', to: 'planning', trigger: 'start',
    });
    installMock.mockClear();

    handleCapabilitiesLifecycle({
      runId: 'r1', projectId: 'p1', worktreePath: '/wt/r1',
      from: 'planning', to: 'planning', trigger: 'start',
    });
    expect(installMock).not.toHaveBeenCalled();
  });
});

describe('defaultRoleCapabilities (spec §17.1 defaults)', () => {
  it('planner: docs-only fileWrites, no network, read-only shell', () => {
    const caps = defaultRoleCapabilities('planner');
    expect(caps.fileWrites.allow).toEqual([
      'docs/superpowers/specs/**',
      'docs/superpowers/plans/**',
    ]);
    expect(caps.fileWrites.deny).toContain('**/*.env');
    expect(caps.network).toBe('none');
    // No build verbs.
    expect(caps.shell.allowPatterns).not.toContain('pnpm *');
    expect(caps.shell.allowPatterns).toContain('rg *');
    expect(caps.shell.allowPatterns).toContain('git status');
    expect(caps.shell.denyPatterns).toContain('git push *');
    expect(caps.mcpTools).toEqual([]);
    expect(caps.maxFileSize).toBe(256_000);
  });

  it('builder: src/tests fileWrites, package-managers network, build-tool shell', () => {
    const caps = defaultRoleCapabilities('builder');
    expect(caps.fileWrites.allow).toContain('src/**');
    expect(caps.fileWrites.allow).toContain('tests/**');
    expect(caps.fileWrites.deny).toContain('docs/**');
    expect(caps.fileWrites.deny).toContain('**/*.env');
    expect(caps.network).toBe('package-managers');
    expect(caps.shell.allowPatterns).toContain('pnpm *');
    expect(caps.shell.allowPatterns).toContain('cargo *');
    expect(caps.shell.denyPatterns).toContain('rm -rf *');
  });

  it('reviewer: read-only via deny: [**], no shell write verbs, no network', () => {
    const caps = defaultRoleCapabilities('reviewer');
    expect(caps.fileWrites.allow).toEqual([]);
    expect(caps.fileWrites.deny).toEqual(['**']);
    expect(caps.network).toBe('none');
    // Build verbs absent.
    expect(caps.shell.allowPatterns).not.toContain('pnpm *');
    expect(caps.shell.allowPatterns).toContain('rg *');
  });

  it('reviewer-codex: same scoping as reviewer', () => {
    const a = defaultRoleCapabilities('reviewer');
    const b = defaultRoleCapabilities('reviewer-codex');
    expect(b).toEqual(a);
  });

  it('controller: throws — controller is not an agent process', () => {
    expect(() => defaultRoleCapabilities('controller')).toThrow(/controller/);
  });
});
