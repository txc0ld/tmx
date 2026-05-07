import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('@/utils/ipc', () => ({
  ptyWrite: vi.fn(),
}));

import { ptyWrite } from '@/utils/ipc';
import { ClarificationModal } from './ClarificationModal';
import {
  usePipelineStore,
  setPipelineTelemetryEmitter,
  type TelemetryEvent,
} from '@/stores/pipelineStore';
import { useCanvasStore } from '@/stores/canvasStore';
import type { AgentTile, PipelineRun, QuestionArtifact } from '@/types';

const mockPtyWrite = vi.mocked(ptyWrite);

function makeQuestion(over: Partial<QuestionArtifact> = {}): QuestionArtifact {
  return {
    stage: 'builder',
    question: 'Should foo behave as X or Y?',
    context: 'spec mentions both X and Y in different sections',
    options: ['X', 'Y'],
    blocking: true,
    ...over,
  };
}

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-clar-1',
    templateId: 'tmpl-anth-trio',
    projectId: 'proj-1',
    worktreePath: '/tmp/wt/run-clar-1',
    branch: 'feat/run-clar-1',
    baseBranch: 'main',
    state: 'awaiting_clarification',
    priorActiveState: 'building',
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [makeQuestion()], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 1,
    escalationLog: [],
    tiles: { builder: 'tile-builder-1' },
    fingerprint: {
      templateId: 'tmpl-anth-trio',
      templateHash: 'h',
      skillHashes: {},
      rolePromptHashes: {},
      models: {},
      capabilityManifests: {},
      terminalxVersion: '0.1.0',
    },
    planLineage: [],
    runMode: 'standard',
    autoApprovePlan: false,
    useDualReviewer: false,
    runRedTeam: false,
    effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3 },
    templateDualReviewer: false,
    ...overrides,
  };
}

function seedBuilderTile(ptyId: string | undefined = 'pty-builder-1') {
  const tile: AgentTile = {
    id: 'tile-builder-1',
    type: 'agent',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    title: 'Builder',
    agent: 'claude',
    model: 'opus-4-7',
    effort: '',
    mode: '',
    version: '',
    cwd: '',
    branch: '',
    status: 'working',
    elapsed: 0,
    ptyId,
  };
  // Drop the tile into whatever project key the store currently uses.
  const projectId = useCanvasStore.getState().activeProject || 'proj-1';
  useCanvasStore.setState({
    tiles: { [projectId]: [tile] },
  } as Partial<ReturnType<typeof useCanvasStore.getState>>);
}

function seedRun(run: PipelineRun) {
  usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
}

function resetStores() {
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
  useCanvasStore.setState({ tiles: {} } as Partial<ReturnType<typeof useCanvasStore.getState>>);
}

