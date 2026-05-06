import { usePipelineStore } from '@/stores/pipelineStore';
import { scanForSentinel, type SentinelEvent } from './sentinel-scanner';
import type { PipelineRole, PlanArtifact, BuildArtifact, ReviewVerdict, QuestionArtifact } from '@/types';

const ptyBuffers = new Map<string, string>();
const MAX_BUFFER = 64 * 1024;

interface PtyChunkInput {
  runId: string;
  role: PipelineRole;
  chunk: string;
}

interface OneshotInput {
  runId: string;
  role: PipelineRole;
  stdout: string;
  exitCode: number | null;
}

/**
 * Public entry: feed a PTY output chunk for a run+role.
 * Accumulates and dispatches on complete sentinels.
 */
export function ingestPtyChunk(input: PtyChunkInput): void {
  const key = `${input.runId}:${input.role}`;
  let buf = (ptyBuffers.get(key) ?? '') + input.chunk;

  while (true) {
    const event = scanForSentinel(buf);
    if (event === null) break;
    dispatchSentinel(input.runId, input.role, event);
    buf = buf.slice(event.consumedThrough);
  }

  if (buf.length > MAX_BUFFER) {
    buf = buf.slice(buf.length - MAX_BUFFER);
  }
  ptyBuffers.set(key, buf);
}

/**
 * Public entry: feed a one-shot agent result. The full stdout is passed
 * once; we scan it for the terminal sentinel. If none is found and the
 * exit code is non-zero, we synthesize a `planner_failed`-style transition.
 */
export function ingestOneshotResult(input: OneshotInput): void {
  const event = scanForSentinel(input.stdout);
  if (event !== null) {
    dispatchSentinel(input.runId, input.role, event);
    return;
  }

  if (input.exitCode !== 0) {
    const dispatch = usePipelineStore.getState().dispatch;
    if (input.role === 'planner') {
      dispatch(input.runId, {
        type: 'planner_failed',
        reason: `agent exited ${input.exitCode} without sentinel; stdout: ${input.stdout.slice(0, 500)}`,
      });
    } else {
      dispatch(input.runId, {
        type: 'abort',
        reason: `${input.role} exited ${input.exitCode} without sentinel`,
      });
    }
  }
}

function dispatchSentinel(runId: string, role: PipelineRole, ev: SentinelEvent): void {
  const dispatch = usePipelineStore.getState().dispatch;

  switch (ev.kind) {
    case 'done':
      dispatchDone(runId, role, ev.payload, dispatch);
      break;
    case 'failed':
      if (role === 'planner') {
        dispatch(runId, { type: 'planner_failed', reason: ev.payload.reason });
      } else {
        dispatch(runId, { type: 'abort', reason: `${role}: ${ev.payload.reason}` });
      }
      break;
    case 'question':
      dispatch(runId, { type: 'question_raised', question: ev.payload as QuestionArtifact });
      break;
    case 'heartbeat':
      break;
    case 'parse_error':
      if (role === 'planner') {
        dispatch(runId, { type: 'planner_failed', reason: `malformed sentinel: ${ev.error}` });
      } else {
        dispatch(runId, { type: 'abort', reason: `malformed sentinel from ${role}: ${ev.error}` });
      }
      break;
  }
}

function dispatchDone(
  runId: string,
  role: PipelineRole,
  payload: PlanArtifact | BuildArtifact | ReviewVerdict,
  dispatch: ReturnType<typeof usePipelineStore.getState>['dispatch'],
): void {
  if (payload.stage === 'planner' && role === 'planner') {
    dispatch(runId, { type: 'planner_done', plan: payload as PlanArtifact });
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

  // Role/stage mismatch — a hallucinating LLM emitted an artifact for the
  // wrong stage. Abort instead of silently ignoring; otherwise the run
  // hangs forever waiting for a sentinel that will never arrive correctly.
  const reason = `role/stage mismatch: ${role} emitted ${payload.stage}`;
  if (role === 'planner') {
    dispatch(runId, { type: 'planner_failed', reason });
  } else {
    dispatch(runId, { type: 'abort', reason });
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
