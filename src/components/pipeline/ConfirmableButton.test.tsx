import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { ConfirmableButton } from './ConfirmableButton';

describe('ConfirmableButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('first click does NOT call onConfirm; enters confirming state', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmableButton
        label="Abort"
        confirmLabel="Confirm abort?"
        onConfirm={onConfirm}
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('Abort');
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    // Label flips to confirm + countdown ("4s").
    expect(btn.textContent).toContain('Confirm abort?');
    expect(btn.textContent).toContain('4s');
    expect(btn.getAttribute('data-confirming')).toBe('true');
  });

  it('second click within window calls onConfirm exactly once', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmableButton
        label="Abort"
        confirmLabel="Confirm abort?"
        onConfirm={onConfirm}
      />,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Reverts to default after fire.
    expect(btn.textContent).toBe('Abort');
    expect(btn.getAttribute('data-confirming')).toBe('false');
  });

  it('after timeout the confirming state reverts; next click does NOT trigger', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmableButton
        label="Abort"
        confirmLabel="Confirm abort?"
        onConfirm={onConfirm}
        confirmDelayMs={4000}
      />,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(btn.getAttribute('data-confirming')).toBe('true');
    // Cross the timeout boundary.
    act(() => {
      vi.advanceTimersByTime(4001);
    });
    expect(btn.getAttribute('data-confirming')).toBe('false');
    expect(btn.textContent).toBe('Abort');
    // The next click is treated as a fresh first-click — does not fire.
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.getAttribute('data-confirming')).toBe('true');
  });

  it('countdown decrements every 1s', () => {
    render(
      <ConfirmableButton
        label="Abort"
        confirmLabel="Confirm abort?"
        onConfirm={() => {}}
        confirmDelayMs={4000}
      />,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(btn.textContent).toContain('4s');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(btn.textContent).toContain('3s');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(btn.textContent).toContain('2s');
  });

  it('respects custom labels', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmableButton
        label="Clear"
        confirmLabel="Confirm clear?"
        onConfirm={onConfirm}
        variant="neutral"
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('Clear');
    fireEvent.click(btn);
    expect(btn.textContent).toContain('Confirm clear?');
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('honors confirmDelayMs DI for the revert timer', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmableButton
        label="Go"
        confirmLabel="Confirm?"
        onConfirm={onConfirm}
        confirmDelayMs={2000}
      />,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(btn.getAttribute('data-confirming')).toBe('true');
    // Just before 2s — still confirming.
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(btn.getAttribute('data-confirming')).toBe('true');
    // Cross 2s — reverts.
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(btn.getAttribute('data-confirming')).toBe('false');
  });

  it('disabled prop blocks click handling', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmableButton
        label="Abort"
        confirmLabel="Confirm abort?"
        onConfirm={onConfirm}
        disabled
      />,
    );
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.getAttribute('data-confirming')).toBe('false');
  });
});
