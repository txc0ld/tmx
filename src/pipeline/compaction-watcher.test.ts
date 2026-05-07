import { describe, it, expect, beforeEach } from 'vitest';
import {
  notifyBuilderBytes,
  resetBuilderBytes,
  handleCompactionDone,
  clearCompactionState,
  resetCompactionStateForTest,
  _getBytesForTest,
  _isPendingForTest,
  COMPACTION_THRESHOLD_BYTES,
  COMPACTION_PROMPT,
  COMPACTION_SECTION_HEADER,
} from './compaction-watcher';
import { SCRATCHPAD_FILE } from './scratchpad-watcher';
import {
  setPipelineTelemetryEmitter,
  usePipelineStore,
  type TelemetryEvent,
} from '@/stores/pipelineStore';
import type { RunFingerprint } from '@/types';

/**
 * Phase 3b.6: compaction-watcher unit tests. DI mirrors scratchpad-watcher
 * so we drive the watcher with synthetic `now` + recording mocks for
 * `writeToPty` / `readScratchpad` / `writeScratchpad` and never touch the
 * real filesystem or IPC.
 */

interface PtyWrite {
  ptyId: string;
  data: string;
}

interface FsWrite {
  path: string;
  contents: string;
}

function makeRecorder() {
  const ptyWrites: PtyWrite[] = [];
  const fsWrites: FsWrite[] = [];
  let scratchpadContent: string | null = null;

  return {
    ptyWrites,
    fsWrites,
    setScratchpad: (s: string | null) => { scratchpadContent = s; },
    deps: {
      writeToPty: async (ptyId: string, data: string) => { ptyWrites.push({ ptyId, data }); },
      readScratchpad: async (_path: string) => scratchpadContent,
      writeScratchpad: async (path: string, contents: string) => {
        fsWrites.push({ path, contents });
        scratchpadContent = contents;
      },
      refreshMtime: async (_path: string) => { /* no-op for tests */ },
      now: () => 1_700_000_000_000, // fixed clock — deterministic timestamps
    },
  };
}

