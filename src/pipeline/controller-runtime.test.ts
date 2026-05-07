import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ingestPtyChunk,
  ingestOneshotResult,
  getLastStdoutAt,
  resetIngestionBuffersForTest,
  clearRunBuffers,
} from './controller-runtime';
import * as scratchpadWatcher from './scratchpad-watcher';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

describe('controller runtime', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    resetIngestionBuffersForTest();
  });

  it('ingestPtyChunk parses TX_STAGE_DONE for planner role and advances state', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r1","specPath":"s","planPath":"p","tasks":[],"summary":"s","planCommitSha":"sha-ctrl-line23"}\n';
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
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
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

    ingestPtyChunk({ runId, role: 'planner', chunk: 'Path":"s","planPath":"p","tasks":[],"summary":"","planCommitSha":"sha-partial"}\n' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('awaiting_plan_approval');
  });

  it('planner DONE without planCommitSha → planner_failed (guard against unchecked cast)', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    // Sentinel JSON omits planCommitSha entirely — planner forgot to commit
    // before emitting DONE. Without the guard, this silently appends
    // `undefined` to planLineage; with it, we fail the run.
    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r1","specPath":"s","planPath":"p","tasks":[],"summary":"s"}\n';
    ingestPtyChunk({ runId, role: 'planner', chunk: sentinel });

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('failed');
    expect(run.failureReason).toContain('planCommitSha');
    expect(run.planLineage).toEqual([]);
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
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
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
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: [], testsAdded: [], ciStatus: 'green',
    }});

    ingestOneshotResult({ runId, role: 'reviewer', stdout: 'agent crashed', exitCode: 1 });
    expect(usePipelineStore.getState().runs[runId].state).toBe('failed');
  });

  it('TX_HEARTBEAT sentinel updates run.lastHeartbeatAt via dispatch', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    expect(usePipelineStore.getState().runs[runId].lastHeartbeatAt).toBeUndefined();

    const before = Date.now();
    ingestPtyChunk({ runId, role: 'planner', chunk: '<<<TX_HEARTBEAT>>>{"reason":"thinking"}\n' });
    const after = Date.now();

    const run = usePipelineStore.getState().runs[runId];
    expect(run.lastHeartbeatAt).toBeDefined();
    expect(run.lastHeartbeatAt!).toBeGreaterThanOrEqual(before);
    expect(run.lastHeartbeatAt!).toBeLessThanOrEqual(after);
    // Heartbeat must NOT change pipeline state.
    expect(run.state).toBe('planning');
  });

  it('Phase 3b.2: Builder heartbeat invokes scratchpad-watcher with worktreePath', () => {
    const spy = vi.spyOn(scratchpadWatcher, 'notifyBuilderActivity').mockResolvedValue();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-sw1', templateId: 't', projectId: 'p1',
        worktreePath: '/tmp/wt-sw', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
        stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
      }});
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

      ingestPtyChunk({ runId, role: 'builder', chunk: '<<<TX_HEARTBEAT>>>{"reason":"thinking"}\n' });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        role: 'builder',
        worktreePath: '/tmp/wt-sw',
      }));
    } finally {
      spy.mockRestore();
    }
  });

  it('Phase 3b.2: non-builder roles do NOT invoke scratchpad-watcher', () => {
    const spy = vi.spyOn(scratchpadWatcher, 'notifyBuilderActivity').mockResolvedValue();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-sw2', templateId: 't', projectId: 'p1',
        worktreePath: '/tmp/wt-sw', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });

      // Planner heartbeat — must NOT trigger the watcher.
      ingestPtyChunk({ runId, role: 'planner', chunk: '<<<TX_HEARTBEAT>>>{"reason":"thinking"}\n' });

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('Phase 3b.2: clearRunBuffers also clears scratchpad bookkeeping', () => {
    const spy = vi.spyOn(scratchpadWatcher, 'clearScratchpadState');
    try {
      clearRunBuffers('r-sw3');
      expect(spy).toHaveBeenCalledWith('r-sw3');
    } finally {
      spy.mockRestore();
    }
  });

  // Phase 3b.5: sub-agent sentinels are informational — they must NOT
  // transition pipeline state. They live within a Builder task, and the
  // state machine only tracks stage-level transitions.
  it('Phase 3b.5: TX_SUBAGENT_DONE does NOT advance Builder run state', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-sa1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt-sa', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    expect(usePipelineStore.getState().runs[runId].state).toBe('building');

    const sentinel = '<<<TX_SUBAGENT_DONE>>>{"filesEdited":["src/x.ts"],"commitsCreated":["abc1234"],"summary":"did the thing"}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

    // State unchanged — sub-agents don't transition the run.
    expect(usePipelineStore.getState().runs[runId].state).toBe('building');
  });

  it('Phase 3b.5: TX_SUBAGENT_FAILED does NOT advance run state (still building)', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-sa2', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt-sa', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    const sentinel = '<<<TX_SUBAGENT_FAILED>>>{"reason":"sub-agent crashed","suggestedFix":"reduce scope"}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

    // Builder owns the failure decision — sub-agent failure is just a record.
    expect(usePipelineStore.getState().runs[runId].state).toBe('building');
    expect(usePipelineStore.getState().runs[runId].failureReason).toBeUndefined();
  });

  it('Phase 3b.5: TX_SUBAGENT_DONE still triggers Builder scratchpad bookkeeping', () => {
    const spy = vi.spyOn(scratchpadWatcher, 'notifyBuilderActivity').mockResolvedValue();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-sa3', templateId: 't', projectId: 'p1',
        worktreePath: '/tmp/wt-sa', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
        stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
      }});
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

      const sentinel = '<<<TX_SUBAGENT_DONE>>>{"filesEdited":[],"commitsCreated":[],"summary":"x"}\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        role: 'builder',
        worktreePath: '/tmp/wt-sa',
      }));
    } finally {
      spy.mockRestore();
    }
  });

  it('ingestPtyChunk records last-stdout-at; clearRunBuffers (terminal) clears it', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    expect(getLastStdoutAt(runId)).toBeUndefined();

    const before = Date.now();
    ingestPtyChunk({ runId, role: 'planner', chunk: 'random stdout no sentinel\n' });
    const after = Date.now();

    const stamp = getLastStdoutAt(runId);
    expect(stamp).toBeDefined();
    expect(stamp!).toBeGreaterThanOrEqual(before);
    expect(stamp!).toBeLessThanOrEqual(after);

    // One-shot path also bumps the stamp — sanity check it doesn't go back.
    const mid = Date.now();
    ingestOneshotResult({ runId, role: 'reviewer', stdout: 'still alive', exitCode: 0 });
    expect(getLastStdoutAt(runId)!).toBeGreaterThanOrEqual(mid);

    // Reset clears it (mirrors what clearRunBuffers does on terminal).
    resetIngestionBuffersForTest();
    expect(getLastStdoutAt(runId)).toBeUndefined();
  });
});