describe('ClarificationModal', () => {
  beforeEach(() => {
    mockPtyWrite.mockReset();
    mockPtyWrite.mockResolvedValue(undefined);
    resetStores();
  });

  it('renders question text, context, and option buttons', () => {
    const run = makeRun();
    seedRun(run);
    seedBuilderTile();

    render(<ClarificationModal run={run} />);

    expect(screen.getByTestId('clarification-question').textContent).toContain(
      'Should foo behave as X or Y?',
    );
    // Header capitalized
    expect(screen.getByRole('dialog').textContent).toContain('Question from Builder');
    // Collapsible context summary
    expect(screen.getByTestId('clarification-context').textContent).toContain('Context');
    expect(screen.getByTestId('clarification-context').textContent).toContain(
      'spec mentions both X and Y',
    );
    // Both options rendered as buttons
    const opts = screen.getByTestId('clarification-options');
    expect(opts.textContent).toContain('X');
    expect(opts.textContent).toContain('Y');
    expect(screen.getByTestId('clarification-option-0')).toBeTruthy();
    expect(screen.getByTestId('clarification-option-1')).toBeTruthy();
  });

  it('Submit click → ptyWrite + clarification_received → resumes priorActiveState', async () => {
    const run = makeRun();
    seedRun(run);
    seedBuilderTile('pty-builder-1');

    render(<ClarificationModal run={run} />);

    const textarea = screen.getByTestId('clarification-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'go with X' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('clarification-submit'));
      // Drain microtasks so the async injectAnswer + dispatch settles.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPtyWrite).toHaveBeenCalledWith('pty-builder-1', 'go with X\r');

    const finalRun = usePipelineStore.getState().runs['run-clar-1'];
    expect(finalRun.state).toBe('building'); // priorActiveState restored
    expect(finalRun.priorActiveState).toBeUndefined();
  });

  it('Cancel click dispatches abort with reason "clarification_cancelled"', () => {
    const run = makeRun();
    seedRun(run);
    seedBuilderTile();

    render(<ClarificationModal run={run} />);
    fireEvent.click(screen.getByTestId('clarification-cancel'));

    const finalRun = usePipelineStore.getState().runs['run-clar-1'];
    expect(finalRun.state).toBe('failed');
    expect(finalRun.failureReason).toBe('clarification_cancelled');
  });

  it('Option click pre-fills textarea (does not auto-submit)', () => {
    const run = makeRun();
    seedRun(run);
    seedBuilderTile();

    render(<ClarificationModal run={run} />);

    fireEvent.click(screen.getByTestId('clarification-option-1'));

    const textarea = screen.getByTestId('clarification-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Y');
    // Run is still in awaiting_clarification — no auto-dispatch.
    expect(usePipelineStore.getState().runs['run-clar-1'].state).toBe('awaiting_clarification');
    expect(mockPtyWrite).not.toHaveBeenCalled();
  });

  it('Submit button disabled when textarea empty, enabled after typing, disabled while submitting', async () => {
    const run = makeRun();
    seedRun(run);
    seedBuilderTile('pty-builder-1');

    // Hold the ptyWrite promise open so we can observe the in-flight state.
    let resolveWrite!: () => void;
    mockPtyWrite.mockReturnValue(
      new Promise<void>((res) => {
        resolveWrite = res;
      }),
    );

    render(<ClarificationModal run={run} />);

    const submitBtn = screen.getByTestId('clarification-submit') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    const textarea = screen.getByTestId('clarification-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'something' } });
    expect(submitBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(submitBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    // submitting=true → disabled while in-flight
    expect(submitBtn.disabled).toBe(true);

    await act(async () => {
      resolveWrite();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('Whitespace-only answer keeps Submit disabled', () => {
    const run = makeRun();
    seedRun(run);
    seedBuilderTile();

    render(<ClarificationModal run={run} />);
    const submitBtn = screen.getByTestId('clarification-submit') as HTMLButtonElement;
    const textarea = screen.getByTestId('clarification-textarea') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '   \n\t  ' } });
    expect(submitBtn.disabled).toBe(true);
  });

  describe('telemetry', () => {
    let captured: TelemetryEvent[];

    beforeEach(() => {
      captured = [];
      setPipelineTelemetryEmitter((ev) => captured.push(ev));
    });

    afterEach(() => {
      setPipelineTelemetryEmitter(null);
    });

    it('emits clarification_answered on submit', async () => {
      const run = makeRun();
      seedRun(run);
      seedBuilderTile('pty-builder-1');

      render(<ClarificationModal run={run} />);
      fireEvent.change(screen.getByTestId('clarification-textarea'), {
        target: { value: 'pick X' },
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('clarification-submit'));
        await Promise.resolve();
        await Promise.resolve();
      });

      const ev = captured.find((e) => e.event === 'clarification_answered');
      expect(ev).toMatchObject({
        event: 'clarification_answered',
        runId: 'run-clar-1',
        projectId: 'proj-1',
        stage: 'builder',
      });
    });
  });

  it('one-shot path (no PTY bound) still dispatches and emits telemetry', async () => {
    // Reviewer is one-shot — no PTY in tiles. Modal must still resume the run.
    const captured: TelemetryEvent[] = [];
    setPipelineTelemetryEmitter((ev) => captured.push(ev));

    const run = makeRun({
      priorActiveState: 'reviewing',
      artifacts: {
        builds: [],
        reviews: [],
        ciResults: [],
        questions: [makeQuestion({ stage: 'reviewer', options: undefined })],
        redTeamReports: [],
      },
      tiles: {}, // no reviewer tile (one-shot CLI invocation)
    });
    seedRun(run);

    render(<ClarificationModal run={run} />);
    fireEvent.change(screen.getByTestId('clarification-textarea'), {
      target: { value: 'rebuild from scratch' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('clarification-submit'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPtyWrite).not.toHaveBeenCalled();
    expect(usePipelineStore.getState().runs['run-clar-1'].state).toBe('reviewing');
    expect(captured.find((e) => e.event === 'clarification_answered')).toBeDefined();
    setPipelineTelemetryEmitter(null);
  });
});