describe('compaction-watcher', () => {
  beforeEach(() => {
    resetCompactionStateForTest();
  });

  it('bytes accumulate; threshold trip writes compaction prompt to PTY', async () => {
    const rec = makeRecorder();
    const runId = 'r1';
    const ptyId = 'pty-builder-1';
    const worktreePath = '/tmp/wt';

    // Below threshold — no prompt.
    await notifyBuilderBytes({ runId, ptyId, worktreePath, byteCount: 50_000, deps: rec.deps });
    expect(rec.ptyWrites).toHaveLength(0);
    expect(_getBytesForTest(runId)).toBe(50_000);
    expect(_isPendingForTest(runId)).toBe(false);

    await notifyBuilderBytes({ runId, ptyId, worktreePath, byteCount: 100_000, deps: rec.deps });
    expect(rec.ptyWrites).toHaveLength(0);
    expect(_getBytesForTest(runId)).toBe(150_000);

    // Cross threshold (200KB) — prompt fires exactly once.
    await notifyBuilderBytes({ runId, ptyId, worktreePath, byteCount: 60_000, deps: rec.deps });
    expect(rec.ptyWrites).toHaveLength(1);
    expect(rec.ptyWrites[0].ptyId).toBe(ptyId);
    expect(rec.ptyWrites[0].data).toBe(COMPACTION_PROMPT);
    expect(rec.ptyWrites[0].data).toContain('<<<TX_COMPACTION_DONE>>>');
    expect(rec.ptyWrites[0].data).toContain('500 tokens');
    expect(_isPendingForTest(runId)).toBe(true);
    expect(_getBytesForTest(runId)).toBeGreaterThanOrEqual(COMPACTION_THRESHOLD_BYTES);
  });

  it('pending flag prevents re-fire while Builder is composing the summary', async () => {
    const rec = makeRecorder();
    const runId = 'r2';
    const ptyId = 'pty-builder-2';
    const worktreePath = '/tmp/wt';

    // Trip.
    await notifyBuilderBytes({
      runId, ptyId, worktreePath,
      byteCount: COMPACTION_THRESHOLD_BYTES + 1,
      deps: rec.deps,
    });
    expect(rec.ptyWrites).toHaveLength(1);

    // More bytes arrive before TX_COMPACTION_DONE — must NOT fire again.
    await notifyBuilderBytes({ runId, ptyId, worktreePath, byteCount: 500_000, deps: rec.deps });
    await notifyBuilderBytes({ runId, ptyId, worktreePath, byteCount: 100_000, deps: rec.deps });
    expect(rec.ptyWrites).toHaveLength(1);
    expect(_isPendingForTest(runId)).toBe(true);
  });

  it('handleCompactionDone appends summary to scratchpad and resets state', async () => {
    const rec = makeRecorder();
    const runId = 'r3';
    const ptyId = 'pty-builder-3';
    const worktreePath = '/tmp/wt';
    rec.setScratchpad('# Builder scratchpad\n\nTask 1: doing X\n');

    // Trip.
    await notifyBuilderBytes({
      runId, ptyId, worktreePath,
      byteCount: COMPACTION_THRESHOLD_BYTES + 1,
      deps: rec.deps,
    });
    expect(_isPendingForTest(runId)).toBe(true);

    // Builder responds.
    await handleCompactionDone({
      runId, summary: 'Made it through tasks 1-3; on task 4 next.',
      worktreePath, deps: rec.deps,
    });

    expect(rec.fsWrites).toHaveLength(1);
    expect(rec.fsWrites[0].path).toBe(`/tmp/wt/${SCRATCHPAD_FILE}`);
    expect(rec.fsWrites[0].contents).toContain(COMPACTION_SECTION_HEADER);
    expect(rec.fsWrites[0].contents).toContain('Made it through tasks 1-3');
    // Original content preserved.
    expect(rec.fsWrites[0].contents).toContain('Task 1: doing X');

    // State reset — pending cleared, counter zeroed.
    expect(_isPendingForTest(runId)).toBe(false);
    expect(_getBytesForTest(runId)).toBe(0);

    // Subsequent threshold can re-trigger.
    await notifyBuilderBytes({
      runId, ptyId, worktreePath,
      byteCount: COMPACTION_THRESHOLD_BYTES + 1,
      deps: rec.deps,
    });
    expect(rec.ptyWrites).toHaveLength(2); // first trip + re-trip
  });

  it('handleCompactionDone seeds the file when scratchpad is missing', async () => {
    const rec = makeRecorder();
    const runId = 'r-fresh';
    rec.setScratchpad(null); // file missing

    await handleCompactionDone({
      runId, summary: 'first checkpoint',
      worktreePath: '/tmp/wt', deps: rec.deps,
    });

    expect(rec.fsWrites).toHaveLength(1);
    const written = rec.fsWrites[0].contents;
    expect(written).toContain('# Builder scratchpad');
    expect(written).toContain(COMPACTION_SECTION_HEADER);
    expect(written).toContain('first checkpoint');
  });

  it('handleCompactionDone appends a fresh section when none exists yet', async () => {
    const rec = makeRecorder();
    const runId = 'r-no-section';
    rec.setScratchpad('# Builder scratchpad\n\n## Tasks\n\n- one\n- two\n');

    await handleCompactionDone({
      runId, summary: 'mid-flight summary',
      worktreePath: '/tmp/wt', deps: rec.deps,
    });

    const written = rec.fsWrites[0].contents;
    expect(written).toContain('## Tasks'); // existing section preserved
    expect(written).toContain(COMPACTION_SECTION_HEADER);
    expect(written).toContain('mid-flight summary');
    // Section header appears AFTER the existing tasks section.
    expect(written.indexOf('## Tasks')).toBeLessThan(written.indexOf(COMPACTION_SECTION_HEADER));
  });

  it('resetBuilderBytes (regular sentinel) clears counter without firing prompt', async () => {
    const rec = makeRecorder();
    const runId = 'r4';
    const ptyId = 'pty-builder-4';
    const worktreePath = '/tmp/wt';

    await notifyBuilderBytes({ runId, ptyId, worktreePath, byteCount: 150_000, deps: rec.deps });
    expect(_getBytesForTest(runId)).toBe(150_000);

    // Regular sentinel landed — counter resets, no prompt.
    resetBuilderBytes(runId);
    expect(_getBytesForTest(runId)).toBe(0);
    expect(rec.ptyWrites).toHaveLength(0);
    expect(_isPendingForTest(runId)).toBe(false);

    // Now we can accumulate fresh bytes from zero before tripping again.
    await notifyBuilderBytes({ runId, ptyId, worktreePath, byteCount: 100_000, deps: rec.deps });
    expect(rec.ptyWrites).toHaveLength(0); // 100KB is well below threshold

    await notifyBuilderBytes({
      runId, ptyId, worktreePath,
      byteCount: COMPACTION_THRESHOLD_BYTES,
      deps: rec.deps,
    });
    expect(rec.ptyWrites).toHaveLength(1);
  });

  it('clearCompactionState wipes pending and counter on terminal state', async () => {
    const rec = makeRecorder();
    const runId = 'r5';
    const ptyId = 'pty-builder-5';
    const worktreePath = '/tmp/wt';

    await notifyBuilderBytes({
      runId, ptyId, worktreePath,
      byteCount: COMPACTION_THRESHOLD_BYTES + 1,
      deps: rec.deps,
    });
    expect(_isPendingForTest(runId)).toBe(true);
    expect(_getBytesForTest(runId)).toBeGreaterThan(0);

    clearCompactionState(runId);
    expect(_isPendingForTest(runId)).toBe(false);
    expect(_getBytesForTest(runId)).toBe(0);
  });

  it('per-run isolation — tripping run A does not affect run B', async () => {
    const rec = makeRecorder();

    await notifyBuilderBytes({
      runId: 'rA', ptyId: 'ptyA', worktreePath: '/tmp/A',
      byteCount: COMPACTION_THRESHOLD_BYTES + 1,
      deps: rec.deps,
    });
    expect(_isPendingForTest('rA')).toBe(true);
    expect(_isPendingForTest('rB')).toBe(false);
    expect(_getBytesForTest('rB')).toBe(0);

    // Bytes for B accumulate independently.
    await notifyBuilderBytes({
      runId: 'rB', ptyId: 'ptyB', worktreePath: '/tmp/B',
      byteCount: 50_000,
      deps: rec.deps,
    });
    expect(_getBytesForTest('rB')).toBe(50_000);
    expect(rec.ptyWrites).toHaveLength(1); // still just rA's prompt
    expect(rec.ptyWrites[0].ptyId).toBe('ptyA');
  });

  // Phase 3b.8: telemetry events for compaction lifecycle. Both events read
  // `projectId` from the store; we seed a run record so the lookup succeeds.
  it('Phase 3b.8: tripping threshold emits compaction_triggered with bytesAccumulated + projectId', async () => {
    const FP: RunFingerprint = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-tel-trig', templateId: 't', projectId: 'proj-comp',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });

    const captured: TelemetryEvent[] = [];
    const unsub = setPipelineTelemetryEmitter(ev => { captured.push(ev); });
    try {
      const rec = makeRecorder();

      // Sub-threshold — no event.
      await notifyBuilderBytes({
        runId, ptyId: 'pty', worktreePath: '/tmp/wt',
        byteCount: 50_000, deps: rec.deps,
      });
      expect(captured.find(e => e.event === 'compaction_triggered')).toBeUndefined();

      // Cross threshold — exactly one compaction_triggered event.
      await notifyBuilderBytes({
        runId, ptyId: 'pty', worktreePath: '/tmp/wt',
        byteCount: COMPACTION_THRESHOLD_BYTES,
        deps: rec.deps,
      });

      const trig = captured.find(e => e.event === 'compaction_triggered');
      expect(trig).toBeDefined();
      expect(trig).toMatchObject({
        event: 'compaction_triggered',
        runId,
        projectId: 'proj-comp',
      });
      // bytesAccumulated must reflect the cumulative count that tripped the
      // threshold (>= COMPACTION_THRESHOLD_BYTES).
      const bytes = (trig as { bytesAccumulated: number }).bytesAccumulated;
      expect(bytes).toBeGreaterThanOrEqual(COMPACTION_THRESHOLD_BYTES);
      expect(bytes).toBe(50_000 + COMPACTION_THRESHOLD_BYTES);
    } finally {
      unsub();
    }
  });

  it('Phase 3b.8: handleCompactionDone emits compaction_completed with summaryLength', async () => {
    const FP: RunFingerprint = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-tel-done', templateId: 't', projectId: 'proj-comp-done',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });

    const captured: TelemetryEvent[] = [];
    const unsub = setPipelineTelemetryEmitter(ev => { captured.push(ev); });
    try {
      const rec = makeRecorder();
      rec.setScratchpad(null);

      const summary = 'Made it through tasks 1-3; on task 4 next.';
      await handleCompactionDone({
        runId, summary,
        worktreePath: '/tmp/wt', deps: rec.deps,
      });

      const done = captured.find(e => e.event === 'compaction_completed');
      expect(done).toBeDefined();
      expect(done).toMatchObject({
        event: 'compaction_completed',
        runId,
        projectId: 'proj-comp-done',
        summaryLength: summary.length,
      });
    } finally {
      unsub();
    }
  });

  it('Phase 3b.8: failed PTY write does NOT emit compaction_triggered', async () => {
    // If the prompt never reaches the Builder, telemetry must not record a
    // delivery. Pending flag flips back to false so the next chunk re-tries
    // and emits on success.
    const FP: RunFingerprint = {
      templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
      models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
    };
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    const runId = usePipelineStore.getState().createRun({
      runId: 'r-tel-fail', templateId: 't', projectId: 'proj-fail',
      worktreePath: '/tmp/wt', branch: 'feat/r1', fingerprint: FP,
    });

    const captured: TelemetryEvent[] = [];
    const unsub = setPipelineTelemetryEmitter(ev => { captured.push(ev); });
    try {
      const deps = {
        writeToPty: async (_id: string, _data: string) => { throw new Error('pty closed'); },
        readScratchpad: async (_p: string) => null,
        writeScratchpad: async (_path: string, _contents: string) => {},
        refreshMtime: async (_p: string) => {},
        now: () => 1,
      };

      await notifyBuilderBytes({
        runId, ptyId: 'pty', worktreePath: '/tmp/wt',
        byteCount: COMPACTION_THRESHOLD_BYTES + 1,
        deps,
      });

      expect(captured.find(e => e.event === 'compaction_triggered')).toBeUndefined();
      expect(_isPendingForTest(runId)).toBe(false);
    } finally {
      unsub();
    }
  });

  it('writeToPty failure clears pending so the next chunk can retry', async () => {
    const ptyWrites: PtyWrite[] = [];
    const fsWrites: FsWrite[] = [];
    let attempts = 0;
    const deps = {
      writeToPty: async (ptyId: string, data: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error('pty closed');
        ptyWrites.push({ ptyId, data });
      },
      readScratchpad: async (_p: string) => null,
      writeScratchpad: async (path: string, contents: string) => { fsWrites.push({ path, contents }); },
      refreshMtime: async (_p: string) => {},
      now: () => 1,
    };

    // First trip — IPC throws, pending cleared.
    await notifyBuilderBytes({
      runId: 'r-retry', ptyId: 'pty', worktreePath: '/tmp/wt',
      byteCount: COMPACTION_THRESHOLD_BYTES + 1,
      deps,
    });
    expect(_isPendingForTest('r-retry')).toBe(false);
    expect(ptyWrites).toHaveLength(0);

    // Next chunk — re-tries (counter is still over threshold).
    await notifyBuilderBytes({
      runId: 'r-retry', ptyId: 'pty', worktreePath: '/tmp/wt',
      byteCount: 1,
      deps,
    });
    expect(ptyWrites).toHaveLength(1);
    expect(_isPendingForTest('r-retry')).toBe(true);
  });
});
