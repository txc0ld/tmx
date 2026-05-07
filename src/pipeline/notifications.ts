/**
 * OS notification + dock badge for `awaiting_*` pipeline states.
 *
 * Fires a notification on entry to any of:
 *   - awaiting_plan_approval
 *   - awaiting_clarification
 *   - awaiting_merge_approval
 *
 * Re-fires on a CUMULATIVE cadence measured from `firstNoticeAt`:
 *   15min → 1hr → 4hr → 24hr (then daily).
 *
 * "Cumulative" means: the second reminder lands 15min after entry, the third
 * 1hr after entry (NOT 1hr after the 15min reminder), the fourth 4hr after
 * entry, the fifth 24hr after entry, then once per 24hr indefinitely.
 *
 * On state EXIT (any transition out of an `awaiting_*` state) the run's
 * bookkeeping is dropped — re-entering will start the cadence over from zero.
 *
 * DI mirrors `stuck-detector.ts`: tests inject `send` + `now` and drive the
 * tick interval via `vi.useFakeTimers()`. App.tsx wires `sendNotification`
 * from `@tauri-apps/plugin-notification`.
 */
import type { PipelineState } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';

/**
 * Cumulative thresholds from `firstNoticeAt`. Index N is when reminder N+1
 * fires (the entry notification is reminder 0, fired immediately).
 *
 * After exhausting this array we keep firing every `RECADENCE_MS[length - 1]`
 * (24hr) — daily.
 */
export const RECADENCE_MS: readonly number[] = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

export const NOTIFY_TICK_MS = 1000;

const AWAITING_STATES: ReadonlySet<PipelineState> = new Set([
  'awaiting_plan_approval',
  'awaiting_clarification',
  'awaiting_merge_approval',
]);

function isAwaiting(state: PipelineState): boolean {
  return AWAITING_STATES.has(state);
}

export interface NotificationDeps {
  /**
   * Side-effecting OS notification. Callers may return a Promise — we
   * fire-and-forget. Synchronous throws are caught.
   */
  send(opts: { title: string; body: string }): Promise<void> | void;
  /** Wall clock — `Date.now` in production, fake-injected in tests. */
  now(): number;
  /**
   * Optional human-readable project name lookup. Production wires this to
   * `useProjectStore.getState().projects.find(...)`. Falls back to runId in
   * the title when undefined or missing.
   */
  getProjectName?(projectId: string): string | undefined;
}

interface RunBookkeeping {
  state: PipelineState;
  firstNoticeAt: number;
  /** How many reminders have fired beyond the entry notification. */
  reminderIdx: number;
  /** When the last reminder fired (informational; not used for scheduling). */
  lastNoticeAt: number;
}

/**
 * Returns the cumulative threshold (ms after entry) at which reminder
 * `idx` is due. idx=0 is the entry notification (always 0). idx=1..N use
 * RECADENCE_MS. After the array is exhausted we extend by adding the last
 * cadence (24hr) repeatedly so reminderIdx grows past the array length.
 */
function thresholdForReminder(idx: number): number {
  if (idx <= 0) return 0;
  if (idx <= RECADENCE_MS.length) {
    return RECADENCE_MS[idx - 1];
  }
  // Beyond the table: keep adding the last cadence (daily).
  const extra = idx - RECADENCE_MS.length;
  const last = RECADENCE_MS[RECADENCE_MS.length - 1];
  return RECADENCE_MS[RECADENCE_MS.length - 1] + extra * last;
}

interface RunSnapshot {
  id: string;
  state: PipelineState;
  projectId: string;
  /** Most recent question text when in awaiting_clarification, else undefined. */
  question?: string;
  /** Worktree branch — used in awaiting_merge_approval body. */
  branch?: string;
}

function buildBody(snap: RunSnapshot): string {
  switch (snap.state) {
    case 'awaiting_plan_approval':
      return `${snap.state}: Plan ready for review`;
    case 'awaiting_clarification': {
      const q = snap.question ?? 'Question pending';
      const truncated = q.length > 80 ? q.slice(0, 77) + '...' : q;
      return `${snap.state}: ${truncated}`;
    }
    case 'awaiting_merge_approval': {
      const branch = snap.branch ?? '(unknown)';
      return `${snap.state}: Merge gate — branch \`${branch}\` ready`;
    }
    default:
      return snap.state;
  }
}

function buildTitle(snap: RunSnapshot, deps: NotificationDeps): string {
  const project = deps.getProjectName?.(snap.projectId);
  if (project && project.length > 0) return `TerminalX — ${project} (${snap.id})`;
  return `TerminalX — ${snap.id}`;
}

/**
 * Snapshot every active run from `usePipelineStore`. Pulled out so tests
 * can stub via deps if needed (currently not — tests drive the store
 * directly via `usePipelineStore.getState().createRun/dispatch`).
 */
function snapshotRuns(): RunSnapshot[] {
  const store = usePipelineStore.getState();
  const out: RunSnapshot[] = [];
  for (const run of Object.values(store.runs)) {
    const lastQuestion = run.artifacts.questions[run.artifacts.questions.length - 1];
    out.push({
      id: run.id,
      state: run.state,
      projectId: run.projectId,
      question: lastQuestion?.question,
      branch: run.branch,
    });
  }
  return out;
}

/**
 * Start the notifier. Returns a cleanup function that stops the tick interval.
 * Call once at app boot; cleanup is idempotent.
 */
export function startNotifier(deps: NotificationDeps): () => void {
  const bookkeeping = new Map<string, RunBookkeeping>();

  const fire = (snap: RunSnapshot, when: number, idx: number): void => {
    const title = buildTitle(snap, deps);
    const body = buildBody(snap);
    try {
      const ret = deps.send({ title, body });
      if (ret && typeof (ret as Promise<void>).catch === 'function') {
        (ret as Promise<void>).catch(() => { /* swallow */ });
      }
    } catch {
      // Notification failures must never crash the tick.
    }
    const existing = bookkeeping.get(snap.id);
    if (existing) {
      existing.lastNoticeAt = when;
      existing.reminderIdx = idx;
    }
  };

  const tick = (): void => {
    const now = deps.now();
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
        // ENTRY — fire now, idx 0 (= entry notification).
        const fresh: RunBookkeeping = {
          state: snap.state,
          firstNoticeAt: now,
          reminderIdx: 0,
          lastNoticeAt: now,
        };
        bookkeeping.set(snap.id, fresh);
        fire(snap, now, 0);
        continue;
      }

      if (entry.state !== snap.state) {
        // Awaiting → different awaiting (rare but possible if reducer
        // ever transitions between awaiting_* without going through an
        // active state). Treat as a fresh entry for cadence purposes.
        const fresh: RunBookkeeping = {
          state: snap.state,
          firstNoticeAt: now,
          reminderIdx: 0,
          lastNoticeAt: now,
        };
        bookkeeping.set(snap.id, fresh);
        fire(snap, now, 0);
        continue;
      }

      // Same awaiting state — check if next reminder is due.
      const elapsed = now - entry.firstNoticeAt;
      const nextIdx = entry.reminderIdx + 1;
      const nextThreshold = thresholdForReminder(nextIdx);
      if (elapsed >= nextThreshold) {
        fire(snap, now, nextIdx);
      }
    }

    // Drop bookkeeping for runs that have left the active set entirely
    // (removed from the store, not just transitioned).
    for (const id of bookkeeping.keys()) {
      if (!seen.has(id)) bookkeeping.delete(id);
    }
  };

  const handle = setInterval(tick, NOTIFY_TICK_MS);
  return () => clearInterval(handle);
}
