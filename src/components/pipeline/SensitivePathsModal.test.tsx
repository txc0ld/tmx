import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SensitivePathsModal } from './SensitivePathsModal';

describe('SensitivePathsModal', () => {
  it('renders all paths when count is <= 20', () => {
    const paths = Array.from({ length: 5 }, (_, i) => `.env.${i}`);
    render(
      <SensitivePathsModal
        paths={paths}
        onAcknowledge={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const list = screen.getByTestId('sensitive-paths-list');
    for (const p of paths) {
      expect(list.textContent).toContain(p);
    }
    // No overflow row when nothing truncated.
    expect(screen.queryByTestId('sensitive-paths-overflow')).toBeNull();
  });

  it('truncates with "+N more" when paths.length > 20', () => {
    const paths = Array.from({ length: 27 }, (_, i) => `secrets/file-${i}.key`);
    render(
      <SensitivePathsModal
        paths={paths}
        onAcknowledge={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const list = screen.getByTestId('sensitive-paths-list');
    // First 20 visible.
    for (let i = 0; i < 20; i++) {
      expect(list.textContent).toContain(`secrets/file-${i}.key`);
    }
    // 21st onward NOT visible.
    expect(list.textContent).not.toContain('secrets/file-20.key');

    const overflow = screen.getByTestId('sensitive-paths-overflow');
    expect(overflow.textContent).toContain('+7 more');
  });

  it('Acknowledge button click calls onAcknowledge (and not onCancel)', () => {
    const onAcknowledge = vi.fn();
    const onCancel = vi.fn();
    render(
      <SensitivePathsModal
        paths={['.env']}
        onAcknowledge={onAcknowledge}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('sensitive-paths-acknowledge'));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Cancel button click calls onCancel (and not onAcknowledge)', () => {
    const onAcknowledge = vi.fn();
    const onCancel = vi.fn();
    render(
      <SensitivePathsModal
        paths={['.env']}
        onAcknowledge={onAcknowledge}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('sensitive-paths-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it('Escape key triggers onCancel', () => {
    const onAcknowledge = vi.fn();
    const onCancel = vi.fn();
    render(
      <SensitivePathsModal
        paths={['.env']}
        onAcknowledge={onAcknowledge}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it('click on the overlay does NOT close the modal (destructive op pattern)', () => {
    const onAcknowledge = vi.fn();
    const onCancel = vi.fn();
    render(
      <SensitivePathsModal
        paths={['.env']}
        onAcknowledge={onAcknowledge}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('sensitive-paths-modal'));
    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
