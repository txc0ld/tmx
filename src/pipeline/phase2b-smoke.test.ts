import { describe, it, expect, beforeEach } from 'vitest';
import { helloWorldTemplate } from './templates';
import { computeMinimalFingerprint } from './fingerprint';
import { ingestPtyChunk, ingestOneshotResult, _resetForTest } from './controller-runtime';
import { usePipelineStore } from '@/stores/pipelineStore';

describe('Phase 2b: live-execution path end-to-end (mocked agents)', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    _resetForTest();
  });

  it('full happy path: planner → builder → reviewer → awaiting_merge_approval', async () => {
    const tpl = helloWorldTemplate();
    const fp = await computeMinimalFingerprint({
      templateId: tpl.id, template: tpl, terminalxVersion: '0.1.0',
    });

    const runId = usePipelineStore.getState().createRun({
      runId: 'r-2b-smoke', templateId: tpl.id, projectId: '/tmp/p',
      worktreePath: '/tmp/wt', branch: 'feat/r-2b-smoke', fingerprint: fp,
    });

    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('planning');

    // Mocked Planner emits a sentinel via PTY
    ingestPtyChunk({
      runId, role: 'planner',
      chunk: 'Designing the plan...\n<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r-2b-smoke","specPath":"docs/spec.md","planPath":"docs/plan.md","tasks":[{"id":"T1","summary":"add foo","files":["src/foo.ts"],"tests":["foo handles bar"],"acceptance":"foo returns expected"}],"summary":"Add a foo function","commitSha":"sha-2b-smoke"}\n',
    });
    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');

    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('building');

    // Mocked Builder
    ingestPtyChunk({
      runId, role: 'builder',
      chunk: 'Wrote test\nImplemented foo\n<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"feat/r-2b-smoke","headSha":"abc123","round":1,"commits":[{"sha":"abc123","subject":"feat(foo): add","files":["src/foo.ts"]}],"filesChanged":["src/foo.ts","tests/foo.test.ts"],"testsAdded":["foo handles bar"],"ciStatus":"green"}\n',
    });
    expect(usePipelineStore.getState().runs[runId].state).toBe('reviewing');

    // Mocked Reviewer (one-shot path)
    ingestOneshotResult({
      runId, role: 'reviewer',
      stdout: '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"approve","round":1,"comments":[],"summary":"lgtm","confidence":"verified"}\n',
      exitCode: 0,
    });
    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_merge_approval');
  });

  it('reviewer reject loops back to building with retry counter incremented', async () => {
    const tpl = helloWorldTemplate();
    const fp = await computeMinimalFingerprint({
      templateId: tpl.id, template: tpl, terminalxVersion: '0.1.0',
    });
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-reject', templateId: tpl.id, projectId: '/tmp/p',
      worktreePath: '/tmp/wt', branch: 'feat/r-reject', fingerprint: fp,
    });

    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    ingestPtyChunk({
      runId, role: 'planner',
      chunk: '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"b","specPath":"s","planPath":"p","tasks":[],"summary":"","commitSha":"sha-reject"}\n',
    });
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    ingestPtyChunk({
      runId, role: 'builder',
      chunk: '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],"filesChanged":[],"testsAdded":[],"ciStatus":"green"}\n',
    });

    ingestOneshotResult({
      runId, role: 'reviewer',
      stdout: '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"reject","round":1,"comments":[{"severity":"blocker","file":"src/foo.ts","line":1,"issue":"missing null check"}],"summary":"blocking on null","confidence":"verified"}\n',
      exitCode: 0,
    });

    expect(usePipelineStore.getState().runs[runId].state).toBe('building');
    expect(usePipelineStore.getState().runs[runId].retryCounters.reviewerReject).toBe(1);
  });

  it('planner emits TX_STAGE_FAILED → run transitions to failed', () => {
    const fp = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-fail', templateId: 't', projectId: '/tmp/p',
      worktreePath: '/tmp/wt', branch: 'feat/r-fail', fingerprint: fp,
    });

    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    ingestPtyChunk({
      runId, role: 'planner',
      chunk: '<<<TX_STAGE_FAILED>>>{"reason":"plan unclear","suggestedFix":"clarify requirements"}\n',
    });

    expect(usePipelineStore.getState().runs[runId].state).toBe('failed');
    expect(usePipelineStore.getState().runs[runId].failureClass).toBe('planner_refused');
  });

  it('partial-chunk PTY output reassembles correctly', () => {
    const fp = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-partial', templateId: 't', projectId: '/tmp/p',
      worktreePath: '/tmp/wt', branch: 'feat/r-partial', fingerprint: fp,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    // Simulate a sentinel split across 4 chunks
    ingestPtyChunk({ runId, role: 'planner', chunk: '<<<TX_STAGE' });
    ingestPtyChunk({ runId, role: 'planner', chunk: '_DONE>>>{"stage":"plann' });
    ingestPtyChunk({ runId, role: 'planner', chunk: 'er","branch":"b","spec' });
    ingestPtyChunk({ runId, role: 'planner', chunk: 'Path":"s","planPath":"p","tasks":[],"summary":""}\n' });

    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');
  });
});
