import { describe, it, expect, beforeEach } from 'vitest';
import { helloWorldTemplate } from './templates';
import { instantiatePipelineTemplate } from './instantiate';
import { computeMinimalFingerprint } from './fingerprint';
import { usePipelineStore } from '@/stores/pipelineStore';

describe('Phase 1 smoke: Hello World pipeline walks to done', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  });

  it('instantiates 4 tiles + 3 wires from the Hello World template', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r-smoke', originX: 0, originY: 0 });
    expect(out.tiles.length).toBe(4);
    expect(out.wires.length).toBe(3);
  });

  it('walks the state machine end-to-end', async () => {
    const tpl = helloWorldTemplate();
    const fp = await computeMinimalFingerprint({
      templateId: tpl.id,
      template: tpl,
      terminalxVersion: '0.1.0',
    });

    const runId = usePipelineStore.getState().createRun({
      runId: 'r-smoke',
      templateId: tpl.id,
      projectId: 'p1',
      worktreePath: '/tmp/wt/r-smoke',
      branch: 'feat/r-smoke',
      fingerprint: fp,
    });

    const dispatch = usePipelineStore.getState().dispatch;
    const stateOf = () => usePipelineStore.getState().runs[runId].state;

    expect(stateOf()).toBe('idle');
    dispatch(runId, { type: 'start' });
    expect(stateOf()).toBe('planning');

    dispatch(runId, {
      type: 'planner_done',
      plan: {
        stage: 'planner', branch: 'feat/r-smoke', specPath: 's', planPath: 'p',
        tasks: [], summary: 's', planCommitSha: 'sha-smoke',
      },
    });
    expect(stateOf()).toBe('awaiting_plan_approval');

    dispatch(runId, { type: 'approve_plan' });
    expect(stateOf()).toBe('building');

    dispatch(runId, {
      type: 'builder_done',
      build: {
        stage: 'builder', branch: 'feat/r-smoke', headSha: 'a', round: 1,
        commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
      },
    });
    expect(stateOf()).toBe('reviewing');

    dispatch(runId, {
      type: 'reviewer_done',
      verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'approve',
        round: 1, comments: [], summary: 'lgtm',
      },
    });
    expect(stateOf()).toBe('awaiting_merge_approval');

    dispatch(runId, { type: 'approve_merge' });
    expect(stateOf()).toBe('merging');

    dispatch(runId, { type: 'merge_done' });
    expect(stateOf()).toBe('done');

    expect(usePipelineStore.getState().activeRunIds).not.toContain(runId);
  });

  it('escalates on the 4th reviewer reject', () => {
    const fp = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-esc', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt/r-esc', branch: 'feat/r-esc', fingerprint: fp,
    });

    const dispatch = usePipelineStore.getState().dispatch;
    const stateOf = () => usePipelineStore.getState().runs[runId].state;

    dispatch(runId, { type: 'start' });
    dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-esc',
    }});
    dispatch(runId, { type: 'approve_plan' });

    for (let round = 1; round <= 4; round++) {
      dispatch(runId, { type: 'builder_done', build: {
        stage: 'builder', branch: 'b', headSha: 'a', round,
        commits: [], filesChanged: [], testsAdded: [], ciStatus: 'green',
      }});
      dispatch(runId, { type: 'reviewer_done', verdict: {
        stage: 'reviewer', reviewer: 'opus', verdict: 'reject',
        round, comments: [], summary: 'no',
      }});
    }

    expect(stateOf()).toBe('escalated');
  });
});
