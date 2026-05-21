import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StageProgress } from './StageProgress';
import type { PipelineState } from '@/types';

describe('StageProgress', () => {
  afterEach(() => cleanup());

  function activeStage(): string {
    const root = screen.getByTestId('stage-progress');
    return root.getAttribute('data-active-stage') ?? '';
  }

  function pillStatus(key: string): string | null {
    const el = screen.queryByTestId(`stage-pill-${key}`);
    return el ? el.getAttribute('data-status') : null;
  }

  it('idle / planning / awaiting_plan_approval highlight the Plan pill', () => {
    for (const state of ['idle', 'planning', 'awaiting_plan_approval'] as PipelineState[]) {
      cleanup();
      render(<StageProgress state={state} runMode="standard" />);
      expect(activeStage()).toBe('plan');
      expect(pillStatus('plan')).toBe('active');
      expect(pillStatus('build')).toBe('future');
    }
  });

  it('building highlights the Build pill and Plan is past', () => {
    render(<StageProgress state="building" runMode="standard" />);
    expect(activeStage()).toBe('build');
    expect(pillStatus('plan')).toBe('past');
    expect(pillStatus('build')).toBe('active');
    expect(pillStatus('review')).toBe('future');
  });

  it('reviewing / dual / tiebreaker highlight the Review pill', () => {
    for (const state of [
      'reviewing',
      'awaiting_dual_reviewer',
      'awaiting_tiebreaker',
    ] as PipelineState[]) {
      cleanup();
      render(<StageProgress state={state} runMode="standard" />);
      expect(activeStage()).toBe('review');
      expect(pillStatus('review')).toBe('active');
    }
  });

  it('awaiting_red_team highlights the Red Team pill (complex run)', () => {
    render(<StageProgress state="awaiting_red_team" runMode="complex" />);
    expect(activeStage()).toBe('red-team');
    expect(pillStatus('red-team')).toBe('active');
    // Review is past at this point.
    expect(pillStatus('review')).toBe('past');
  });

  it('awaiting_merge_approval / merging highlight the Merge pill', () => {
    for (const state of ['awaiting_merge_approval', 'merging'] as PipelineState[]) {
      cleanup();
      render(<StageProgress state={state} runMode="standard" />);
      expect(activeStage()).toBe('merge');
      expect(pillStatus('merge')).toBe('active');
      expect(pillStatus('review')).toBe('past');
    }
  });

  it('awaiting_clarification resumes highlight via priorActiveState', () => {
    render(
      <StageProgress
        state="awaiting_clarification"
        runMode="standard"
        priorActiveState="building"
      />,
    );
    expect(activeStage()).toBe('build');
    expect(pillStatus('build')).toBe('active');
  });

  it('awaiting_clarification with planning prior highlights Plan', () => {
    render(
      <StageProgress
        state="awaiting_clarification"
        runMode="standard"
        priorActiveState="planning"
      />,
    );
    expect(activeStage()).toBe('plan');
  });

  it('awaiting_clarification with reviewing prior highlights Review', () => {
    render(
      <StageProgress
        state="awaiting_clarification"
        runMode="standard"
        priorActiveState="reviewing"
      />,
    );
    expect(activeStage()).toBe('review');
  });

  it('done shows all pills filled-muted with a Done badge', () => {
    render(<StageProgress state="done" runMode="standard" />);
    expect(activeStage()).toBe('');
    expect(pillStatus('plan')).toBe('past');
    expect(pillStatus('build')).toBe('past');
    expect(pillStatus('review')).toBe('past');
    expect(pillStatus('merge')).toBe('past');
    const badge = screen.getByTestId('stage-badge-done');
    expect(badge.textContent).toBe('Done');
  });

  it('failed shows a Failed (red) badge', () => {
    render(<StageProgress state="failed" runMode="standard" />);
    const badge = screen.getByTestId('stage-badge-failed');
    expect(badge.textContent).toBe('Failed');
    // Confirm color hooks the error CSS var.
    expect(badge.getAttribute('style') || '').toContain('--tx-error');
  });

  it('escalated shows an Escalated badge', () => {
    render(<StageProgress state="escalated" runMode="standard" />);
    const badge = screen.getByTestId('stage-badge-escalated');
    expect(badge.textContent).toBe('Escalated');
  });

  it('complex runMode inserts a Red Team pill between Review and Merge', () => {
    render(<StageProgress state="reviewing" runMode="complex" />);
    expect(screen.getByTestId('stage-pill-red-team')).toBeTruthy();
    // Order: plan, build, review, red-team, merge.
    const root = screen.getByTestId('stage-progress');
    const order = Array.from(root.querySelectorAll('[data-testid^="stage-pill-"]')).map(
      el => el.getAttribute('data-testid'),
    );
    expect(order).toEqual([
      'stage-pill-plan',
      'stage-pill-build',
      'stage-pill-review',
      'stage-pill-red-team',
      'stage-pill-merge',
    ]);
  });

  it('non-complex runs do NOT show a Red Team pill', () => {
    render(<StageProgress state="reviewing" runMode="standard" />);
    expect(screen.queryByTestId('stage-pill-red-team')).toBeNull();
  });

  it('trivial runMode shows the standard 4-pill layout (no red-team)', () => {
    render(<StageProgress state="building" runMode="trivial" />);
    expect(screen.queryByTestId('stage-pill-red-team')).toBeNull();
    expect(screen.getByTestId('stage-pill-plan')).toBeTruthy();
    expect(screen.getByTestId('stage-pill-build')).toBeTruthy();
    expect(screen.getByTestId('stage-pill-review')).toBeTruthy();
    expect(screen.getByTestId('stage-pill-merge')).toBeTruthy();
  });

  it('useDualReviewer renders a ×2 subscript on the Review pill', () => {
    render(
      <StageProgress state="reviewing" runMode="standard" useDualReviewer />,
    );
    const review = screen.getByTestId('stage-pill-review');
    expect(review.textContent).toContain('×2');
  });

  it('omitting useDualReviewer leaves the Review pill plain', () => {
    render(<StageProgress state="reviewing" runMode="standard" />);
    const review = screen.getByTestId('stage-pill-review');
    expect(review.textContent).not.toContain('×2');
  });
});
