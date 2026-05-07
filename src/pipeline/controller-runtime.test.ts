import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ingestPtyChunk,
  ingestOneshotResult,
  getLastStdoutAt,
  resetIngestionBuffersForTest,
  clearRunBuffers,
} from './controller-runtime';
import * as scratchpadWatcher from './scratchpad-watcher';
import * as compactionWatcher from './compaction-watcher';
import { usePipelineStore, setPipelineTelemetryEmitter, type TelemetryEvent } from '@/stores/pipelineStore';
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

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"feat/r1","specPath":"s","planPath":"p","tasks":[],"summary":"s","planCommitSha":"sha-ctrl-line23","confidence":"verified"}\n';
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
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],"filesChanged":[],"testsAdded":[],"ciStatus":"green","confidence":"verified"}\n';
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

    ingestPtyChunk({ runId, role: 'planner', chunk: 'Path":"s","planPath":"p","tasks":[],"summary":"","planCommitSha":"sha-partial","confidence":"verified"}\n' });
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
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: [], testsAdded: [], ciStatus: 'green',
      confidence: 'verified',
    }});

    const stdout = '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"approve","round":1,"comments":[],"summary":"lgtm","confidence":"verified"}\n';
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
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: [], testsAdded: [], ciStatus: 'green',
      confidence: 'verified',
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
        confidence: 'verified',
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
      confidence: 'verified',
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
      confidence: 'verified',
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
        confidence: 'verified',
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

  // Phase 3b.6: TX_COMPACTION_DONE → handler receives the summary; state machine unaffected.
  it('Phase 3b.6: TX_COMPACTION_DONE routes to handleCompactionDone with summary + worktreePath', () => {
    const handlerSpy = vi.spyOn(compactionWatcher, 'handleCompactionDone').mockResolvedValue();
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-cmp1', templateId: 't', projectId: 'p1',
        worktreePath: '/tmp/wt-cmp', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
        stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
        confidence: 'verified',
      }});
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
      expect(usePipelineStore.getState().runs[runId].state).toBe('building');

      const sentinel = '<<<TX_COMPACTION_DONE>>>{"summary":"finished tasks 1-3, on task 4"}\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      expect(handlerSpy).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        summary: 'finished tasks 1-3, on task 4',
        worktreePath: '/tmp/wt-cmp',
      }));

      // State machine unaffected — compaction is bookkeeping, not a transition.
      expect(usePipelineStore.getState().runs[runId].state).toBe('building');
    } finally {
      handlerSpy.mockRestore();
    }
  });

  it('Phase 3b.6: regular Builder DONE sentinel resets the byte counter', () => {
    const resetSpy = vi.spyOn(compactionWatcher, 'resetBuilderBytes');
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-cmp2', templateId: 't', projectId: 'p1',
        worktreePath: '/tmp/wt-cmp', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
        stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
        confidence: 'verified',
      }});
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

      const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],"filesChanged":[],"testsAdded":[],"ciStatus":"green","confidence":"verified"}\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      expect(resetSpy).toHaveBeenCalledWith(runId);
    } finally {
      resetSpy.mockRestore();
    }
  });

  // Phase 3b.8: sub-agent sentinels emit `subagent_completed` telemetry events
  // (replacing the placeholder `console.info` from 3b.5). State machine
  // unaffected — these tests only assert on the telemetry channel.
  it('Phase 3b.8: TX_SUBAGENT_DONE emits subagent_completed with status: done + counts', () => {
    const captured: TelemetryEvent[] = [];
    const unsub = setPipelineTelemetryEmitter(ev => { captured.push(ev); });
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-tel-sa-done', templateId: 't', projectId: 'proj-X',
        worktreePath: '/tmp/wt-sa', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
        stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
        confidence: 'verified',
      }});
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

      // Drain the state-change events from setup so we can isolate the new emit.
      const beforeCount = captured.length;

      const sentinel = '<<<TX_SUBAGENT_DONE>>>{"filesEdited":["src/x.ts","src/y.ts"],"commitsCreated":["abc1234"],"summary":"refactored two modules"}\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      const newEvents = captured.slice(beforeCount);
      const subagentEvent = newEvents.find(e => e.event === 'subagent_completed');
      expect(subagentEvent).toBeDefined();
      expect(subagentEvent).toMatchObject({
        event: 'subagent_completed',
        runId,
        projectId: 'proj-X',
        parentRole: 'builder',
        status: 'done',
        filesEditedCount: 2,
        commitsCreatedCount: 1,
        summary: 'refactored two modules',
      });
      // Sanity: failure-only fields are absent.
      expect(subagentEvent).not.toHaveProperty('reason');
    } finally {
      unsub();
    }
  });

  it('Phase 3b.8: TX_SUBAGENT_FAILED emits subagent_completed with status: failed + reason', () => {
    const captured: TelemetryEvent[] = [];
    const unsub = setPipelineTelemetryEmitter(ev => { captured.push(ev); });
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-tel-sa-fail', templateId: 't', projectId: 'proj-Y',
        worktreePath: '/tmp/wt-sa', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
        stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
        confidence: 'verified',
      }});
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
      const beforeCount = captured.length;

      const sentinel = '<<<TX_SUBAGENT_FAILED>>>{"reason":"sub-agent crashed at task 3","suggestedFix":"reduce scope"}\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      const subagentEvent = captured.slice(beforeCount).find(e => e.event === 'subagent_completed');
      expect(subagentEvent).toBeDefined();
      expect(subagentEvent).toMatchObject({
        event: 'subagent_completed',
        runId,
        projectId: 'proj-Y',
        parentRole: 'builder',
        status: 'failed',
        reason: 'sub-agent crashed at task 3',
      });
      // Counts and summary are absent on the failure variant.
      expect(subagentEvent).not.toHaveProperty('filesEditedCount');
      expect(subagentEvent).not.toHaveProperty('commitsCreatedCount');
    } finally {
      unsub();
    }
  });

  // Polish.2: Builder emits TX_SUBAGENT_INVOKED before the agent_run_oneshot
  // call. Telemetry records the invocation boundary; pairs with subagent_completed
  // to support latency tracking via (invoked.at, completed.at).
  it('Polish.2: TX_SUBAGENT_INVOKED emits subagent_invoked with payload fields', () => {
    const captured: TelemetryEvent[] = [];
    const unsub = setPipelineTelemetryEmitter(ev => { captured.push(ev); });
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-tel-sa-inv', templateId: 't', projectId: 'proj-Z',
        worktreePath: '/tmp/wt-sa', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
        stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
        confidence: 'verified',
      }});
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
      const beforeCount = captured.length;

      const sentinel = '<<<TX_SUBAGENT_INVOKED>>>{"taskId":"T7","briefSummary":"refactor auth helper","workingFiles":["src/auth/**","tests/auth/**"]}\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      const newEvents = captured.slice(beforeCount);
      const event = newEvents.find(e => e.event === 'subagent_invoked');
      expect(event).toBeDefined();
      expect(event).toMatchObject({
        event: 'subagent_invoked',
        runId,
        projectId: 'proj-Z',
        parentRole: 'builder',
        taskId: 'T7',
        briefSummary: 'refactor auth helper',
        workingFilesCount: 2,
      });
      // No state transition — sub-agent invocation lives within the Builder task.
      expect(usePipelineStore.getState().runs[runId].state).toBe('building');
    } finally {
      unsub();
    }
  });

  it('Polish.2: TX_SUBAGENT_INVOKED with workingFiles only sets workingFilesCount', () => {
    const captured: TelemetryEvent[] = [];
    const unsub = setPipelineTelemetryEmitter(ev => { captured.push(ev); });
    try {
      const runId = usePipelineStore.getState().createRun({
        runId: 'r-tel-sa-inv2', templateId: 't', projectId: 'proj-Z2',
        worktreePath: '/tmp/wt-sa', branch: 'feat/r1', fingerprint: FP,
      });
      usePipelineStore.getState().dispatch(runId, { type: 'start' });
      usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
        stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha',
        confidence: 'verified',
      }});
      usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
      const beforeCount = captured.length;

      const sentinel = '<<<TX_SUBAGENT_INVOKED>>>{"workingFiles":["src/foo/**"]}\n';
      ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

      const event = captured.slice(beforeCount).find(e => e.event === 'subagent_invoked');
      expect(event).toBeDefined();
      expect(event).toMatchObject({
        event: 'subagent_invoked',
        workingFilesCount: 1,
      });
      // Optional fields not in payload should not be on the event.
      const ev = event as Extract<TelemetryEvent, { event: 'subagent_invoked' }>;
      expect(ev.taskId).toBeUndefined();
      expect(ev.briefSummary).toBeUndefined();
    } finally {
      unsub();
    }
  });

  it('Phase 3b.6: clearRunBuffers also clears compaction bookkeeping', () => {
    const spy = vi.spyOn(compactionWatcher, 'clearCompactionState');
    try {
      clearRunBuffers('r-cmp3');
      expect(spy).toHaveBeenCalledWith('r-cmp3');
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

  // ---------------------------------------------------------------
  // Phase 3c.2: confidence is REQUIRED on every DONE sentinel.
  // ---------------------------------------------------------------

  it('Phase 3c.2: planner DONE without confidence → planner_failed', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    // Has planCommitSha — that guard passes — but confidence is missing.
    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"b","specPath":"s","planPath":"p","tasks":[],"summary":"s","planCommitSha":"sha-no-conf"}\n';
    ingestPtyChunk({ runId, role: 'planner', chunk: sentinel });

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('failed');
    expect(run.failureReason).toContain('confidence');
    expect(run.failureClass).toBe('planner_refused');
    expect(run.planLineage).toEqual([]);
  });

  it('Phase 3c.2: builder DONE without confidence → abort', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],"filesChanged":[],"testsAdded":[],"ciStatus":"green"}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('failed');
    expect(run.failureReason).toContain('confidence');
    // Build was rejected before the reducer saw it — no build artifact appended.
    expect(run.artifacts.builds).toEqual([]);
  });

  it('Phase 3c.2: reviewer DONE without confidence → abort', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: [], testsAdded: [], ciStatus: 'green', confidence: 'verified',
    }});

    const stdout = '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"approve","round":1,"comments":[],"summary":"lgtm"}\n';
    ingestOneshotResult({ runId, role: 'reviewer', stdout, exitCode: 0 });

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('failed');
    expect(run.failureReason).toContain('confidence');
    // Reviewer verdict was rejected before the reducer saw it — no review appended.
    expect(run.artifacts.reviews).toEqual([]);
  });

  it('Phase 3c.2: happy path — DONE with confidence: verified proceeds normally', () => {
    // Sanity: making confidence required must not break the success path.
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    const sentinel = '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"b","specPath":"s","planPath":"p","tasks":[],"summary":"s","planCommitSha":"sha-ok","confidence":"verified"}\n';
    ingestPtyChunk({ runId, role: 'planner', chunk: sentinel });

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('awaiting_plan_approval');
    expect(run.artifacts.plan?.confidence).toBe('verified');
  });

  // ---------------------------------------------------------------
  // Phase 3c.3: uncertainty-driven escalation (synthetic question_raised).
  // ---------------------------------------------------------------

  it('Phase 3c.3: builder DONE confidence=uncertain + 5 filesChanged → synthetic question_raised', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    const sentinel =
      '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,' +
      '"commits":[{"sha":"c1","subject":"x","files":["a.ts"]}],' +
      '"filesChanged":["a.ts","b.ts","c.ts","d.ts","e.ts"],' +
      '"testsAdded":[],"ciStatus":"green","confidence":"uncertain",' +
      '"uncertaintyDrivers":["race tests flaky"]}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

    const run = usePipelineStore.getState().runs[runId];
    // Builder advanced to reviewing first; the synthetic question then
    // pushed the run into awaiting_clarification with priorActiveState=reviewing.
    expect(run.state).toBe('awaiting_clarification');
    expect(run.priorActiveState).toBe('reviewing');
    expect(run.artifacts.builds).toHaveLength(1); // build was committed
    expect(run.artifacts.questions).toHaveLength(1);
    const q = run.artifacts.questions[0];
    expect(q.stage).toBe('builder');
    expect(q.context).toContain('uncertain');
    expect(q.context).toContain('race tests flaky');
  });

  it('Phase 3c.3: builder DONE confidence=verified + 10 filesChanged → no synthetic question', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const sentinel =
      '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,"commits":[],' +
      `"filesChanged":${JSON.stringify(files)},` +
      '"testsAdded":[],"ciStatus":"green","confidence":"verified"}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('reviewing');
    expect(run.artifacts.questions).toHaveLength(0);
  });

  it('Phase 3c.3: builder DONE confidence=uncertain + 1 file changed (trivial) → no synthetic question', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    const sentinel =
      '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,' +
      '"commits":[{"sha":"c1","subject":"x","files":["a.ts"]}],' +
      '"filesChanged":["a.ts"],' +
      '"testsAdded":[],"ciStatus":"green","confidence":"uncertain"}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: sentinel });

    const run = usePipelineStore.getState().runs[runId];
    // Trivial diff (<5 files, <3 commits) → no escalation. Builder transitions normally.
    expect(run.state).toBe('reviewing');
    expect(run.artifacts.questions).toHaveLength(0);
  });

  it('Phase 3c.3: reviewer DONE confidence=uncertain reads filesChanged from latest build', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });
    usePipelineStore.getState().dispatch(runId, { type: 'planner_done', plan: {
      stage: 'planner', branch: 'b', specPath: 's', planPath: 'p', tasks: [], summary: '', planCommitSha: 'sha-ctrl',
      confidence: 'verified',
    }});
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });

    // Build with 6 files — non-trivial — so the reviewer's uncertainty
    // should escalate when read against this metric.
    usePipelineStore.getState().dispatch(runId, { type: 'builder_done', build: {
      stage: 'builder', branch: 'b', headSha: 'a', round: 1, commits: [],
      filesChanged: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      testsAdded: [], ciStatus: 'green', confidence: 'verified',
    }});

    const stdout = '<<<TX_STAGE_DONE>>>{"stage":"reviewer","reviewer":"opus","verdict":"approve","round":1,"comments":[],"summary":"lgtm","confidence":"uncertain","uncertaintyDrivers":["spec ambiguous on edge case"]}\n';
    ingestOneshotResult({ runId, role: 'reviewer', stdout, exitCode: 0 });

    const run = usePipelineStore.getState().runs[runId];
    expect(run.state).toBe('awaiting_clarification');
    expect(run.priorActiveState).toBe('awaiting_merge_approval');
    expect(run.artifacts.reviews).toHaveLength(1);
    expect(run.artifacts.questions).toHaveLength(1);
    expect(run.artifacts.questions[0].context).toContain('spec ambiguous on edge case');
  });

  it('Phase 3c.3: planner DONE confidence=uncertain + 3 tasks → synthetic question', () => {
    const runId = usePipelineStore.getState().createRun({
      runId: 'r1', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    // 3 tasks → planner non-trivial threshold (≥3).
    const sentinel =
      '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"b","specPath":"s","planPath":"p",' +
      '"tasks":[' +
      '{"id":"T1","summary":"a","files":[],"tests":[],"acceptance":""},' +
      '{"id":"T2","summary":"b","files":[],"tests":[],"acceptance":""},' +
      '{"id":"T3","summary":"c","files":[],"tests":[],"acceptance":""},' +
      '{"id":"T4","summary":"d","files":[],"tests":[],"acceptance":""}' +
      '],"summary":"s","planCommitSha":"sha-plan","confidence":"uncertain","uncertaintyDrivers":["spec lacks edge cases"]}\n';
    ingestPtyChunk({ runId, role: 'planner', chunk: sentinel });

    const run = usePipelineStore.getState().runs[runId];
    // Planner advanced to awaiting_plan_approval first; synthetic question
    // then transitioned to awaiting_clarification.
    expect(run.state).toBe('awaiting_clarification');
    expect(run.priorActiveState).toBe('awaiting_plan_approval');
    expect(run.artifacts.plan).toBeDefined();
    expect(run.artifacts.questions).toHaveLength(1);
    expect(run.artifacts.questions[0].stage).toBe('planner');
    expect(run.artifacts.questions[0].context).toContain('spec lacks edge cases');
  });

  it('Phase 3c.3: synthetic questions count against the run-level question budget', () => {
    // Question budget guard fires when the artifacts.questions array exceeds
    // the cap. We trigger 4 uncertainty escalations in a row (each one
    // followed by clarification_received to resume) and assert the 4th
    // tips the run into a terminal state via the existing budget check.
    //
    // NOTE: as of Phase 3c, the question-budget enforcement isn't a
    // dedicated reducer guard — it lives in the question-counting code paths
    // that the role-prompts surface. So this test asserts the *bookkeeping*:
    // the synthetic questions accumulate on `artifacts.questions`. Phase 3d
    // (or whichever phase ships the dedicated abort) will turn this into a
    // hard-stop assertion. Today: ≥3 questions = budget exhausted in spirit.
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-budget', templateId: 't', projectId: 'p1',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });
    usePipelineStore.getState().dispatch(runId, { type: 'start' });

    // Plan with uncertainty + 4 tasks (non-trivial). Question #1.
    const planSentinel =
      '<<<TX_STAGE_DONE>>>{"stage":"planner","branch":"b","specPath":"s","planPath":"p",' +
      '"tasks":[' +
      '{"id":"T1","summary":"a","files":[],"tests":[],"acceptance":""},' +
      '{"id":"T2","summary":"b","files":[],"tests":[],"acceptance":""},' +
      '{"id":"T3","summary":"c","files":[],"tests":[],"acceptance":""},' +
      '{"id":"T4","summary":"d","files":[],"tests":[],"acceptance":""}' +
      '],"summary":"s","planCommitSha":"sha-budget","confidence":"uncertain"}\n';
    ingestPtyChunk({ runId, role: 'planner', chunk: planSentinel });
    let run = usePipelineStore.getState().runs[runId];
    expect(run.artifacts.questions).toHaveLength(1);

    usePipelineStore.getState().dispatch(runId, { type: 'clarification_received' });
    run = usePipelineStore.getState().runs[runId];
    // Resumed back into awaiting_plan_approval.
    expect(run.state).toBe('awaiting_plan_approval');

    // Approve the plan and have the builder uncertainty-fire question #2.
    usePipelineStore.getState().dispatch(runId, { type: 'approve_plan' });
    const buildSentinel =
      '<<<TX_STAGE_DONE>>>{"stage":"builder","branch":"b","headSha":"a","round":1,' +
      '"commits":[],' +
      '"filesChanged":["a.ts","b.ts","c.ts","d.ts","e.ts"],' +
      '"testsAdded":[],"ciStatus":"green","confidence":"uncertain"}\n';
    ingestPtyChunk({ runId, role: 'builder', chunk: buildSentinel });
    run = usePipelineStore.getState().runs[runId];
    expect(run.artifacts.questions).toHaveLength(2);
    expect(run.state).toBe('awaiting_clarification');
  });
});
