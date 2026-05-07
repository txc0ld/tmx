/**
 * Compaction-watcher (Phase 3b.6).
 *
 * Long Builder runs can accumulate megabytes of PTY output between
 * sentinels. The active context window grows unbounded, latency goes up,
 * and the LLM eventually hallucinates because relevant detail is buried.
 * This watcher inserts a compaction checkpoint: when Builder produces
 * `COMPACTION_THRESHOLD_BYTES` (200KB) of output since the last sentinel,
 * the controller writes a synthetic prompt to the Builder PTY asking it
 * to summarise progress. The Builder responds with
 * `<<<TX_COMPACTION_DONE>>>{"summary":"..."}` which the controller
 * appends to `<worktree>/.tx-builder-notes.md` under
 * `## Compaction summaries`.
 *
 * Two distinct counters are at play:
 *   - The scanner-buffer cap in `controller-runtime` (64KB) is a memory
 *     safety net for the sentinel parser.
 *   - The compaction counter here (200KB) is the trigger for writing a
 *     prompt to the agent. They serve different purposes and live on
 *     different state.
 *
 * Builder OWNS the scratchpad in normal operation (see
 * `tx-pipeline-builder-scratchpad` skill). The Controller appending
 * here is an inversion — accepted because the Builder is paused
 * round-tripping the compaction prompt, so the file isn't being edited
 * concurrently. We read → mutate in-memory → write atomically through
 * `writeFileText` (which the IPC implements via temp + rename).
 *
 * DI'd so vitest can drive it with mocks for `writeToPty`,
 * `readScratchpad`, `writeScratchpad`, and `now` — never touching the
 * real PTY or filesystem.
 */

import { ptyWrite, readFileText, writeFileText, readFileMtime } from '@/utils/ipc';
import { SCRATCHPAD_FILE } from './scratchpad-watcher';
import { emitTelemetry, usePipelineStore } from '@/stores/pipelineStore';

export const COMPACTION_THRESHOLD_BYTES = 200 * 1024;
export const COMPACTION_SECTION_HEADER = '## Compaction summaries';

/** Prompt sent to Builder PTY when threshold trips. Exported for testing. */
export const COMPACTION_PROMPT =
  '\nSummarize progress so far in <=500 tokens; identify next concrete action; resume.\n' +
  'Reply with: <<<TX_COMPACTION_DONE>>>{"summary":"..."}\n';

interface RunState {
  bytesSinceLastSentinel: number;
  pendingCompaction: boolean;
}

const state = new Map<string, RunState>();

export interface CompactionDeps {
  /** Write the compaction prompt to the Builder PTY. */
  writeToPty(ptyId: string, data: string): Promise<void>;
  /** Read existing scratchpad contents. Returns `null` if missing. */
  readScratchpad(path: string): Promise<string | null>;
  /** Atomically write the merged scratchpad contents. */
  writeScratchpad(path: string, contents: string): Promise<void>;
  /** Touch the scratchpad mtime to "now" so the scratchpad-watcher's
   *  stagnation timer doesn't false-fire on the controller's own write.
   *  Production wires to `readFileMtime` after the write to confirm; the
   *  side-effect of `writeFileText` already updates mtime. The dep is here
   *  primarily so tests can observe the call. */
  refreshMtime(path: string): Promise<void>;
  /** Wall clock — `Date.now` in production, fake-injected in tests. */
  now(): number;
}

function defaultDeps(): CompactionDeps {
  return {
    writeToPty: (id, data) => ptyWrite(id, data),
    readScratchpad: async (path) => {
      try {
        return await readFileText(path);
      } catch {
        // Missing file is the common case on first compaction — return null
        // and let `handleCompactionDone` create the file.
        return null;
      }
    },
    writeScratchpad: (path, contents) => writeFileText(path, contents),
    refreshMtime: async (path) => {
      // No-op consumer of the mtime; the read primes the OS-level cache and
      // gives the scratchpad-watcher a stable observation. Errors are
      // ignored — this is bookkeeping, not load-bearing.
      try { await readFileMtime(path); } catch { /* ignore */ }
    },
    now: () => Date.now(),
  };
}

export interface NotifyBytesInput {
  runId: string;
  ptyId: string;
  worktreePath: string;
  byteCount: number;
  deps?: Partial<CompactionDeps>;
}

/**
 * Notify the watcher that the Builder PTY produced `byteCount` more bytes.
 * Caller is responsible for filtering on `role === 'builder'`. When the
 * cumulative byte count crosses `COMPACTION_THRESHOLD_BYTES`, fires the
 * compaction prompt to the Builder PTY (once per pending window).
 */
