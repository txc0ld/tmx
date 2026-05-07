import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startStuckDetector,
  PROBE_THRESHOLD_MS,
  ABORT_THRESHOLD_MS,
  TICK_MS,
  type StuckDetectorDeps,
  type StuckDetectorRunView,
} from './stuck-detector';

/**
 * Test harness: a controllable clock fed via deps.now(), with vi.useFakeTimers
 * driving the 250ms setInterval. No real wall-clock waits.
 */
interface Harness {
  deps: StuckDetectorDeps;
  probe: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  /** Mutable list — tests push runs / mutate fields, then advance timers. */
  runs: StuckDetectorRunView[];
  /** Mutable map — tests can poke a synthetic stdout event. */
  stdoutAt: Map<string, number>;
  setNow(t: number): void;
}

function makeHarness(): Harness {
  const runs: StuckDetectorRunView[] = [];
  const stdoutAt = new Map<string, number>();
  let now = 0;
  const probe = vi.fn(async () => { /* no-op */ });
  const abort = vi.fn();
  const deps: StuckDetectorDeps = {
    getActiveRuns: () => runs.slice(),
    getLastStdoutAt: id => stdoutAt.get(id),
    probeAgent: probe,
    abortRun: abort,
    now: () => now,
  };
  return {
    deps, probe, abort, runs, stdoutAt,
    setNow: t => { now = t; },
  };
}

/**
 * Advance the fake clock to `targetTs` and run the detector tick at every
 * 250ms boundary so each tick sees a synchronized clock+timer. We always
 * rebase the deps clock to the same Date.now() the detector observes.
 */
function advanceTo(h: Harness, targetTs: number): void {
  // Use the wall-clock baseline vitest started fake timers from. The detector
  // only reads time via deps.now(); we keep deps.now() == fake Date.now() so
  // both views agree.
  while (Date.now() < targetTs) {
    const next = Math.min(Date.now() + TICK_MS, targetTs);
    const delta = next - Date.now();
    vi.advanceTimersByTime(delta);
    h.setNow(Date.now());
  }
}

describe('stuck-detector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not probe before 5min of silence', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    h.runs.push({ id: 'r1', startedAt: Date.now(), ptyId: 'pty-1' });

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + 4 * 60 * 1000); // 4min

    expect(h.probe).not.toHaveBeenCalled();
    expect(h.abort).not.toHaveBeenCalled();
    stop();
  });

  it('probes once after 5min of silence', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    h.runs.push({ id: 'r1', startedAt: Date.now(), ptyId: 'pty-1' });

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + PROBE_THRESHOLD_MS + 1000);

    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledWith('r1', 'pty-1');
    expect(h.abort).not.toHaveBeenCalled();
    stop();
  });

  it('does not double-probe between two ticks at the same lastActivity', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    h.runs.push({ id: 'r1', startedAt: Date.now(), ptyId: 'pty-1' });

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + PROBE_THRESHOLD_MS + 1000);
    expect(h.probe).toHaveBeenCalledTimes(1);

    // Another minute under the abort threshold — still no second probe.
    advanceTo(h, Date.now() + 60 * 1000);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.abort).not.toHaveBeenCalled();
    stop();
  });

  it('aborts after 8min of silence with stage_unresponsive reason', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    h.runs.push({ id: 'r1', startedAt: Date.now(), ptyId: 'pty-1' });

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + ABORT_THRESHOLD_MS + 1000);

    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.abort.mock.calls[0][0]).toBe('r1');
    expect(h.abort.mock.calls[0][1]).toMatch(/^stage_unresponsive/);
    stop();
  });

  it('heartbeat resets the probe timer', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    const run: StuckDetectorRunView = { id: 'r1', startedAt: Date.now(), ptyId: 'pty-1' };
    h.runs.push(run);

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + 4 * 60 * 1000); // 4min silent
    expect(h.probe).not.toHaveBeenCalled();

    // Heartbeat lands — bumps lastHeartbeatAt to "now".
    run.lastHeartbeatAt = Date.now();
    advanceTo(h, Date.now() + 4 * 60 * 1000); // 4min more — only 4min since heartbeat

    expect(h.probe).not.toHaveBeenCalled();
    expect(h.abort).not.toHaveBeenCalled();
    stop();
  });

  it('stdout activity resets probe-eligibility', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    h.runs.push({ id: 'r1', startedAt: Date.now(), ptyId: 'pty-1' });

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + 4 * 60 * 1000);

    // Stdout chunk arrives — controller-runtime's liveness map gets bumped.
    h.stdoutAt.set('r1', Date.now());
    advanceTo(h, Date.now() + 4 * 60 * 1000);

    expect(h.probe).not.toHaveBeenCalled();
    expect(h.abort).not.toHaveBeenCalled();
    stop();
  });

  it('terminal-state runs (not in active list) are never probed', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    // getActiveRuns returns []; a run that's already terminal is filtered
    // out by the production wiring, so the detector should never see it.

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + ABORT_THRESHOLD_MS + 60 * 1000);

    expect(h.probe).not.toHaveBeenCalled();
    expect(h.abort).not.toHaveBeenCalled();
    stop();
  });

  it('re-arms the probe after activity resumes — quiet → loud → quiet → probe again', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    const run: StuckDetectorRunView = { id: 'r1', startedAt: Date.now(), ptyId: 'pty-1' };
    h.runs.push(run);

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + PROBE_THRESHOLD_MS + 1000);
    expect(h.probe).toHaveBeenCalledTimes(1);

    // Activity returns: stdout chunk lands. Bookkeeping should re-arm.
    h.stdoutAt.set('r1', Date.now());
    advanceTo(h, Date.now() + 30 * 1000); // breathe
    // …then go quiet again past the threshold.
    advanceTo(h, Date.now() + PROBE_THRESHOLD_MS + 1000);

    expect(h.probe).toHaveBeenCalledTimes(2);
    stop();
  });

  it('marks probed even when ptyId is missing (so we do not spam-tick)', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    h.runs.push({ id: 'r1', startedAt: Date.now() }); // no ptyId

    const stop = startStuckDetector(h.deps);
    advanceTo(h, Date.now() + PROBE_THRESHOLD_MS + 1000);
    expect(h.probe).not.toHaveBeenCalled();

    // 100 more ticks under the abort threshold — ensure we never call probe
    // even once since there's no PTY to probe.
    advanceTo(h, Date.now() + 60 * 1000);
    expect(h.probe).not.toHaveBeenCalled();
    stop();
  });

  it('cleanup fn stops the interval', () => {
    const h = makeHarness();
    h.setNow(Date.now());
    h.runs.push({ id: 'r1', startedAt: Date.now(), ptyId: 'pty-1' });

    const stop = startStuckDetector(h.deps);
    stop();

    advanceTo(h, Date.now() + ABORT_THRESHOLD_MS + 60 * 1000);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.abort).not.toHaveBeenCalled();
  });
});
