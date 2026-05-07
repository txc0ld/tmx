/**
 * Phase 3b end-to-end smoke test.
 *
 * Sister to `phase2c-{i,ii,iii}-smoke.test.tsx` and `phase3a-smoke.test.tsx`.
 * Phase 3b shipped:
 *   - 3b.1: tx-pipeline-builder-scratchpad skill
 *   - 3b.2: scratchpad-watcher (10min stagnation → synthetic clarification)
 *   - 3b.3: tx-pipeline-subagent skill
 *   - 3b.4: agent_run_oneshot system_prompt + working_files (Rust)
 *   - 3b.5: TX_SUBAGENT_DONE / TX_SUBAGENT_FAILED sentinels
 *   - 3b.6: compaction-watcher (200KB threshold)
 *   - 3b.7: INVARIANTS.md grounding (placeholder substitution)
 *   - 3b.8: subagent_completed / compaction_triggered / compaction_completed
 *           telemetry events
 *
 * Mocks the IPC boundary only — everything else (reducer, scratchpad-watcher,
 * compaction-watcher, controller-runtime, role-prompt-injection) runs real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// IPC mock — spread real module, override the surface the watchers + role
// prompt injection touch. Match the pattern in phase3a-smoke.
vi.mock('@/utils/ipc', async (importActual) => {
  const real = await importActual<typeof import('@/utils/ipc')>();
  return {
    ...real,
    ptyWrite: vi.fn().mockResolvedValue(undefined),
    readFileText: vi.fn().mockResolvedValue(''),
    writeFileText: vi.fn().mockResolvedValue(undefined),
    readFileMtime: vi.fn().mockResolvedValue(null),
    pipelineReadRolePrompt: vi.fn().mockResolvedValue(null),
    onPtyOutput: vi.fn().mockResolvedValue(() => {}),
    pipelineTelemetryLog: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  ptyWrite,
  readFileText,
  writeFileText,
  readFileMtime,
} from '@/utils/ipc';
import { usePipelineStore, setPipelineTelemetryEmitter, type TelemetryEvent } from '@/stores/pipelineStore';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  ingestPtyChunk,
  clearRunBuffers,
  resetIngestionBuffersForTest,
} from './controller-runtime';
import {
  resetScratchpadStateForTest,
  STAGNATION_THRESHOLD_MS,
  SCRATCHPAD_FILE,
} from './scratchpad-watcher';
import {
  resetCompactionStateForTest,
  COMPACTION_THRESHOLD_BYTES,
  COMPACTION_PROMPT,
  COMPACTION_SECTION_HEADER,
  _isPendingForTest,
} from './compaction-watcher';
import { substituteInvariants } from './role-prompt-injection';
import type {
  PipelineRun,
  RunFingerprint,
  AgentTile,
  PipelineState,
} from '@/types';

const ptyWriteMock = ptyWrite as unknown as ReturnType<typeof vi.fn>;
const readFileTextMock = readFileText as unknown as ReturnType<typeof vi.fn>;
const writeFileTextMock = writeFileText as unknown as ReturnType<typeof vi.fn>;
const readFileMtimeMock = readFileMtime as unknown as ReturnType<typeof vi.fn>;

const PROJECT_ID = 'proj-3b';
const RUN_ID = 'run-3b';
const WORKTREE = '/tmp/wt-3b';
const BUILDER_TILE_ID = 'tile-builder-3b';
const BUILDER_PTY_ID = 'pty-builder-3b';

const FP: RunFingerprint = {
  templateId: 't',
  templateHash: 'h',
  skillHashes: {},
  rolePromptHashes: {},
  models: {},
  capabilityManifests: {},
  terminalxVersion: '0.1.0',
};

function makeRun(state: PipelineState = 'building', overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: RUN_ID,
    templateId: 'tmpl-3b',
    projectId: PROJECT_ID,
    worktreePath: WORKTREE,
    branch: 'feat/3b',
    baseBranch: 'main',
    state,
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: Date.now(),
    escalationLog: [],
    tiles: { builder: BUILDER_TILE_ID },
    fingerprint: FP,
    planLineage: [],
    ...overrides,
  };
}

function seedRun(run: PipelineRun = makeRun()): void {
  usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
}

/**
 * Seed a Builder agent tile in the canvas store so `findBuilderPtyId` (called
 * from `controller-runtime.maybeNotifyBuilderBytes`) can resolve a PTY id.
 * Without this, the compaction-watcher silently no-ops (correctly — there's
 * no Builder PTY to write a compaction prompt to).
 */
