import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StartPipelineRunModal } from './StartPipelineRunModal';

describe('StartPipelineRunModal', () => {
  it('defaults to anthropic-trio and submits goal/branch/templateId together', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <StartPipelineRunModal
        defaultBranch="feature/foo"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const select = screen.getByTestId('start-pipeline-run-template') as HTMLSelectElement;
    expect(select.value).toBe('tx.pipeline.anthropic-trio');

    const goal = screen.getByTestId('start-pipeline-run-goal') as HTMLTextAreaElement;
    fireEvent.change(goal, { target: { value: 'do the thing' } });

    fireEvent.click(screen.getByTestId('start-pipeline-run-submit'));
    // Flush the queued microtask + state update before asserting.
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      goal: 'do the thing',
      branch: 'feature/foo',
      templateId: 'tx.pipeline.anthropic-trio',
    });
  });

  it('pre-fills the goal textarea when defaultGoal is provided', () => {
    render(
      <StartPipelineRunModal
        defaultBranch="feature/foo"
        defaultGoal="rerun this exact goal"
        onSubmit={vi.fn().mockResolvedValue({ ok: true })}
        onCancel={vi.fn()}
      />,
    );
    const goal = screen.getByTestId('start-pipeline-run-goal') as HTMLTextAreaElement;
    expect(goal.value).toBe('rerun this exact goal');
  });

  it('still allows the user to edit the pre-filled goal before submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <StartPipelineRunModal
        defaultBranch="feature/foo"
        defaultGoal="prior goal"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const goal = screen.getByTestId('start-pipeline-run-goal') as HTMLTextAreaElement;
    fireEvent.change(goal, { target: { value: 'edited goal' } });
    fireEvent.click(screen.getByTestId('start-pipeline-run-submit'));
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      goal: 'edited goal',
      branch: 'feature/foo',
      templateId: 'tx.pipeline.anthropic-trio',
    });
  });

  it('selecting a template passes the id through onSubmit', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <StartPipelineRunModal
        defaultBranch="feature/foo"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('start-pipeline-run-template'), {
      target: { value: 'tx.pipeline.hello-world' },
    });
    fireEvent.change(screen.getByTestId('start-pipeline-run-goal'), {
      target: { value: 'smoke test goal' },
    });

    fireEvent.click(screen.getByTestId('start-pipeline-run-submit'));
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      goal: 'smoke test goal',
      branch: 'feature/foo',
      templateId: 'tx.pipeline.hello-world',
    });
  });
});
