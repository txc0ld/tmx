import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startNotifier,
  RECADENCE_MS,
  NOTIFY_TICK_MS,
  type NotificationDeps,
} from './notifications';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

interface Harness {
  deps: NotificationDeps;
  send: ReturnType<typeof vi.fn>;
  setNow(t: number): void;
}

function makeHarness(opts: { getProjectName?: (id: string) => string | undefined } = {}): Harness {
  let now = Date.now();
  const send = vi.fn();
  const deps: NotificationDeps = {
    send,
    now: () => now,
    getProjectName: opts.getProjectName,
  };
  return { deps, send, setNow: t => { now = t; } };
}

/**
 * Drive the fake clock forward in `NOTIFY_TICK_MS` increments so each setInterval
 * tick observes a synchronized deps.now() and Date.now(). Mirrors the helper
 * pattern in stuck-detector.test.ts.
 */
function advanceTo(h: Harness, targetTs: number): void {
  while (Date.now() < targetTs) {
    const next = Math.min(Date.now() + NOTIFY_TICK_MS, targetTs);
    const delta = next - Date.now();
    vi.advanceTimersByTime(delta);
    h.setNow(Date.now());
  }
}

function createAwaitingClarificationRun(runId: string, question: string): void {
  const store = usePipelineStore.getState();
  store.createRun({
    runId, templateId: 't', projectId: 'p1',
    worktreePath: '/tmp/wt', branch: `feat/${runId}`, fingerprint: FP,
  });
  store.dispatch(runId, { type: 'start' });
  store.dispatch(runId, { type: 'question_raised', question: {
    stage: 'planner', question, context: '', blocking: true,
  }});
}

function createAwaitingPlanApprovalRun(runId: string): void {
  const store = usePipelineStore.getState();
  store.createRun({
    runId, templateId: 't', projectId: 'p1',
    worktreePath: '/tmp/wt', branch: `feat/${runId}`, fingerprint: FP,
  });
  store.dispatch(runId, { type: 'start' });
  store.dispatch(runId, { type: 'planner_done', plan: {
    stage: 'planner', branch: `feat/${runId}`, specPath: 's', planPath: 'p',
    tasks: [], summary: 'sum', planCommitSha: 'sha',
  }});
}

describe('pipeline notifier', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a notification on awaiting_clarification entry with run id and question text', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    createAwaitingClarificationRun('r1', 'Do you want to delete the foo module?');

    const stop = startNotifier(h.deps);
    advanceTo(h, Date.now() + NOTIFY_TICK_MS + 10);

    expect(h.send).toHaveBeenCalledTimes(1);
    const call = h.send.mock.calls[0][0];
    expect(call.title).toContain('r1');
    expect(call.body).toContain('awaiting_clarification');
    expect(call.body).toContain('Do you want to delete the foo module?');
    stop();
  });

  it('re-cadence fires at 15min cumulative (entry + 15min reminder)', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    createAwaitingClarificationRun('r1', 'q?');

    const stop = startNotifier(h.deps);
    advanceTo(h, Date.now() + NOTIFY_TICK_MS + 10); // entry fires
    expect(h.send).toHaveBeenCalledTimes(1);

    // Advance to 15min mark. Cumulative thresholds: entry+15min should be 2nd fire.
    advanceTo(h, Date.now() + RECADENCE_MS[0] + NOTIFY_TICK_MS);
    expect(h.send).toHaveBeenCalledTimes(2);
    stop();
  });

  it('re-cadence is cumulative — 1hr after entry fires the 3rd notification', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    createAwaitingClarificationRun('r1', 'q?');

    const stop = startNotifier(h.deps);
    advanceTo(h, Date.now() + NOTIFY_TICK_MS + 10); // entry
    const entryAt = Date.now();
    expect(h.send).toHaveBeenCalledTimes(1);

    // 15min after entry: 2nd fire.
    advanceTo(h, entryAt + RECADENCE_MS[0] + NOTIFY_TICK_MS);
    expect(h.send).toHaveBeenCalledTimes(2);

    // 1hr after entry (NOT 1hr after the 15min reminder): 3rd fire.
    advanceTo(h, entryAt + RECADENCE_MS[1] + NOTIFY_TICK_MS);
    expect(h.send).toHaveBeenCalledTimes(3);
    stop();
  });

  it('clears bookkeeping on state exit — no further notifications after leaving awaiting_*', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    createAwaitingClarificationRun('r1', 'q?');

    const stop = startNotifier(h.deps);
    advanceTo(h, Date.now() + NOTIFY_TICK_MS + 10);
    expect(h.send).toHaveBeenCalledTimes(1);

    // User answers — clarification_received resumes the prior active state.
    usePipelineStore.getState().dispatch('r1', { type: 'clarification_received', answer: 'yes' });

    // Advance well past every cadence point — no more notifications.
    advanceTo(h, Date.now() + RECADENCE_MS[3] + 60_000);
    expect(h.send).toHaveBeenCalledTimes(1);
    stop();
  });

  it('multiple runs fire independent notifications', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    createAwaitingClarificationRun('r1', 'first?');
    createAwaitingPlanApprovalRun('r2');

    const stop = startNotifier(h.deps);
    advanceTo(h, Date.now() + NOTIFY_TICK_MS + 10);

    expect(h.send).toHaveBeenCalledTimes(2);
    const titles = h.send.mock.calls.map(c => c[0].title as string).sort();
    expect(titles[0]).toContain('r1');
    expect(titles[1]).toContain('r2');
    const bodies = h.send.mock.calls.map(c => c[0].body as string);
    expect(bodies.some(b => b.includes('awaiting_clarification'))).toBe(true);
    expect(bodies.some(b => b.includes('Plan ready for review'))).toBe(true);
    stop();
  });

  it('daily cadence after the table is exhausted (24hr → +24hr fires once more)', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    createAwaitingClarificationRun('r1', 'q?');

    const stop = startNotifier(h.deps);
    advanceTo(h, Date.now() + NOTIFY_TICK_MS + 10); // entry
    const entryAt = Date.now();

    // March through every cadence step: 15min, 1hr, 4hr, 24hr.
    for (const t of RECADENCE_MS) {
      advanceTo(h, entryAt + t + NOTIFY_TICK_MS);
    }
    // Should be entry + 4 reminders = 5 calls.
    expect(h.send).toHaveBeenCalledTimes(5);

    // Another 24hr (daily cadence) → 6th fire.
    advanceTo(h, entryAt + RECADENCE_MS[3] + RECADENCE_MS[3] + NOTIFY_TICK_MS);
    expect(h.send).toHaveBeenCalledTimes(6);
    stop();
  });

  it('uses project name in title when getProjectName resolves it', () => {
    const h = makeHarness({ getProjectName: id => id === 'p1' ? 'TerminalX' : undefined });
    h.setNow(Date.now());
    createAwaitingPlanApprovalRun('r1');

    const stop = startNotifier(h.deps);
    advanceTo(h, Date.now() + NOTIFY_TICK_MS + 10);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].title).toContain('TerminalX');
    expect(h.send.mock.calls[0][0].title).toContain('r1');
    stop();
  });

  it('cleanup fn stops the interval — no notifications after stop()', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    createAwaitingClarificationRun('r1', 'q?');

    const stop = startNotifier(h.deps);
    stop();

    advanceTo(h, Date.now() + RECADENCE_MS[3] + 60_000);
    expect(h.send).not.toHaveBeenCalled();
  });
});
