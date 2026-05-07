import { usePipelineStore, emitTelemetry } from '@/stores/pipelineStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { scanForSentinel } from './sentinel-scanner';
import { notifyBuilderActivity, clearScratchpadState } from './scratchpad-watcher';
import {
  notifyBuilderBytes,
  resetBuilderBytes,
  handleCompactionDone,
  clearCompactionState,
} from './compaction-watcher';
import type {
  PipelineRole,
  PlanArtifact,
  BuildArtifact,
  ReviewVerdict,
  QuestionArtifact,
  RedTeamReport,
  Tile,
  AgentTile,
} from '@/types';

const ptyBuffers = new Map<string, string>();
const MAX_BUFFER = 64 * 1024;

/**
 * Wall-clock timestamp of the most-recent stdout chunk per run (PTY or
 * one-shot). The stuck-detector reads this to decide whether a run has gone
 * silent vs. is happily streaming output without sentinels. Cleared on
 * terminal state via `clearRunBuffers` to bound memory.
 */
const lastStdoutAt = new Map<string, number>();

/** Read the last-stdout timestamp recorded by `ingest`. Undefined if none yet. */
export function getLastStdoutAt(runId: string): number | undefined {
  return lastStdoutAt.get(runId);
}

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

  // Liveness: any stdout (sentinel-bearing or not) counts as the run being
  // alive. The stuck-detector uses this to decide when to probe / abort.
  if (input.raw.length > 0) {
    lastStdoutAt.set(input.runId, Date.now());
  }

  if (input.source === 'pty') {
    // Phase 3b.6: track Builder bytes-since-last-sentinel and trip a
    // compaction prompt when the threshold is crossed. Done BEFORE the
    // scanner loop so a chunk that crosses the threshold while *also*
    // delivering a sentinel still gets the prompt queued — the sentinel
    // dispatch resets the counter immediately after.
    if (input.role === 'builder' && input.raw.length > 0) {
      maybeNotifyBuilderBytes(input.runId, input.raw.length);
    }

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

/**
 * Phase 3b.2: every Builder sentinel/heartbeat triggers a scratchpad
 * mtime check. Fire-and-forget — the watcher is async (IPC) but the
 * dispatch path is sync; we don't want to block sentinel processing on
 * a filesystem stat. Errors are swallowed inside the watcher itself.
 */
function maybeNotifyBuilder(runId: string, role: PipelineRole): void {
  if (role !== 'builder') return;
  const run = usePipelineStore.getState().runs[runId];
  if (!run || !run.worktreePath) return;
  void notifyBuilderActivity({ runId, role, worktreePath: run.worktreePath });
}

/**
 * Resolve the Builder PTY id by walking the canvas-store tiles for the
 * run. Mirrors `findActiveRolePtyId` in `App.tsx` but role-locked to
 * builder. Returns `undefined` while the Builder tile hasn't spawned
 * (e.g. between `approve_plan` and the first chunk arriving) — callers
 * should skip the compaction prompt in that case.
 */
function findBuilderPtyId(runId: string): string | undefined {
  const run = usePipelineStore.getState().runs[runId];
  if (!run) return undefined;
  const tileId = run.tiles.builder;
  if (!tileId) return undefined;
  const projectTiles = useCanvasStore.getState().tiles;
  for (const list of Object.values(projectTiles)) {
    const arr = list as Tile[] | undefined;
    if (!arr) continue;
    const found = arr.find(t => t.id === tileId);
    if (found && found.type === 'agent') return (found as AgentTile).ptyId;
  }
  return undefined;
}

/**
 * Phase 3b.6: feed cumulative Builder PTY bytes to the compaction
 * watcher. Fire-and-forget; errors are logged inside the watcher.
 * Skips when the Builder PTY hasn't been resolved yet — no prompt to
 * fire against. Test-only injection happens through
 * `compaction-watcher.notifyBuilderBytes` directly via vi.spyOn.
 */
function maybeNotifyBuilderBytes(runId: string, byteCount: number): void {
  const run = usePipelineStore.getState().runs[runId];
  if (!run || !run.worktreePath) return;
  const ptyId = findBuilderPtyId(runId);
  if (!ptyId) return;
  void notifyBuilderBytes({ runId, ptyId, worktreePath: run.worktreePath, byteCount });
}

/**
 * Phase 3c.2: every DONE sentinel must carry one of the three confidence
 * values. We reject missing/invalid values defensively — `verified` while
 * wrong is the worst possible signal, but missing-altogether means the
 * role-prompt wasn't followed at all and the run is in untrusted territory.
 */
function isValidConfidence(c: unknown): c is 'verified' | 'likely' | 'uncertain' {
  return c === 'verified' || c === 'likely' || c === 'uncertain';
}

function missingConfidenceReason(role: PipelineRole): string {
  return (
    `${role} DONE sentinel missing required \`confidence\` field ` +
    `(expected one of: verified | likely | uncertain)`
  );
}

/**
 * Phase 3c.3: when a role's DONE sentinel reports `confidence: 'uncertain'`
 * AND the diff is non-trivial, dispatch a synthetic `question_raised` so the
 * user is forced to acknowledge before the run advances further.
 *
 * Non-trivial thresholds (lifted directly from spec 3c.3):
 *  - Planner: ≥3 plan tasks
 *  - Builder: ≥5 filesChanged OR ≥3 commits
 *  - Reviewer: same diff metrics as Builder, taken from the latest build
 *    (the reviewer has no diff of its own)
 *
 * Firing order — this runs AFTER the role's normal `*_done` dispatch. So
 * for Builder, the reducer has already moved building → reviewing; the
 * synthetic question then transitions reviewing → awaiting_clarification
 * with `priorActiveState: 'reviewing'`. When the user answers, the run
 * resumes back into `reviewing`, where the Reviewer one-shot fires
 * normally. (Resuming into the role we just left would be wrong — we want
 * forward progress.) See controller-runtime.test.ts for the asserted flow.
 *
 * The synthetic question counts against the same 3-question budget enforced
 * by the question-budget guard elsewhere; four uncertain non-trivial
 * stages in a row will tip the run over the budget cap and abort.
 */
function maybeEscalateUncertainty(
  runId: string,
  role: PipelineRole,
  payload: PlanArtifact | BuildArtifact | ReviewVerdict,
  dispatch: Dispatch,
): void {
  if (payload.confidence !== 'uncertain') return;

  const run = usePipelineStore.getState().runs[runId];
  if (!run) return;
  // Don't fire from terminal states — `*_done` may have transitioned the
  // run to `failed` (e.g. budget exceeded). The reducer would reject the
  // synthetic question_raised but we'd burn a question slot for nothing.
  if (run.state === 'failed' || run.state === 'done' || run.state === 'escalated') return;

  let isNonTrivial = false;
  if (role === 'planner') {
    const tasks = (payload as PlanArtifact).tasks;
    isNonTrivial = Array.isArray(tasks) && tasks.length >= 3;
  } else if (role === 'builder') {
    const build = payload as BuildArtifact;
    isNonTrivial = (build.filesChanged?.length ?? 0) >= 5 || (build.commits?.length ?? 0) >= 3;
  } else if (role === 'reviewer' || role === 'reviewer-codex') {
    // Reviewer has no diff of its own — reach for the latest build's metrics.
    const last = run.artifacts.builds[run.artifacts.builds.length - 1];
    isNonTrivial = (last?.filesChanged?.length ?? 0) >= 5 || (last?.commits?.length ?? 0) >= 3;
  }

  if (!isNonTrivial) return;

  const drivers = (payload as { uncertaintyDrivers?: string[] }).uncertaintyDrivers;
  const driverList =
    Array.isArray(drivers) && drivers.length > 0 ? drivers.join('; ') : '(none specified)';

  dispatch(runId, {
    type: 'question_raised',
    question: {
      stage: role,
      question:
        'Stage emitted uncertain confidence with non-trivial diff. ' +
        'Confirm proceeding to next stage, or request a re-run.',
      context: `confidence: uncertain | uncertaintyDrivers: ${driverList}`,
      blocking: true,
    },
  });

  // Phase 3c.7: trust telemetry — record the escalation with the diff
  // metrics that triggered it. Pull from the same payload we just used,
  // plus the latest build for reviewer roles. Drivers are surfaced
  // verbatim so dashboards can group by the agent's stated reasons.
  let filesChanged: number | undefined;
  let commits: number | undefined;
  let tasks: number | undefined;
  if (role === 'planner') {
    tasks = (payload as PlanArtifact).tasks?.length;
  } else if (role === 'builder') {
    const build = payload as BuildArtifact;
    filesChanged = build.filesChanged?.length ?? 0;
    commits = build.commits?.length ?? 0;
  } else if (role === 'reviewer' || role === 'reviewer-codex') {
    const last = run.artifacts.builds[run.artifacts.builds.length - 1];
    filesChanged = last?.filesChanged?.length ?? 0;
    commits = last?.commits?.length ?? 0;
  }
  emitTelemetry({
    at: Date.now(),
    event: 'confidence_uncertain_escalated',
    runId,
    projectId: run.projectId,
    role,
    filesChanged,
    commits,
    tasks,
    uncertaintyDrivers: Array.isArray(drivers) ? drivers : undefined,
  });
}

function dispatchSentinel(
  runId: string,
  role: PipelineRole,
  ev: ReturnType<typeof scanForSentinel> & object,
  dispatch: Dispatch,
): void {
  // Builder activity (any sentinel kind, including heartbeat) → kick
  // the scratchpad-watcher. Done before the dispatch so the watcher
  // sees the run *before* a terminal-state transition might tear it down.
  maybeNotifyBuilder(runId, role);

  // Phase 3b.6: every regular Builder sentinel resets the
  // bytes-since-last-sentinel counter. The compaction-done sentinel
  // also resets, but via `handleCompactionDone` which clears pending too.
  if (role === 'builder' && ev.kind !== 'compaction_done') {
    resetBuilderBytes(runId);
  }

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
        if (!isValidConfidence(plan.confidence)) {
          dispatch(runId, {
            type: 'planner_failed',
            reason: missingConfidenceReason('planner'),
          });
          return;
        }
        dispatch(runId, { type: 'planner_done', plan });
        maybeEscalateUncertainty(runId, role, plan, dispatch);
        return;
      }
      if (payload.stage === 'builder' && role === 'builder') {
        const build = payload as BuildArtifact;
        if (!isValidConfidence(build.confidence)) {
          dispatch(runId, { type: 'abort', reason: missingConfidenceReason('builder') });
          return;
        }
        dispatch(runId, { type: 'builder_done', build });
        maybeEscalateUncertainty(runId, role, build, dispatch);
        return;
      }
      if (payload.stage === 'reviewer' && (role === 'reviewer' || role === 'reviewer-codex')) {
        const verdict = payload as ReviewVerdict;
        if (!isValidConfidence(verdict.confidence)) {
          dispatch(runId, { type: 'abort', reason: missingConfidenceReason(role) });
          return;
        }
        dispatch(runId, { type: 'reviewer_done', verdict });
        maybeEscalateUncertainty(runId, role, verdict, dispatch);
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
      dispatch(runId, { type: 'heartbeat' });
      return;
    case 'subagent_done': {
      // Sub-agent invocations live *within* a Builder task — they don't
      // transition pipeline state. Phase 3b.8: emit a `subagent_completed`
      // telemetry event so the JSONL run log captures the sub-agent
      // boundary. Builder activity bookkeeping above (`maybeNotifyBuilder`)
      // already kicked the scratchpad-watcher.
      //
      // We don't ship `subagent_invoked` — the Builder calls
      // `agent_run_oneshot` in-process so the controller never sees
      // invocation. Phase 4 may add a Builder-emitted sentinel if we
      // want latency tracking.
      const run = usePipelineStore.getState().runs[runId];
      emitTelemetry({
        at: Date.now(),
        event: 'subagent_completed',
        runId,
        projectId: run?.projectId ?? '',
        parentRole: role,
        status: 'done',
        filesEditedCount: ev.payload.filesEdited.length,
        commitsCreatedCount: ev.payload.commitsCreated.length,
        summary: ev.payload.summary,
      });
      return;
    }
    case 'subagent_failed': {
      const run = usePipelineStore.getState().runs[runId];
      emitTelemetry({
        at: Date.now(),
        event: 'subagent_completed',
        runId,
        projectId: run?.projectId ?? '',
        parentRole: role,
        status: 'failed',
        reason: ev.payload.reason,
      });
      return;
    }
    case 'compaction_done': {
      // Builder responded to the compaction prompt. Append the summary
      // to the scratchpad and reset compaction bookkeeping. Fire-and-
      // forget — the file-write IPC is async but a slow disk shouldn't
      // block the sentinel-loop. Errors surface via console.warn from
      // inside the handler. The `compaction_completed` telemetry event
      // (Phase 3b.8) is emitted by `handleCompactionDone` itself so it
      // lands AFTER the scratchpad write succeeds.
      const run = usePipelineStore.getState().runs[runId];
      if (run && run.worktreePath) {
        void handleCompactionDone({
          runId,
          summary: ev.payload.summary,
          worktreePath: run.worktreePath,
        });
      }
      return;
    }
    case 'redteam_done': {
      // Phase 3c.6: red-team one-shot finished. Validate the payload shape
      // before handing it to the reducer — a bad sentinel from the role
      // shouldn't hang the run. Required fields: stage, findings (array),
      // summary (string), confidence.
      const report = ev.payload as Partial<RedTeamReport>;
      if (
        report.stage !== 'red-team' ||
        !Array.isArray(report.findings) ||
        typeof report.summary !== 'string' ||
        !isValidConfidence(report.confidence)
      ) {
        dispatch(runId, {
          type: 'abort',
          reason: `${role} red-team sentinel malformed (missing stage/findings/summary/confidence)`,
        });
        return;
      }
      // Phase 3c.7: emit one `red_team_finding` per finding so dashboards
      // can aggregate by severity/category without re-parsing the report.
      // Empty `findings` array → no events (the absence of findings is
      // visible via the `state_change` to awaiting_merge_approval). We
      // emit BEFORE dispatch so the findings show up even if the reducer
      // routes the run to `failed` (a blocker finding) — the events
      // describe the *findings*, not the resulting state.
      const validatedReport = ev.payload as RedTeamReport;
      const runForRedteam = usePipelineStore.getState().runs[runId];
      const projectId = runForRedteam?.projectId ?? '';
      for (const finding of validatedReport.findings) {
        emitTelemetry({
          at: Date.now(),
          event: 'red_team_finding',
          runId,
          projectId,
          severity: finding.severity,
          category: finding.category,
          file: finding.file,
          line: finding.line,
        });
      }
      dispatch(runId, { type: 'red_team_done', report: validatedReport });
      return;
    }
    case 'redteam_failed':
      dispatch(runId, { type: 'red_team_failed', reason: `${role}: ${ev.payload.reason}` });
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
  lastStdoutAt.delete(runId);
  // Phase 3b.2: drop scratchpad bookkeeping alongside other per-run state.
  clearScratchpadState(runId);
  // Phase 3b.6: drop compaction bookkeeping (counter + pending flag).
  clearCompactionState(runId);
}

/** Test helper — reset all internal buffers between vitest cases. */
export function resetIngestionBuffersForTest(): void {
  ptyBuffers.clear();
  lastStdoutAt.clear();
}

/** @deprecated use `resetIngestionBuffersForTest`. */
export const _resetForTest = resetIngestionBuffersForTest;
