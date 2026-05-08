import { describe, it, expect, vi } from 'vitest';
import type { PipelineRole, PipelineRun } from '@/types';
import { buildOneshotBrief } from './brief-builder';

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'r-brief-1',
    templateId: 't',
    projectId: 'p1',
    worktreePath: '/tmp/wt/r-brief-1',
    branch: 'feat/r-brief-1',
    baseBranch: 'main',
    state: 'awaiting_red_team',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 0,
    escalationLog: [],
    tiles: {},
    fingerprint: { templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {}, models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0' },
    planLineage: [],
    runMode: 'complex',
    autoApprovePlan: false,
    useDualReviewer: true,
    runRedTeam: true,
    effectiveRetryBudgets: { reviewerReject: 6, ciFail: 6 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3 },
    templateDualReviewer: false,
    ...overrides,
  };
}

describe('buildOneshotBrief', () => {
  it('returns empty when role prompt is missing', async () => {
    const brief = await buildOneshotBrief({
      role: 'red-team' as PipelineRole,
      run: makeRun(),
      projectDir: '/tmp/proj',
      deps: {
        readRolePrompt: vi.fn().mockResolvedValue(null),
        readInvariants: vi.fn().mockResolvedValue(null),
      },
    });
    expect(brief).toBe('');
  });

  it('returns empty when role prompt is whitespace-only', async () => {
    const brief = await buildOneshotBrief({
      role: 'red-team' as PipelineRole,
      run: makeRun(),
      projectDir: '/tmp/proj',
      deps: {
        readRolePrompt: vi.fn().mockResolvedValue('   \n\n  '),
        readInvariants: vi.fn().mockResolvedValue(null),
      },
    });
    expect(brief).toBe('');
  });

  it('appends run-context summary after the role prompt', async () => {
    const brief = await buildOneshotBrief({
      role: 'reviewer' as PipelineRole,
      run: makeRun(),
      projectDir: '/tmp/proj',
      deps: {
        readRolePrompt: vi.fn().mockResolvedValue('# Reviewer prompt\nbe careful'),
        readInvariants: vi.fn().mockResolvedValue(null),
      },
    });
    expect(brief).toContain('# Reviewer prompt');
    expect(brief).toContain('be careful');
    expect(brief).toContain('## Run context');
    expect(brief).toContain('runId: r-brief-1');
    expect(brief).toContain('branch: feat/r-brief-1');
    expect(brief).toContain('baseBranch: main');
    expect(brief).toContain('worktree: /tmp/wt/r-brief-1');
    expect(brief).toContain('complexity: complex');
  });

  it('substitutes INVARIANTS placeholder when project has INVARIANTS.md', async () => {
    const brief = await buildOneshotBrief({
      role: 'red-team' as PipelineRole,
      run: makeRun(),
      projectDir: '/tmp/proj',
      deps: {
        readRolePrompt: vi.fn().mockResolvedValue('# Red Team\n\n## Invariants\n{INVARIANTS_PLACEHOLDER}\n\n## Job\nfind issues'),
        readInvariants: vi.fn().mockResolvedValue('do not delete migrations'),
      },
    });
    expect(brief).toContain('do not delete migrations');
    expect(brief).not.toContain('{INVARIANTS_PLACEHOLDER}');
  });

  it('substitutes the fallback string when invariants is null', async () => {
    const brief = await buildOneshotBrief({
      role: 'reviewer' as PipelineRole,
      run: makeRun(),
      projectDir: '/tmp/proj',
      deps: {
        readRolePrompt: vi.fn().mockResolvedValue('## Invariants\n{INVARIANTS_PLACEHOLDER}\n## Job\nx'),
        readInvariants: vi.fn().mockResolvedValue(null),
      },
    });
    expect(brief).toContain('(none specified — proceed with role defaults)');
    expect(brief).not.toContain('{INVARIANTS_PLACEHOLDER}');
  });

  it('includes build artifact metadata when latest build exists', async () => {
    const run = makeRun({
      artifacts: {
        builds: [{
          stage: 'builder',
          branch: 'feat/x',
          headSha: 'abc1234',
          round: 2,
          commits: [{ sha: 'abc1234', subject: 'feat', files: ['a.ts'] }],
          filesChanged: ['a.ts', 'b.ts', 'c.ts'],
          testsAdded: ['t1'],
          ciStatus: 'green',
          confidence: 'verified',
        }],
        reviews: [],
        ciResults: [],
        questions: [],
        redTeamReports: [],
      },
    });
    const brief = await buildOneshotBrief({
      role: 'red-team' as PipelineRole,
      run,
      projectDir: '/tmp/proj',
      deps: {
        readRolePrompt: vi.fn().mockResolvedValue('# Red Team'),
        readInvariants: vi.fn().mockResolvedValue(null),
      },
    });
    expect(brief).toContain('headSha: abc1234');
    expect(brief).toContain('builderRound: 2');
    expect(brief).toContain('filesChanged: 3');
    expect(brief).toContain('commits: 1');
    expect(brief).toContain('ciStatus: green');
  });

  it('survives projectDir undefined (skips invariants read)', async () => {
    const readInvariants = vi.fn();
    const brief = await buildOneshotBrief({
      role: 'reviewer' as PipelineRole,
      run: makeRun(),
      projectDir: undefined,
      deps: {
        readRolePrompt: vi.fn().mockResolvedValue('# Reviewer'),
        readInvariants,
      },
    });
    expect(brief).toContain('# Reviewer');
    expect(brief).toContain('## Run context');
    // The injected stub still gets called with undefined; the production
    // helper short-circuits on empty projectDir. Tests pass through whatever
    // the deps return.
    expect(readInvariants).toHaveBeenCalledWith(undefined);
  });

  it('swallows readRolePrompt rejection without throwing', async () => {
    const brief = await buildOneshotBrief({
      role: 'reviewer' as PipelineRole,
      run: makeRun(),
      projectDir: '/tmp/proj',
      deps: {
        readRolePrompt: vi.fn().mockRejectedValue(new Error('IPC down')),
        readInvariants: vi.fn().mockResolvedValue(null),
      },
    });
    expect(brief).toBe('');  // missing prompt → empty brief
  });
});
