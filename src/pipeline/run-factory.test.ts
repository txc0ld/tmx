import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PipelineRole, RoleCapabilities } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';
import { helloWorldTemplate } from './templates';
import {
  createRunFromTemplate,
  defaultRunFactoryDeps,
  type RunFactoryDeps,
} from './run-factory';

// IPC mock — needed for `defaultRunFactoryDeps` tests at the bottom of
// this file. Module-level so the createRunFromTemplate-based tests
// (which use stub deps and never touch IPC) are unaffected.
vi.mock('@/utils/ipc', () => ({
  readFileText: vi.fn(),
  pipelineReadRolePrompt: vi.fn(),
  pipelinePreflight: vi.fn(),
}));
import {
  readFileText,
  pipelineReadRolePrompt,
  type PreflightResult,
} from '@/utils/ipc';

const stubDeps = (overrides: Partial<RunFactoryDeps> = {}): RunFactoryDeps => ({
  readSkillContent: async () => null,
  readRolePrompt: async () => null,
  readRoleCapabilities: async () => null,
  readInvariants: async () => null,
  ...overrides,
});

beforeEach(() => {
  // Clear store between tests so runs don't leak across cases.
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  vi.mocked(readFileText).mockReset();
});

describe('createRunFromTemplate', () => {
  it('creates the run in the store and computes a full fingerprint', async () => {
    const template = helloWorldTemplate();
    const skillReads: string[] = [];
    const deps = stubDeps({
      readSkillContent: async (name) => {
        skillReads.push(name);
        return `# ${name}\nbody`;
      },
    });

    const { runId, fingerprint } = await createRunFromTemplate({
      runId: 'run-1',
      template,
      projectId: 'proj-a',
      worktreePath: '/tmp/wt',
      branch: 'feat/x',
      terminalxVersion: '0.1.0',
      deps,
    });

    expect(runId).toBe('run-1');
    const stored = usePipelineStore.getState().runs['run-1'];
    expect(stored).toBeDefined();
    expect(stored.fingerprint).toBe(fingerprint);

    // Every unique skill in the template must be in skillHashes.
    const expectedSkills = new Set<string>();
    for (const list of Object.values(template.pipeline.skillBindings)) {
      for (const s of list ?? []) expectedSkills.add(s);
    }
    expect(Object.keys(fingerprint.skillHashes).sort()).toEqual(
      Array.from(expectedSkills).sort(),
    );
    for (const h of Object.values(fingerprint.skillHashes)) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }

    // Phase 2c-i: prompts/capabilities/invariants all null.
    expect(fingerprint.rolePromptHashes).toEqual({});
    expect(fingerprint.capabilityManifests).toEqual({});
    expect(fingerprint.invariantsHash).toBeUndefined();
  });

  it('deduplicates skill names that appear under multiple roles', async () => {
    const template = helloWorldTemplate();
    const callCounts = new Map<string, number>();
    const deps = stubDeps({
      readSkillContent: async (name) => {
        callCounts.set(name, (callCounts.get(name) ?? 0) + 1);
        return `# ${name}`;
      },
    });

    await createRunFromTemplate({
      runId: 'run-dedup',
      template,
      projectId: 'p',
      worktreePath: '/wt',
      branch: 'main',
      terminalxVersion: '0.1.0',
      deps,
    });

    // `tx-pipeline-stage-handoff` is bound to BOTH planner and builder
    // in helloWorldTemplate. Verify it was read exactly once.
    expect(callCounts.get('tx-pipeline-stage-handoff')).toBe(1);
    // Every entry in the call map should be exactly 1.
    for (const [, n] of callCounts) expect(n).toBe(1);

    const fp = usePipelineStore.getState().runs['run-dedup'].fingerprint;
    const uniqueExpected = new Set<string>();
    for (const list of Object.values(template.pipeline.skillBindings)) {
      for (const s of list ?? []) uniqueExpected.add(s);
    }
    expect(Object.keys(fp.skillHashes).length).toBe(uniqueExpected.size);
  });

  it('skips skills whose content is null (file missing) — not in skillHashes', async () => {
    const template = helloWorldTemplate();
    const deps = stubDeps({
      readSkillContent: async (name) =>
        name === 'tx-pipeline-reviewer' ? '# present' : null,
    });

    await createRunFromTemplate({
      runId: 'run-missing',
      template,
      projectId: 'p',
      worktreePath: '/wt',
      branch: 'main',
      terminalxVersion: '0.1.0',
      deps,
    });

    const fp = usePipelineStore.getState().runs['run-missing'].fingerprint;
    expect(Object.keys(fp.skillHashes)).toEqual(['tx-pipeline-reviewer']);
  });

  it('passes role prompts and capabilities through to the fingerprint when deps return them', async () => {
    const template = helloWorldTemplate();
    const caps: RoleCapabilities = {
      fileWrites: { allow: ['src/**'], deny: ['.env'] },
      shell: { allowPatterns: ['^pnpm '], denyPatterns: ['^rm '] },
      network: 'package-managers',
      mcpTools: [],
      maxFileSize: 4096,
    };
    const deps = stubDeps({
      readRolePrompt: async (role: PipelineRole) =>
        role === 'planner' ? '# planner prompt' : null,
      readRoleCapabilities: async (role: PipelineRole) =>
        role === 'builder' ? caps : null,
      readInvariants: async () => '## Invariants\nNo console.log.',
    });

    await createRunFromTemplate({
      runId: 'run-prompts',
      template,
      projectId: 'p',
      worktreePath: '/wt',
      branch: 'main',
      terminalxVersion: '0.1.0',
      deps,
    });

    const fp = usePipelineStore.getState().runs['run-prompts'].fingerprint;
    expect(fp.rolePromptHashes.planner).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.rolePromptHashes.builder).toBeUndefined();
    expect(fp.capabilityManifests.builder).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.capabilityManifests.planner).toBeUndefined();
    expect(fp.invariantsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

function makePreflight(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return {
    is_git_repo: true,
    working_tree_clean: true,
    main_branch: 'main',
    claude_present: true,
    codex_present: true,
    gh_present: true,
    gh_authenticated: true,
    worktree_dir_writable: true,
    signed_skills_ok: true,
    capability_binaries_ok: true,
    skill_cache_writable: true,
    sensitive_paths_found: [],
    errors: [],
    ...overrides,
  };
}

describe('createRunFromTemplate sensitive-paths gate (Phase 3a.3)', () => {
  it('aborts when confirmSensitivePaths returns false — no run created', async () => {
    const template = helloWorldTemplate();
    const confirmSpy = vi.fn(async () => false);
    const deps = stubDeps({
      preflight: async () =>
        makePreflight({ sensitive_paths_found: ['.env', 'id_rsa'] }),
      confirmSensitivePaths: confirmSpy,
    });

    const result = await createRunFromTemplate({
      runId: 'run-aborted',
      template,
      projectId: 'p',
      worktreePath: '/wt',
      branch: 'main',
      terminalxVersion: '0.1.0',
      projectDir: '/proj',
      deps,
    });

    expect(result.aborted).toBe(true);
    expect(result.runId).toBe('');
    expect(confirmSpy).toHaveBeenCalledWith(['.env', 'id_rsa']);
    // Run is NOT in the store.
    expect(usePipelineStore.getState().runs['run-aborted']).toBeUndefined();
  });

  it('proceeds when confirmSensitivePaths returns true — run created', async () => {
    const template = helloWorldTemplate();
    const confirmSpy = vi.fn(async () => true);
    const deps = stubDeps({
      preflight: async () =>
        makePreflight({ sensitive_paths_found: ['.env'] }),
      confirmSensitivePaths: confirmSpy,
    });

    const result = await createRunFromTemplate({
      runId: 'run-acked',
      template,
      projectId: 'p',
      worktreePath: '/wt',
      branch: 'main',
      terminalxVersion: '0.1.0',
      projectDir: '/proj',
      deps,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.runId).toBe('run-acked');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(usePipelineStore.getState().runs['run-acked']).toBeDefined();
  });

  it('skips the gate when sensitive_paths_found is empty (confirm not invoked)', async () => {
    const template = helloWorldTemplate();
    const confirmSpy = vi.fn(async () => false);
    const deps = stubDeps({
      preflight: async () =>
        makePreflight({ sensitive_paths_found: [] }),
      confirmSensitivePaths: confirmSpy,
    });

    const result = await createRunFromTemplate({
      runId: 'run-clean',
      template,
      projectId: 'p',
      worktreePath: '/wt',
      branch: 'main',
      terminalxVersion: '0.1.0',
      projectDir: '/proj',
      deps,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.runId).toBe('run-clean');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(usePipelineStore.getState().runs['run-clean']).toBeDefined();
  });

  it('skips the gate entirely when preflight is omitted (legacy fixture compat)', async () => {
    const template = helloWorldTemplate();
    const confirmSpy = vi.fn(async () => false);
    const deps = stubDeps({
      // preflight omitted → gate is bypassed regardless of confirmSensitivePaths.
      confirmSensitivePaths: confirmSpy,
    });

    const result = await createRunFromTemplate({
      runId: 'run-no-preflight',
      template,
      projectId: 'p',
      worktreePath: '/wt',
      branch: 'main',
      terminalxVersion: '0.1.0',
      // projectDir intentionally omitted too.
      deps,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.runId).toBe('run-no-preflight');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('auto-proceeds when preflight is wired but confirmSensitivePaths is missing', async () => {
    // Matches the defaultRunFactoryDeps shape: preflight is wired, but
    // confirmSensitivePaths is undefined until the UI mounts the modal.
    // The factory must not block run creation in that intermediate state.
    const template = helloWorldTemplate();
    const deps = stubDeps({
      preflight: async () =>
        makePreflight({ sensitive_paths_found: ['.env'] }),
      // confirmSensitivePaths intentionally omitted.
    });

    const result = await createRunFromTemplate({
      runId: 'run-auto',
      template,
      projectId: 'p',
      worktreePath: '/wt',
      branch: 'main',
      terminalxVersion: '0.1.0',
      projectDir: '/proj',
      deps,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.runId).toBe('run-auto');
  });
});

describe('defaultRunFactoryDeps', () => {
  it('readSkillContent returns null when readFileText throws (file not found)', async () => {
    vi.mocked(readFileText).mockRejectedValue(new Error('ENOENT'));
    const deps = defaultRunFactoryDeps({ projectDir: '/proj', homeDir: '/home/u' });
    const out = await deps.readSkillContent('tx-pipeline-stage-handoff');
    expect(out).toBeNull();
    expect(readFileText).toHaveBeenCalledWith(
      '/home/u/.claude/skills/tx-pipeline-stage-handoff/SKILL.md',
    );
  });

  it('readSkillContent normalizes namespaced skills (superpowers:brainstorming → superpowers/brainstorming)', async () => {
    vi.mocked(readFileText).mockResolvedValue('# brainstorming');
    const deps = defaultRunFactoryDeps({ projectDir: '/proj', homeDir: '/home/u' });
    const out = await deps.readSkillContent('superpowers:brainstorming');
    expect(out).toBe('# brainstorming');
    expect(readFileText).toHaveBeenCalledWith(
      '/home/u/.claude/skills/superpowers/brainstorming/SKILL.md',
    );
  });

  it('readSkillContent returns null for empty files (no fingerprint pollution)', async () => {
    vi.mocked(readFileText).mockResolvedValue('');
    const deps = defaultRunFactoryDeps({ projectDir: '/proj', homeDir: '/home/u' });
    expect(await deps.readSkillContent('any')).toBeNull();
  });

  it('readInvariants reads <projectDir>/INVARIANTS.md and returns null on missing file', async () => {
    vi.mocked(readFileText).mockRejectedValueOnce(new Error('ENOENT'));
    const deps = defaultRunFactoryDeps({ projectDir: '/proj', homeDir: '/home/u' });
    expect(await deps.readInvariants()).toBeNull();
    expect(readFileText).toHaveBeenCalledWith('/proj/INVARIANTS.md');
  });

  it('readInvariants returns content when present', async () => {
    vi.mocked(readFileText).mockResolvedValue('## Invariants');
    const deps = defaultRunFactoryDeps({ projectDir: '/proj', homeDir: '/home/u' });
    expect(await deps.readInvariants()).toBe('## Invariants');
  });

  it('readRolePrompt and readRoleCapabilities return null in Phase 2c-i (not yet authored)', async () => {
    // The IPC stub returns null when no body is authored; mirror that here.
    vi.mocked(pipelineReadRolePrompt).mockResolvedValue(null);
    const deps = defaultRunFactoryDeps({ projectDir: '/proj', homeDir: '/home/u' });
    expect(await deps.readRolePrompt('planner')).toBeNull();
    expect(await deps.readRoleCapabilities('builder')).toBeNull();
  });

  it('trims trailing slashes in projectDir/homeDir to avoid double-slash paths', async () => {
    vi.mocked(readFileText).mockResolvedValue('content');
    const deps = defaultRunFactoryDeps({ projectDir: '/proj/', homeDir: '/home/u/' });
    await deps.readSkillContent('foo');
    expect(readFileText).toHaveBeenCalledWith('/home/u/.claude/skills/foo/SKILL.md');
    await deps.readInvariants();
    expect(readFileText).toHaveBeenCalledWith('/proj/INVARIANTS.md');
  });
});
