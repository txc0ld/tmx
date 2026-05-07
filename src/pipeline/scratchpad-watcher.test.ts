import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  notifyBuilderActivity,
  clearScratchpadState,
  resumeFromClarification,
  resetScratchpadStateForTest,
  STAGNATION_THRESHOLD_MS,
  SCRATCHPAD_FILE,
} from './scratchpad-watcher';
import type { QuestionArtifact, PipelineRole } from '@/types';

/**
 * Phase 3b.2: scratchpad-watcher unit tests.
 *
 * The watcher is dependency-injected so we drive it with synthetic
 * `now` + `readMtime` mocks and an `injectClarification` recorder —
 * never touching the real filesystem, the IPC, or the pipelineStore.
 */

interface InjectedQuestion {
  runId: string;
  role: PipelineRole;
  question: QuestionArtifact;
}

function makeRecorder(): {
  injected: InjectedQuestion[];
  inject: (runId: string, role: PipelineRole, question: QuestionArtifact) => void;
} {
  const injected: InjectedQuestion[] = [];
  return {
    injected,
    inject: (runId, role, question) => { injected.push({ runId, role, question }); },
  };
}

describe('scratchpad-watcher', () => {
  beforeEach(() => {
    resetScratchpadStateForTest();
  });

  it('first activity with no scratchpad → no probe (file may not exist yet)', async () => {
    const rec = makeRecorder();
    let now = 1_000_000;

    await notifyBuilderActivity({
      runId: 'r1',
      role: 'builder',
      worktreePath: '/tmp/wt',
      deps: {
        readMtime: async () => null,
        injectClarification: rec.inject,
        now: () => now,
      },
    });

    expect(rec.injected).toHaveLength(0);
  });

  it('activity with fresh mtime advance → no probe (Builder is updating the file)', async () => {
    const rec = makeRecorder();
    let now = 1_000_000;
    let mtime = 999_000;

    // Seed: first activity sees mtime=999_000.
    await notifyBuilderActivity({
      runId: 'r1', role: 'builder', worktreePath: '/tmp/wt',
      deps: {
        readMtime: async () => mtime,
        injectClarification: rec.inject,
        now: () => now,
      },
    });

    // 12 minutes pass — but mtime advances along the way (Builder writes).
    now += 12 * 60 * 1000;
    mtime = now - 5_000;

    await notifyBuilderActivity({
      runId: 'r1', role: 'builder', worktreePath: '/tmp/wt',
      deps: {
        readMtime: async () => mtime,
        injectClarification: rec.inject,
        now: () => now,
      },
    });

    expect(rec.injected).toHaveLength(0);
  });

  it('activity AFTER 10min of stagnation → injects synthetic clarification', async () => {
    const rec = makeRecorder();
    const startMtime = 500_000;
    let now = 1_000_000;

    // Seed: first activity at t=1_000_000 with mtime=500_000.
    await notifyBuilderActivity({
      runId: 'r1', role: 'builder', worktreePath: '/tmp/wt',
      deps: {
        readMtime: async () => startMtime,
        injectClarification: rec.inject,
        now: () => now,
      },
    });

    // 10 minutes + 1ms pass; mtime hasn't moved.
    now += STAGNATION_THRESHOLD_MS + 1;

    await notifyBuilderActivity({
      runId: 'r1', role: 'builder', worktreePath: '/tmp/wt',
      deps: {
        readMtime: async () => startMtime,
        injectClarification: rec.inject,
        now: () => now,
      },
    });

    expect(rec.injected).toHaveLength(1);
    expect(rec.injected[0].runId).toBe('r1');
    expect(rec.injected[0].role).toBe('builder');
    expect(rec.injected[0].question.stage).toBe('builder');
    expect(rec.injected[0].question.blocking).toBe(true);
    expect(rec.injected[0].question.question).toContain('.tx-builder-notes.md');
    expect(rec.injected[0].question.question).toContain('refusal-protocol');
    expect(rec.injected[0].question.context).toContain('10+ minutes');
  });

  it('pendingProbe debounce — second stagnation activity within the same window does NOT re-fire', async () => {
    const rec = makeRecorder();
    const startMtime = 500_000;
    let now = 1_000_000;

    const deps = {
      readMtime: async () => startMtime,
      injectClarification: rec.inject,
      now: () => now,
    };

    // Seed.
    await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });

    // First stagnation trip → injects.
    now += STAGNATION_THRESHOLD_MS + 1;
    await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
    expect(rec.injected).toHaveLength(1);

    // Another sentinel arrives 30s later; mtime still hasn't moved.
    now += 30_000;
    await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
    expect(rec.injected).toHaveLength(1); // still 1 — debounced.

    // And again — long after the threshold cumulatively. Still debounced.
    now += STAGNATION_THRESHOLD_MS;
    await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
    expect(rec.injected).toHaveLength(1);
  });

  it('clearScratchpadState resets debounce — next stagnation can probe again', async () => {
    const rec = makeRecorder();
    let now = 1_000_000;
    const startMtime = 500_000;
    const deps = {
      readMtime: async () => startMtime,
      injectClarification: rec.inject,
      now: () => now,
    };

    // Seed → trip → debounce.
    await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
    now += STAGNATION_THRESHOLD_MS + 1;
    await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
    expect(rec.injected).toHaveLength(1);

    // Simulate the run leaving awaiting_clarification — controller calls
    // clearScratchpadState (terminal) OR resumeFromClarification (resume).
    // Either way, the next time the Builder activity appears with
    // continued stagnation, we should be able to probe again.
    clearScratchpadState('r1');

    // Re-seed: brand new state because clearScratchpadState wiped it.
    await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
    // Stagnation again.
    now += STAGNATION_THRESHOLD_MS + 1;
    await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });

    expect(rec.injected).toHaveLength(2);
  });

  it('resumeFromClarification clears pendingProbe and gives the Builder a fresh window', async () => {
    const rec = makeRecorder();
    // Use real Date.now-style monotonic clock since resumeFromClarification
    // calls Date.now() internally. Use vi.setSystemTime so it's controlled.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000));

    const startMtime = 500_000;
    const deps = {
      readMtime: async () => startMtime,
      injectClarification: rec.inject,
      // Use real Date.now() so resumeFromClarification's internal call
      // sees the same clock.
      now: () => Date.now(),
    };

    try {
      // Seed.
      await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });

      // 10min + 1ms passes → trip.
      vi.advanceTimersByTime(STAGNATION_THRESHOLD_MS + 1);
      await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
      expect(rec.injected).toHaveLength(1);

      // User answers → state machine moves run out of awaiting_clarification.
      // App.tsx's lifecycle listener calls resumeFromClarification.
      resumeFromClarification('r1');

      // A few more sentinels arrive immediately — no re-fire (debounce just
      // cleared but the activity stamp was bumped to "now" by resume).
      await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
      expect(rec.injected).toHaveLength(1);

      // Wait another 10min+1ms with continued stagnation → fresh probe.
      vi.advanceTimersByTime(STAGNATION_THRESHOLD_MS + 1);
      await notifyBuilderActivity({ runId: 'r1', role: 'builder', worktreePath: '/tmp/wt', deps });
      expect(rec.injected).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads mtime from <worktreePath>/.tx-builder-notes.md', async () => {
    const rec = makeRecorder();
    let observedPath: string | null = null;

    await notifyBuilderActivity({
      runId: 'r1',
      role: 'builder',
      worktreePath: '/Users/me/wt',
      deps: {
        readMtime: async (path) => { observedPath = path; return null; },
        injectClarification: rec.inject,
        now: () => 1_000_000,
      },
    });

    expect(observedPath).toBe(`/Users/me/wt/${SCRATCHPAD_FILE}`);
  });

  it('handles trailing slash on worktree path without producing a double separator', async () => {
    let observedPath: string | null = null;
    await notifyBuilderActivity({
      runId: 'r1', role: 'builder', worktreePath: '/Users/me/wt/',
      deps: {
        readMtime: async (path) => { observedPath = path; return null; },
        injectClarification: () => {},
        now: () => 1,
      },
    });
    expect(observedPath).toBe(`/Users/me/wt/${SCRATCHPAD_FILE}`);
  });

  it('handles Windows-style worktree path with backslash separator', async () => {
    let observedPath: string | null = null;
    await notifyBuilderActivity({
      runId: 'r1', role: 'builder', worktreePath: 'C:\\Users\\me\\wt',
      deps: {
        readMtime: async (path) => { observedPath = path; return null; },
        injectClarification: () => {},
        now: () => 1,
      },
    });
    expect(observedPath).toBe(`C:\\Users\\me\\wt\\${SCRATCHPAD_FILE}`);
  });
});
