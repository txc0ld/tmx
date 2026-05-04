import { describe, it, expect, beforeEach } from 'vitest';
import { usePipelineStore } from './pipelineStore';
import type { RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

describe('pipelineStore', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('startRun creates a run in idle then transitions to planning on dispatch start', () => {
    const id = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    expect(usePipelineStore.getState().runs[id].state).toBe('idle');
    usePipelineStore.getState().dispatch(id, { type: 'start' });
    expect(usePipelineStore.getState().runs[id].state).toBe('planning');
  });

  it('dispatch is a no-op for unknown run', () => {
    expect(() =>
      usePipelineStore.getState().dispatch('nope', { type: 'start' }),
    ).not.toThrow();
  });

  it('removeRun deletes a run', () => {
    usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().removeRun('r1');
    expect(usePipelineStore.getState().runs.r1).toBeUndefined();
  });

  it('activeRunIds tracks non-terminal runs', () => {
    const id = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    expect(usePipelineStore.getState().activeRunIds).toContain(id);
    usePipelineStore.getState().dispatch(id, { type: 'abort', reason: 'test' });
    expect(usePipelineStore.getState().activeRunIds).not.toContain(id);
  });
});
