import { usePipelineStore } from '@/stores/pipelineStore';
import { scanForSentinel } from './sentinel-scanner';
import type {
  PipelineRole,
  PlanArtifact,
  BuildArtifact,
  ReviewVerdict,
  QuestionArtifact,
} from '@/types';

const ptyBuffers = new Map<string, string>();
const MAX_BUFFER = 64 * 1024;

type Dispatch = ReturnType<typeof usePipelineStore.getState>['dispatch'];

interface IngestRequest {
  runId: string;
  role: PipelineRole;
  raw: string;
  /** Streaming source (PTY chunks) buffers across calls; one-shot doesn't. */
  source: 'pty' | 'oneshot';
  /** One-shot only: process exit code. Used to synthesize failure when no sentinel found. */
  exitCode?: number | null;
}

/**
 * Single ingestion path for both streaming PTY chunks and one-shot stdout.
 * For PTY, accumulates a per-(run, role) buffer across calls; for one-shot,
 * scans the full stdout once and synthesizes a failure transition if no
 * sentinel is found and the process exited nonzero.
 */
export function ingest(input: IngestRequest): void {
  const dispatch = usePipelineStore.getState().dispatch;
  const key = `${input.runId}:${input.role}`;

  if (input.source === 'pty') {
    let buf = (ptyBuffers.get(key) ?? '') + input.raw;
    while (true) {
      const event = scanForSentinel(buf);
      if (event === null) break;
      dispatchSentinel(input.runId, input.role, event, dispatch);
      buf = buf.slice(event.consumedThrough);
    }
    if (buf.length > MAX_BUFFER) buf = buf.slice(buf.length - MAX_BUFFER);
    ptyBuffers.set(key, buf);
    return;
  }

  // One-shot: scan once; synthesize failure if no sentinel + nonzero exit.
  const event = scanForSentinel(input.raw);
  if (event !== null) {
    dispatchSentinel(input.runId, input.role, event, dispatch);
    return;
  }
  if (input.exitCode !== 0 && input.exitCode !== undefined && input.exitCode !== null) {
    if (input.role === 'planner') {
      dispatch(input.runId, {
        type: 'planner_failed',
        reason: `agent exited ${input.exitCode} without sentinel; stdout: ${input.raw.slice(0, 500)}`,
      });
    } else {
      dispatch(input.runId, {
        type: 'abort',
        reason: `${input.role} exited ${input.exitCode} without sentinel`,
      });
    }
  }
}

/** Convenience wrapper: ingest a streaming PTY chunk. */
export function ingestPtyChunk(input: { runId: string; role: PipelineRole; chunk: string }): void {
  ingest({ runId: input.runId, role: input.role, raw: input.chunk, source: 'pty' });
}

/** Convenience wrapper: ingest a one-shot agent result. */
export function ingestOneshotResult(input: {
  runId: string;
  role: PipelineRole;
  stdout: string;
  exitCode: number | null;
}): void {
  ingest({
    runId: input.runId,
    role: input.role,
    raw: input.stdout,
    source: 'oneshot',
    exitCode: input.exitCode,
  });
}

function dispatchSentinel(
  runId: string,
  role: PipelineRole,
  ev: ReturnType<typeof scanForSentinel> & object,
  dispatch: Dispatch,
): void {
  switch (ev.kind) {
    case 'done': {
      const payload = ev.payload as PlanArtifact | BuildArtifact | ReviewVerdict;
      if (payload.stage === 'planner' && role === 'planner') {
        // Guard the unchecked JSON cast: planLineage depends on a real SHA.
        // Missing/empty planCommitSha would silently append `undefined` and
        // mask a planner that forgot to commit before emitting DONE.
        const plan = payload as PlanArtifact;
        if (typeof plan.planCommitSha !== 'string' || plan.planCommitSha.length === 0) {
          dispatch(runId, {
            type: 'planner_failed',
            reason: 'planner sentinel missing planCommitSha — must commit before emitting DONE',
          });
          return;
        }
        dispatch(runId, { type: 'planner_done', plan });
        return;
      }
      if (payload.stage === 'builder' && role === 'builder') {
        dispatch(runId, { type: 'builder_done', build: payload as BuildArtifact });
        return;
      }
      if (payload.stage === 'reviewer' && (role === 'reviewer' || role === 'reviewer-codex')) {
        dispatch(runId, { type: 'reviewer_done', verdict: payload as ReviewVerdict });
        return;
      }
      // Role/stage mismatch — hallucinating LLM. Abort so the run doesn't hang.
      const reason = `role/stage mismatch: ${role} emitted ${payload.stage}`;
      dispatch(runId, role === 'planner'
        ? { type: 'planner_failed', reason }
        : { type: 'abort', reason });
      return;
    }
    case 'failed':
      dispatch(runId, role === 'planner'
        ? { type: 'planner_failed', reason: ev.payload.reason }
        : { type: 'abort', reason: `${role}: ${ev.payload.reason}` });
      return;
    case 'question':
      dispatch(runId, { type: 'question_raised', question: ev.payload as QuestionArtifact });
      return;
    case 'heartbeat':
      return;
    case 'parse_error':
      dispatch(runId, role === 'planner'
        ? { type: 'planner_failed', reason: `malformed sentinel: ${ev.error}` }
        : { type: 'abort', reason: `malformed sentinel from ${role}: ${ev.error}` });
      return;
  }
}

/** Purge accumulator buffers for a run (call on terminal state to bound memory). */
export function clearRunBuffers(runId: string): void {
  for (const key of ptyBuffers.keys()) {
    if (key.startsWith(`${runId}:`)) ptyBuffers.delete(key);
  }
}

/** Test helper — reset all internal buffers between vitest cases. */
export function resetIngestionBuffersForTest(): void {
  ptyBuffers.clear();
}

/** @deprecated use `resetIngestionBuffersForTest`. */
export const _resetForTest = resetIngestionBuffersForTest;