export async function notifyBuilderBytes(input: NotifyBytesInput): Promise<void> {
  const merged: CompactionDeps = { ...defaultDeps(), ...input.deps };
  const entry = state.get(input.runId) ?? { bytesSinceLastSentinel: 0, pendingCompaction: false };
  entry.bytesSinceLastSentinel += input.byteCount;
  state.set(input.runId, entry);

  if (entry.pendingCompaction) return;
  if (entry.bytesSinceLastSentinel < COMPACTION_THRESHOLD_BYTES) return;

  // Trip — write prompt and arm pending flag BEFORE awaiting the IPC so
  // a re-entrant notify (more PTY chunks in flight) can't double-fire.
  entry.pendingCompaction = true;
  state.set(input.runId, entry);
  // Snapshot the byte count that tripped the threshold BEFORE awaiting
  // the PTY write. Re-entrant `notifyBuilderBytes` calls keep mutating
  // `entry.bytesSinceLastSentinel`, so reading it after the await would
  // overcount. Telemetry should record what actually triggered the prompt.
  const bytesAtTrip = entry.bytesSinceLastSentinel;

  try {
    await merged.writeToPty(input.ptyId, COMPACTION_PROMPT);
  } catch (err) {
    // Couldn't deliver the prompt — clear pending so the next chunk can
    // retry. Log so a developer sees the issue. No telemetry event on
    // failure: the pending flag flips back to false and the next chunk
    // re-enters this path; emitting on the eventual success keeps the
    // JSONL one-line-per-trigger.
    entry.pendingCompaction = false;
    state.set(input.runId, entry);
    // eslint-disable-next-line no-console
    console.warn('[pipeline] compaction-watcher writeToPty failed:', err);
    return;
  }

  // Phase 3b.8: emit telemetry AFTER the prompt landed on the PTY so
  // the JSONL log records exactly the deliveries the Builder will see.
  // `projectId` is read from the run record — consistent with the
  // controller-runtime pattern; the watcher otherwise has no project
  // visibility. Best-effort: missing run = empty string (won't happen
  // in production, defensive for tests).
  const run = usePipelineStore.getState().runs[input.runId];
  emitTelemetry({
    at: merged.now(),
    event: 'compaction_triggered',
    runId: input.runId,
    projectId: run?.projectId ?? '',
    bytesAccumulated: bytesAtTrip,
  });
}

/**
 * Reset the byte counter without firing compaction. Called by the
 * controller on every regular (`done` / `failed` / `question` / heartbeat
 * / subagent) sentinel — those naturally compact context already.
 *
 * Does NOT clear `pendingCompaction`: if a regular sentinel arrives while
 * a compaction prompt is in flight, the pending flag stays set until
 * `handleCompactionDone` lands.
 */
export function resetBuilderBytes(runId: string): void {
  const entry = state.get(runId);
  if (!entry) return;
  entry.bytesSinceLastSentinel = 0;
}

export interface HandleCompactionDoneInput {
  runId: string;
  summary: string;
  worktreePath: string;
  deps?: Partial<CompactionDeps>;
}

/**
 * Handle `<<<TX_COMPACTION_DONE>>>` from the Builder. Appends the
 * `summary` to `<worktree>/.tx-builder-notes.md` under
 * `## Compaction summaries`, clears pending state, resets the counter.
 */
export async function handleCompactionDone(input: HandleCompactionDoneInput): Promise<void> {
  const merged: CompactionDeps = { ...defaultDeps(), ...input.deps };
  const path = joinPath(input.worktreePath, SCRATCHPAD_FILE);

  const existing = (await merged.readScratchpad(path)) ?? '';
  const next = appendCompactionSummary(existing, input.summary, merged.now());

  await merged.writeScratchpad(path, next);
  await merged.refreshMtime(path);

  // Reset state AFTER a successful write so a failed write retains the
  // pending flag and counter and can be retried (by the next sentinel).
  const entry = state.get(input.runId);
  if (entry) {
    entry.pendingCompaction = false;
    entry.bytesSinceLastSentinel = 0;
  }

  // Phase 3b.8: emit telemetry once the summary is durably appended to
  // the scratchpad. `summaryLength` lets us monitor whether Builder
  // honors the ≤500-token cap from the prompt (a sustained drift up
  // means the prompt template needs tightening).
  const run = usePipelineStore.getState().runs[input.runId];
  emitTelemetry({
    at: merged.now(),
    event: 'compaction_completed',
    runId: input.runId,
    projectId: run?.projectId ?? '',
    summaryLength: input.summary.length,
  });
}

/** Wipe per-run state. Call on terminal state (via `clearRunBuffers`). */
export function clearCompactionState(runId: string): void {
  state.delete(runId);
}

/** Test helper — reset module state between vitest cases. */
export function resetCompactionStateForTest(): void {
  state.clear();
}

/** Test introspection — current bytes counter for a run. */
export function _getBytesForTest(runId: string): number {
  return state.get(runId)?.bytesSinceLastSentinel ?? 0;
}

/** Test introspection — pending flag. */
export function _isPendingForTest(runId: string): boolean {
  return state.get(runId)?.pendingCompaction ?? false;
}

/**
 * Build the new scratchpad content by appending `summary` under the
 * `## Compaction summaries` section. If the section is missing, append
 * it at the end. If the file is empty, seed it with a header.
 */
function appendCompactionSummary(existing: string, summary: string, atMs: number): string {
  const ts = new Date(atMs).toISOString();
  const entry = `\n### ${ts}\n\n${summary.trim()}\n`;

  if (existing.length === 0) {
    return `# Builder scratchpad\n\n${COMPACTION_SECTION_HEADER}\n${entry}`;
  }

  const sectionIdx = existing.indexOf(COMPACTION_SECTION_HEADER);
  if (sectionIdx === -1) {
    // Append section at end. Make sure we have a trailing newline before
    // the section header so we don't glue onto an existing line.
    const sep = existing.endsWith('\n') ? '' : '\n';
    return `${existing}${sep}\n${COMPACTION_SECTION_HEADER}\n${entry}`;
  }

  // Insert the new entry at the END of the file — every compaction is
  // appended chronologically. Splitting around the header would also work
  // but appending preserves any subsequent sections the Builder may have
  // added below (rare, but the skill doesn't forbid it).
  const sep = existing.endsWith('\n') ? '' : '\n';
  return `${existing}${sep}${entry}`;
}

/**
 * Path join that handles both POSIX and Windows worktree paths. Mirrors
 * the helper in `scratchpad-watcher.ts` — kept private to each module so
 * neither has to import the other's internals.
 */
function joinPath(base: string, child: string): string {
  if (base.length === 0) return child;
  const last = base[base.length - 1];
  if (last === '/' || last === '\\') return base + child;
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base + sep + child;
}