function seedBuilderTile(): void {
  const tile: AgentTile = {
    id: BUILDER_TILE_ID,
    type: 'agent',
    x: 0,
    y: 0,
    w: 600,
    h: 400,
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    mode: 'builder',
    version: '0.1.0',
    cwd: WORKTREE,
    branch: 'feat/3b',
    status: 'idle',
    ptyId: BUILDER_PTY_ID,
    elapsed: 0,
  };
  useCanvasStore.setState({
    tiles: { [PROJECT_ID]: [tile] },
    activeProject: PROJECT_ID,
  });
}

function clean(): void {
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  useCanvasStore.setState({ tiles: {}, activeProject: '' });
  resetIngestionBuffersForTest();
  resetScratchpadStateForTest();
  resetCompactionStateForTest();
  setPipelineTelemetryEmitter(null);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('Phase 3b smoke: scratchpad + compaction + sub-agent + invariants + telemetry', () => {
  beforeEach(() => {
    clean();
    ptyWriteMock.mockClear().mockResolvedValue(undefined);
    readFileTextMock.mockClear().mockResolvedValue('');
    writeFileTextMock.mockClear().mockResolvedValue(undefined);
    readFileMtimeMock.mockClear().mockResolvedValue(null);
  });

  afterEach(() => {
    clean();
  });

  // 1. Scratchpad-watcher: 10min stagnation → synthetic clarification.
  //    The watcher's defaultDeps reads via `readFileMtime` IPC and dispatches
  //    `question_raised` via the pipelineStore. We drive two builder
  //    sentinels through the real ingest path; the second arrives 10min+1ms
  //    after the first with a stuck mtime → the run flips to
  //    `awaiting_clarification` and a question artifact lands referencing
  //    the scratchpad file.
  it('scratchpad-watcher: 10min stagnation injects synthetic clarification mentioning the scratchpad', async () => {
    vi.useFakeTimers();
    try {
      seedRun(makeRun('building'));
      seedBuilderTile();

      // Stuck mtime — same value before and after the 10min gap.
      const STUCK_MTIME = 1_000;
      readFileMtimeMock.mockResolvedValue(STUCK_MTIME);

      vi.setSystemTime(new Date(2_000_000));

      // First Builder sentinel — seeds the watcher's bookkeeping.
      ingestPtyChunk({
        runId: RUN_ID,
        role: 'builder',
        chunk: '<<<TX_HEARTBEAT>>>{"progress":"task 1"}\n',
      });
      await flushMicrotasks();

      // 10 minutes + 1ms pass with NO scratchpad write.
      vi.setSystemTime(new Date(2_000_000 + STAGNATION_THRESHOLD_MS + 1));

      // Second sentinel — the watcher tracks `lastBuilderActivityAt` from
      // first activity (Date.now() inside notify). Since 10min has elapsed
      // and mtime hasn't moved, the watcher injects a synthetic clarification.
      ingestPtyChunk({
        runId: RUN_ID,
        role: 'builder',
        chunk: '<<<TX_HEARTBEAT>>>{"progress":"task 2"}\n',
      });
      await flushMicrotasks();

      const run = usePipelineStore.getState().runs[RUN_ID];
      expect(run.state).toBe('awaiting_clarification');
      expect(run.artifacts.questions).toHaveLength(1);
      const q = run.artifacts.questions[0];
      expect(q.stage).toBe('builder');
      expect(q.blocking).toBe(true);
      expect(q.question).toContain(SCRATCHPAD_FILE);

      // The watcher read mtime from the scratchpad file under the worktree.
      const observedPaths = readFileMtimeMock.mock.calls.map(c => c[0]);
      expect(observedPaths.some(p => p === `${WORKTREE}/${SCRATCHPAD_FILE}`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // 2. Compaction-watcher: ingesting >200KB of Builder chunks (without any
  //    sentinel that would reset the byte counter) trips the threshold and
  //    writes the compaction prompt to the Builder PTY.
  it('compaction-watcher: 200KB of Builder bytes writes compaction prompt to the PTY', async () => {
    seedRun(makeRun('building'));
    seedBuilderTile();

    // 4 chunks of 60KB each = 240KB cumulative > 200KB threshold.
    const FILLER = 'x'.repeat(60 * 1024);
    for (let i = 0; i < 4; i++) {
      ingestPtyChunk({ runId: RUN_ID, role: 'builder', chunk: FILLER });
      await flushMicrotasks();
    }

    // Compaction prompt landed on the Builder PTY exactly once.
    const compactionWrites = ptyWriteMock.mock.calls.filter(
      ([id, data]) => id === BUILDER_PTY_ID && typeof data === 'string' && data === COMPACTION_PROMPT,
    );
    expect(compactionWrites).toHaveLength(1);

    // Builder is in pendingCompaction — re-firing is debounced until
    // TX_COMPACTION_DONE lands.
    expect(_isPendingForTest(RUN_ID)).toBe(true);

    // State is unchanged — compaction is an in-stream control message,
    // not a state-machine event.
    expect(usePipelineStore.getState().runs[RUN_ID].state).toBe('building');
  });

  // 3. TX_COMPACTION_DONE sentinel: the controller appends the summary to
  //    `.tx-builder-notes.md` via the writeFileText IPC. We pre-trip the
  //    threshold so the pending flag is set, then ingest the sentinel.
  it('TX_COMPACTION_DONE: summary appended to scratchpad and compaction state cleared', async () => {
    seedRun(makeRun('building'));
    seedBuilderTile();

    // Existing scratchpad with some Builder notes.
    readFileTextMock.mockResolvedValue('# Builder scratchpad\n\nTask 1: doing X\n');

    // Trip the threshold first.
    const FILLER = 'x'.repeat(COMPACTION_THRESHOLD_BYTES + 1);
    ingestPtyChunk({ runId: RUN_ID, role: 'builder', chunk: FILLER });
    await flushMicrotasks();
    expect(_isPendingForTest(RUN_ID)).toBe(true);

    // Now ingest TX_COMPACTION_DONE.
    const summary = 'Wrapped tasks 1-3; on task 4 next.';
    ingestPtyChunk({
      runId: RUN_ID,
      role: 'builder',
      chunk: `<<<TX_COMPACTION_DONE>>>{"summary":${JSON.stringify(summary)}}\n`,
    });
    await flushMicrotasks();

    // writeFileText was called with the merged scratchpad contents.
    const writes = writeFileTextMock.mock.calls;
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const [path, contents] = writes[writes.length - 1];
    expect(path).toBe(`${WORKTREE}/${SCRATCHPAD_FILE}`);
    expect(contents).toContain(COMPACTION_SECTION_HEADER);
    expect(contents).toContain(summary);
    // Existing content preserved.
    expect(contents).toContain('Task 1: doing X');

    // Pending flag cleared so a future 200KB run can re-trigger.
    expect(_isPendingForTest(RUN_ID)).toBe(false);

    // State still building — TX_COMPACTION_DONE is not a state transition.
    expect(usePipelineStore.getState().runs[RUN_ID].state).toBe('building');
  });

  // 4. Sub-agent sentinel: TX_SUBAGENT_DONE emits subagent_completed
  //    telemetry but does NOT transition the state machine. (Sub-agents
  //    operate within a Builder task — Builder calls agent_run_oneshot
  //    in-process; the controller never sees invocation, only completion.)
  it('TX_SUBAGENT_DONE: emits subagent_completed telemetry without state change', async () => {
    seedRun(makeRun('building'));

    const captured: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));

    const payload = {
      filesEdited: ['src/foo.ts', 'src/bar.ts'],
      commitsCreated: ['abc123'],
      summary: 'fixed retry logic',
    };
    ingestPtyChunk({
      runId: RUN_ID,
      role: 'builder',
      chunk: `<<<TX_SUBAGENT_DONE>>>${JSON.stringify(payload)}\n`,
    });
    await flushMicrotasks();

    const sub = captured.find(e => e.event === 'subagent_completed');
    expect(sub).toBeDefined();
    expect(sub).toMatchObject({
      event: 'subagent_completed',
      runId: RUN_ID,
      projectId: PROJECT_ID,
      parentRole: 'builder',
      status: 'done',
      filesEditedCount: 2,
      commitsCreatedCount: 1,
      summary: 'fixed retry logic',
    });

    // No state transition.
    expect(usePipelineStore.getState().runs[RUN_ID].state).toBe('building');
    // No state_change telemetry either.
    expect(captured.find(e => e.event === 'state_change')).toBeUndefined();
  });

  // 5. INVARIANTS.md substitution — pure-function path. The placeholder is
  //    replaced inline before the prompt is written to the PTY. The
  //    role-prompt-injection.test.ts already covers the IPC-bound path; the
  //    smoke confirms the substitution function preserves surrounding text
  //    and replaces every occurrence (defensive against future prompt
  //    revisions that reference the placeholder more than once).
  it('INVARIANTS.md substitution: rule text replaces every {INVARIANTS_PLACEHOLDER}', () => {
    const prompt = [
      '# Builder role',
      '',
      'Project invariants:',
      '`{INVARIANTS_PLACEHOLDER}`',
      '',
      'Reminder: `{INVARIANTS_PLACEHOLDER}`',
    ].join('\n');
    const invariants = 'never delete migrations; never bypass repositories/';

    const out = substituteInvariants(prompt, invariants);

    expect(out).toContain(invariants);
    expect(out).not.toContain('{INVARIANTS_PLACEHOLDER}');
    // Both occurrences replaced.
    const occurrences = out.split(invariants).length - 1;
    expect(occurrences).toBe(2);
    // Surrounding text preserved.
    expect(out.startsWith('# Builder role')).toBe(true);
    expect(out).toContain('Reminder:');
  });

  // 6. End-to-end compaction cycle: bytes accumulated → compaction_triggered
  //    fires → handler appends summary → compaction_completed fires. Both
  //    telemetry events surface with the right shape.
  it('compaction lifecycle: emits both compaction_triggered and compaction_completed telemetry', async () => {
    seedRun(makeRun('building'));
    seedBuilderTile();

    const captured: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));

    readFileTextMock.mockResolvedValue('');

    // Step 1: trip threshold via PTY chunks.
    const FILLER = 'x'.repeat(COMPACTION_THRESHOLD_BYTES + 1);
    ingestPtyChunk({ runId: RUN_ID, role: 'builder', chunk: FILLER });
    await flushMicrotasks();

    const trig = captured.find(e => e.event === 'compaction_triggered');
    expect(trig).toBeDefined();
    expect(trig).toMatchObject({
      event: 'compaction_triggered',
      runId: RUN_ID,
      projectId: PROJECT_ID,
    });
    expect((trig as { bytesAccumulated: number }).bytesAccumulated)
      .toBeGreaterThanOrEqual(COMPACTION_THRESHOLD_BYTES);

    // Step 2: Builder responds with summary.
    const summary = 'Phase 1 complete; starting phase 2.';
    ingestPtyChunk({
      runId: RUN_ID,
      role: 'builder',
      chunk: `<<<TX_COMPACTION_DONE>>>{"summary":${JSON.stringify(summary)}}\n`,
    });
    await flushMicrotasks();

    const done = captured.find(e => e.event === 'compaction_completed');
    expect(done).toBeDefined();
    expect(done).toMatchObject({
      event: 'compaction_completed',
      runId: RUN_ID,
      projectId: PROJECT_ID,
      summaryLength: summary.length,
    });

    // Order: trigger before completed.
    const trigIdx = captured.findIndex(e => e.event === 'compaction_triggered');
    const doneIdx = captured.findIndex(e => e.event === 'compaction_completed');
    expect(trigIdx).toBeLessThan(doneIdx);
  });

  // 7. Buffer + watcher cleanup on terminal state — clearRunBuffers wipes
  //    scratchpad + compaction state. Defensive sanity for the lifecycle
  //    integration that App.tsx wires up.
  it('clearRunBuffers wipes scratchpad + compaction watcher state', async () => {
    seedRun(makeRun('building'));
    seedBuilderTile();

    // Trip compaction so there's pending state to clear.
    const FILLER = 'x'.repeat(COMPACTION_THRESHOLD_BYTES + 1);
    ingestPtyChunk({ runId: RUN_ID, role: 'builder', chunk: FILLER });
    await flushMicrotasks();
    expect(_isPendingForTest(RUN_ID)).toBe(true);

    clearRunBuffers(RUN_ID);

    expect(_isPendingForTest(RUN_ID)).toBe(false);
  });
});
