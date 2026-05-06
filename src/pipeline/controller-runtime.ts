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
      // No-op for Phase 2b. Phase 2c uses for stuck detection.
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
  } else if (payload.stage === 'builder' && role === 'builder') {
    dispatch(runId, { type: 'builder_done', build: payload as BuildArtifact });
  } else if (payload.stage === 'reviewer' && (role === 'reviewer' || role === 'reviewer-codex')) {
    dispatch(runId, { type: 'reviewer_done', verdict: payload as ReviewVerdict });
  }
  // Mismatch silently ignored — Phase 2c may add a parse_error toast.
}

/** Test helper — reset internal buffers between vitest cases. */
export function _resetForTest(): void {
  ptyBuffers.clear();
}
