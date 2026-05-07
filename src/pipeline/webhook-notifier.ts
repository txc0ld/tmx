/**
 * Webhook delivery on `awaiting_*` pipeline state entries.
 *
 * Fires a single POST per entry into:
 *   - awaiting_plan_approval
 *   - awaiting_clarification
 *   - awaiting_merge_approval
 *
 * Re-cadence is OPT-IN per project via `Project.webhookCadence`. Default is
 * `entry-only` — fire once on entry into `awaiting_*`, no reminders. This
 * preserves the Phase 2c-iii.4 ship behavior so existing integrations (chat /
 * issue trackers / CI dashboards) don't suddenly start receiving reminder
 * pings.
 *
 * Wider cadences mirror the cumulative pattern in `notifications.ts`:
 *   '15min'  → entry + 15min reminder
 *   '1hr'    → entry + 15min + 1hr
 *   '4hr'    → entry + 15min + 1hr + 4hr
 *   'daily'  → entry + 15min + 1hr + 4hr + 24hr, then every 24hr.
 *
 * "Cumulative" means: reminder N lands at threshold[N] AFTER entry, NOT after
 * the previous reminder. State exit drops the run's bookkeeping — re-entering
 * an `awaiting_*` gate starts the cadence over from zero.
 *
 * The cadence is read fresh on each tick (via `getWebhookCadence`) so changes
 * via the Settings UI apply immediately to in-flight runs.
 *
 * Payload shape:
 *   { runId, state, project, branch, summary, terminalxDeepLink }
 *
 * Body is JSON-stringified, then passed through `secretsMask` before send so
 * any leaked tokens / API keys captured in summary text are redacted at the
 * boundary.
 *
 * DI mirrors `notifications.ts`: tests inject `httpFetch`, `secretsMask`,
 * `getWebhookUrl`, `getWebhookCadence`, `deepLink`, `now`, and drive
 * `usePipelineStore` directly via the real reducer. URL validation
 * (https-only) is enforced by the deps boundary in production wiring
 * (App.tsx) — the notifier itself trusts whatever `getWebhookUrl` returns.
 *
 * Errors (network failure, secretsMask throw) are swallowed and logged via
 * `console.warn`. They must never crash the tick or interrupt the run.
 */
import type { PipelineState, WebhookCadence } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';

export const WEBHOOK_TICK_MS = 1000;

/**
 * Cumulative thresholds used to derive a per-cadence reminder schedule.
 * Index N is when reminder N+1 fires (the entry POST is reminder 0).
 *
 * `daily` extends past the array by adding the last element (24hr) each
 * additional reminder, mirroring `notifications.ts`.
 */
const RECADENCE_TABLE: Readonly<Record<WebhookCadence, readonly number[]>> = {
  'entry-only': [],
  '15min': [15 * 60 * 1000],
  '1hr': [15 * 60 * 1000, 60 * 60 * 1000],
  '4hr': [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000],
  'daily': [
    15 * 60 * 1000,
    60 * 60 * 1000,
    4 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
  ],
};

const AWAITING_STATES: ReadonlySet<PipelineState> = new Set([
  'awaiting_plan_approval',
  'awaiting_clarification',
  'awaiting_merge_approval',
]);

function isAwaiting(state: PipelineState): boolean {
  return AWAITING_STATES.has(state);
}

/**
 * Returns the cumulative threshold (ms after entry) at which reminder
 * `idx` is due. idx=0 is the entry POST (always 0). idx=1..N use the
 * cadence table. For `daily`, the last entry (24hr) extends indefinitely.
 * For other cadences, returns Infinity past the table so no further
 * reminders fire.
 */
function thresholdForReminder(cadence: WebhookCadence, idx: number): number {
  if (idx <= 0) return 0;
  const table = RECADENCE_TABLE[cadence];
  if (idx <= table.length) {
    return table[idx - 1];
  }
  if (cadence === 'daily' && table.length > 0) {
    const extra = idx - table.length;
    const last = table[table.length - 1];
    return last + extra * last;
  }
  return Number.POSITIVE_INFINITY;
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
  /**
   * Returns the configured re-fire cadence for the project. Read fresh on
   * each tick so Settings UI changes apply without restart. Falls back to
   * `entry-only` when undefined (matching the type-level default).
   */
  getWebhookCadence?(projectId: string): WebhookCadence | undefined;
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
  /** Wall clock — `Date.now` in production, fake-injected in tests. */
  now?(): number;
}

interface RunSnapshot {
  id: string;
  state: PipelineState;
  projectId: string;
  branch: string;
  question?: string;
}

interface RunBookkeeping {
  state: PipelineState;
  firstNoticeAt: number;
  /** How many reminders have fired beyond the entry POST. */
  reminderIdx: number;
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
  const bookkeeping = new Map<string, RunBookkeeping>();
  const nowFn = deps.now ?? (() => Date.now());

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

  const cadenceFor = (projectId: string): WebhookCadence => {
    return deps.getWebhookCadence?.(projectId) ?? 'entry-only';
  };

  const tick = (): void => {
    const now = nowFn();
    const snaps = snapshotRuns();
    const seen = new Set<string>();

    for (const snap of snaps) {
      seen.add(snap.id);
      const inAwaiting = isAwaiting(snap.state);
      const entry = bookkeeping.get(snap.id);

      if (!inAwaiting) {
        // State exit (or never entered) — drop bookkeeping if we had any.
        if (entry) bookkeeping.delete(snap.id);
        continue;
      }

      // From here: snap.state is awaiting_*.
      if (!entry) {
        // ENTRY — fire now, idx 0 (= entry POST).
        bookkeeping.set(snap.id, {
          state: snap.state,
          firstNoticeAt: now,
          reminderIdx: 0,
        });
        fire(snap);
        continue;
      }

      if (entry.state !== snap.state) {
        // Awaiting → different awaiting (rare but possible). Treat as a
        // fresh entry for cadence purposes.
        bookkeeping.set(snap.id, {
          state: snap.state,
          firstNoticeAt: now,
          reminderIdx: 0,
        });
        fire(snap);
        continue;
      }

      // Same awaiting state — check if next reminder is due. Cadence is
      // read fresh per tick so Settings changes apply mid-run.
      const cadence = cadenceFor(snap.projectId);
      const elapsed = now - entry.firstNoticeAt;
      const nextIdx = entry.reminderIdx + 1;
      const nextThreshold = thresholdForReminder(cadence, nextIdx);
      if (elapsed >= nextThreshold) {
        entry.reminderIdx = nextIdx;
        fire(snap);
      }
    }

    // Drop bookkeeping for runs no longer in the store.
    for (const id of bookkeeping.keys()) {
      if (!seen.has(id)) bookkeeping.delete(id);
    }
  };

  const handle = setInterval(tick, WEBHOOK_TICK_MS);
  return () => clearInterval(handle);
}
