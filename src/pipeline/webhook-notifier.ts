/**
 * Webhook delivery on `awaiting_*` pipeline state entries.
 *
 * Fires a single POST per entry into:
 *   - awaiting_plan_approval
 *   - awaiting_clarification
 *   - awaiting_merge_approval
 *
 * Re-cadence is intentionally NOT supported here (unlike `notifications.ts`).
 * Webhooks pipe into chat/issue trackers/CI dashboards where each event is
 * persisted; re-firing the same notice every 15min would create alert noise.
 * If a run leaves an awaiting state and re-enters one (same or different
 * gate), that's a fresh entry and fires again.
 *
 * Payload shape:
 *   { runId, state, project, branch, summary, terminalxDeepLink }
 *
 * Body is JSON-stringified, then passed through `secretsMask` before send so
 * any leaked tokens / API keys captured in summary text are redacted at the
 * boundary.
 *
 * DI mirrors `notifications.ts`: tests inject `httpFetch`, `secretsMask`,
 * `getWebhookUrl`, `deepLink`, and drive `usePipelineStore` directly via
 * the real reducer. URL validation (https-only) is enforced by the deps
 * boundary in production wiring (App.tsx) — the notifier itself trusts
 * whatever `getWebhookUrl` returns.
 *
 * Errors (network failure, secretsMask throw) are swallowed and logged via
 * `console.warn`. They must never crash the tick or interrupt the run.
 */
import type { PipelineState } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';

export const WEBHOOK_TICK_MS = 1000;

const AWAITING_STATES: ReadonlySet<PipelineState> = new Set([
  'awaiting_plan_approval',
  'awaiting_clarification',
  'awaiting_merge_approval',
]);

function isAwaiting(state: PipelineState): boolean {
  return AWAITING_STATES.has(state);
}

export interface WebhookPayload {
  runId: string;
  state: PipelineState;
  project: string;
  branch: string;
  summary: string;
  terminalxDeepLink: string;
}

export interface WebhookDeps {
  /**
   * Returns the configured webhook URL for the project, or null if disabled.
   * Production wiring is responsible for validating https-only and rejecting
   * malformed URLs — anything this returns is sent verbatim.
   */
  getWebhookUrl(projectId: string): string | null;
  /** httpFetch wrapper — DI'd for tests. */
  httpFetch(opts: {
    url: string;
    method: 'POST';
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }>;
  /** secretsMask wrapper — DI'd for tests. */
  secretsMask(input: string): Promise<string>;
  /** Build the deep-link URL for a run. */
  deepLink(runId: string): string;
  /**
   * Optional human-readable project name lookup. Falls back to projectId
   * when undefined or missing.
   */
  getProjectName?(projectId: string): string | undefined;
}

interface RunSnapshot {
  id: string;
  state: PipelineState;
  projectId: string;
  branch: string;
  question?: string;
}

function snapshotRuns(): RunSnapshot[] {
  const store = usePipelineStore.getState();
  const out: RunSnapshot[] = [];
  for (const run of Object.values(store.runs)) {
    const lastQuestion = run.artifacts.questions[run.artifacts.questions.length - 1];
    out.push({
      id: run.id,
      state: run.state,
      projectId: run.projectId,
      branch: run.branch,
      question: lastQuestion?.question,
    });
  }
  return out;
}

function buildSummary(snap: RunSnapshot): string {
  switch (snap.state) {
    case 'awaiting_plan_approval':
      return 'Plan ready for review';
    case 'awaiting_clarification': {
      const q = snap.question ?? 'Question pending';
      return q.length > 200 ? q.slice(0, 197) + '...' : q;
    }
    case 'awaiting_merge_approval':
      return `Merge gate — branch ${snap.branch} ready`;
    default:
      return snap.state;
  }
}

function buildPayload(snap: RunSnapshot, deps: WebhookDeps): WebhookPayload {
  return {
    runId: snap.id,
    state: snap.state,
    project: deps.getProjectName?.(snap.projectId) ?? snap.projectId,
    branch: snap.branch,
    summary: buildSummary(snap),
    terminalxDeepLink: deps.deepLink(snap.id),
  };
}

/**
 * Start the webhook notifier. Returns a cleanup function that stops the tick
 * interval. Call once at app boot; cleanup is idempotent.
 */
export function startWebhookNotifier(deps: WebhookDeps): () => void {
  // Per-run record of which awaiting state we last fired for, so re-entries
  // (e.g. clarification → builder → another clarification) fire again.
  const lastFiredState = new Map<string, PipelineState>();

  const fire = (snap: RunSnapshot): void => {
    const url = deps.getWebhookUrl(snap.projectId);
    if (!url || url.length === 0) return;

    const payload = buildPayload(snap, deps);
    void (async () => {
      try {
        const json = JSON.stringify(payload);
        const masked = await deps.secretsMask(json);
        await deps.httpFetch({
          url,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: masked,
        });
      } catch (err) {
        // Webhook failures must never crash the tick.
        console.warn('[pipeline] webhook delivery failed:', err);
      }
    })();
  };

  const tick = (): void => {
    const snaps = snapshotRuns();
    const seen = new Set<string>();

    for (const snap of snaps) {
      seen.add(snap.id);
      const inAwaiting = isAwaiting(snap.state);
      const last = lastFiredState.get(snap.id);

      if (!inAwaiting) {
        // State exit (or never entered) — drop bookkeeping so the next entry
        // counts as a fresh entry.
        if (last !== undefined) lastFiredState.delete(snap.id);
        continue;
      }

      // In awaiting_*: fire only on entry (when last is undefined OR has
      // changed to a different awaiting state).
      if (last !== snap.state) {
        lastFiredState.set(snap.id, snap.state);
        fire(snap);
      }
    }

    // Drop bookkeeping for runs no longer in the store.
    for (const id of lastFiredState.keys()) {
      if (!seen.has(id)) lastFiredState.delete(id);
    }
  };

  const handle = setInterval(tick, WEBHOOK_TICK_MS);
  return () => clearInterval(handle);
}
