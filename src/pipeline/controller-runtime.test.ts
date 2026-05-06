import { describe, it, expect, beforeEach } from 'vitest';
import { ingestPtyChunk, ingestOneshotResult } from './controller-runtime';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

describe('controller runtime', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('ingestPtyChunk parses TX_STAGE_DONE for planner role and advances state', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r1","specPath":"s","planPath":"p","tasks":[],"summary":"s"}\n';
    ingestPtyChunk({ runId, role: 'planner', chunk: sentinel });

    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');
    expect(usePipelineStore.getState().runs[runId].artifacts.plan).toBeDefined();
  });

  it('ingestPtyChunk for builder advances reviewing', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],"filesChanged":[],"testsAdded":[],"ciStatus":"green"}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

    expect(usePipelineStore.getState().runs[runId].state).toBe('reviewing');
  });

  it('ingestPtyChunk handles partial chunks (sentinel split across two)', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    ingestPtyChunk({ runId, role: 'planner', chunk: '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r1","spec' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('planning');

    ingestPtyChunk({ runId, role: 'planner', chunk: 'Path":"s","planPath":"p","tasks":[],"summary":""}\n' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');
  });

  it('ingestPtyChunk emits TX_STAGE_FAILED → state becomes failed', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    ingestPtyChunk({ runId, role: 'planner', chunk: '<<<TX_STAGE_FAILED>>>{"reason":"could not parse plan"}\n' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('failed');
    expect(usePipelineStore.getState().runs[runId].failureReason).toContain('could not parse plan');
  });

  it('ingestOneshotResult parses reviewer verdict from stdout', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: [], testsAdded: [], ciStatus: 'green',
    }});

    const stdout = '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"approve","round":1,"comments":[],"summary":"lgtm"}\n';
    ingestOneshotResult({ runId, role: 'reviewer', stdout, exitCode: 0 });

    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_merge_approval');
  });

  it('ingestOneshotResult treats nonzero exit + no sentinel as planner_failed', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: [], testsAdded: [], ciStatus: 'green',
    }});

    ingestOneshotResult({ runId, role: 'reviewer', stdout: 'agent crashed', exitCode: 1 });
    expect(usePipelineStore.getState().runs[runId].state).toBe('failed');
  });
});
