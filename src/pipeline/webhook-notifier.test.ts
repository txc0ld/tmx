import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startWebhookNotifier, WEBHOOK_TICK_MS, type WebhookDeps } from './webhook-notifier';
import { usePipelineStore } from '@/stores/pipelineStore';
import type { RunFingerprint } from '@/types';

const FP: RunFingerprint = {
  templateId: 't', templateHash: 'h', skillHashes: {}, rolePromptHashes: {},
  models: {}, capabilityManifests: {}, terminalxVersion: '0.1.0',
};

interface Harness {
  deps: WebhookDeps;
  getWebhookUrl: ReturnType<typeof vi.fn>;
  httpFetch: ReturnType<typeof vi.fn>;
  secretsMask: ReturnType<typeof vi.fn>;
  deepLink: ReturnType<typeof vi.fn>;
  getProjectName: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  url?: string | null;
  httpFetchImpl?: WebhookDeps['httpFetch'];
  secretsMaskImpl?: WebhookDeps['secretsMask'];
  projectName?: string;
} = {}): Harness {
  const url = opts.url === undefined ? 'https://hooks.example.com/abc' : opts.url;
  const getWebhookUrl = vi.fn().mockReturnValue(url);
  const httpFetch = vi.fn(opts.httpFetchImpl ?? (async () => ({ status: 200, body: 'ok' })));
  // Default: identity (no masking) so tests can inspect raw payload.
  const secretsMask = vi.fn(opts.secretsMaskImpl ?? (async (s: string) => s));
  const deepLink = vi.fn((runId: string) => `terminalx://run/${runId}`);
  const getProjectName = vi.fn((pid: string) => opts.projectName ?? (pid === 'p1' ? 'TerminalX' : undefined));
  const deps: WebhookDeps = { getWebhookUrl, httpFetch, secretsMask, deepLink, getProjectName };
  return { deps, getWebhookUrl, httpFetch, secretsMask, deepLink, getProjectName };
}

/**
 * Drive fake clock forward in WEBHOOK_TICK_MS increments so each setInterval
 * tick fires.
 */
function advance(ms: number): void {
  const target = Date.now() + ms;
  while (Date.now() < target) {
    const delta = Math.min(WEBHOOK_TICK_MS, target - Date.now());
    vi.advanceTimersByTime(delta);
  }
}

/** Yield to the microtask queue so async fire() awaits resolve. */
async function flushAsync(): Promise<void> {
  // 4 cycles is plenty for stringify → secretsMask → httpFetch.
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
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

describe('pipeline webhook notifier', () => {
  beforeEach(() => {
    usePipelineStore.setState({ runs: {}, activeRunIds: [] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires webhook on awaiting_clarification entry with masked JSON payload', async () => {
    const h = makeHarness();
    createAwaitingClarificationRun('r1', 'Delete the foo module?');

    const stop = startWebhookNotifier(h.deps);
    advance(WEBHOOK_TICK_MS + 10);
    await flushAsync();

    expect(h.httpFetch).toHaveBeenCalledTimes(1);
    const call = h.httpFetch.mock.calls[0][0];
    expect(call.url).toBe('https://hooks.example.com/abc');
    expect(call.method).toBe('POST');
    expect(call.headers?.['Content-Type']).toBe('application/json');

    const body = JSON.parse(call.body as string);
    expect(body.runId).toBe('r1');
    expect(body.state).toBe('awaiting_clarification');
    expect(body.project).toBe('TerminalX');
    expect(body.branch).toBe('feat/r1');
    expect(body.summary).toContain('Delete the foo module?');
    expect(body.terminalxDeepLink).toBe('terminalx://run/r1');

    // secretsMask called with the JSON.stringify result.
    expect(h.secretsMask).toHaveBeenCalledTimes(1);
    const maskedInput = h.secretsMask.mock.calls[0][0] as string;
    expect(JSON.parse(maskedInput).runId).toBe('r1');
    stop();
  });

  it('does not fire when getWebhookUrl returns null', async () => {
    const h = makeHarness({ url: null });
    createAwaitingClarificationRun('r1', 'q?');

    const stop = startWebhookNotifier(h.deps);
    advance(WEBHOOK_TICK_MS + 10);
    await flushAsync();

    expect(h.httpFetch).not.toHaveBeenCalled();
    expect(h.secretsMask).not.toHaveBeenCalled();
    stop();
  });

  it('fires again on a second awaiting_* entry within the same run', async () => {
    const h = makeHarness();
    createAwaitingClarificationRun('r1', 'first?');

    const stop = startWebhookNotifier(h.deps);
    advance(WEBHOOK_TICK_MS + 10);
    await flushAsync();
    expect(h.httpFetch).toHaveBeenCalledTimes(1);

    // Answer the clarification → run resumes (leaves awaiting_*).
    usePipelineStore.getState().dispatch('r1', { type: 'clarification_received', answer: 'yes' });
    advance(WEBHOOK_TICK_MS + 10);
    await flushAsync();
    expect(h.httpFetch).toHaveBeenCalledTimes(1);

    // Builder asks another question → new awaiting_clarification entry.
    usePipelineStore.getState().dispatch('r1', { type: 'question_raised', question: {
      stage: 'builder', question: 'second?', context: '', blocking: true,
    }});
    advance(WEBHOOK_TICK_MS + 10);
    await flushAsync();

    expect(h.httpFetch).toHaveBeenCalledTimes(2);
    const second = JSON.parse(h.httpFetch.mock.calls[1][0].body as string);
    expect(second.summary).toContain('second?');
    stop();
  });

  it('swallows network errors — httpFetch reject does not throw', async () => {
    const h = makeHarness({
      httpFetchImpl: async () => { throw new Error('boom'); },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* mute */ });
    createAwaitingPlanApprovalRun('r1');

    const stop = startWebhookNotifier(h.deps);
    advance(WEBHOOK_TICK_MS + 10);
    await flushAsync();

    // Ticker keeps running.
    advance(WEBHOOK_TICK_MS * 2);
    await flushAsync();

    expect(h.httpFetch).toHaveBeenCalledTimes(1); // entry-only, not re-fired
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    stop();
  });

  it('does not re-fire while still in the same awaiting state', async () => {
    const h = makeHarness();
    createAwaitingPlanApprovalRun('r1');

    const stop = startWebhookNotifier(h.deps);
    advance(WEBHOOK_TICK_MS + 10);
    await flushAsync();
    expect(h.httpFetch).toHaveBeenCalledTimes(1);

    // Stay in awaiting_plan_approval for many ticks → still one call.
    advance(WEBHOOK_TICK_MS * 30);
    await flushAsync();
    expect(h.httpFetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it('cleanup fn stops the interval — no webhooks fire after stop()', async () => {
    const h = makeHarness();
    const stop = startWebhookNotifier(h.deps);
    stop();

    createAwaitingClarificationRun('r1', 'q?');
    advance(WEBHOOK_TICK_MS * 5);
    await flushAsync();

    expect(h.httpFetch).not.toHaveBeenCalled();
  });
});
