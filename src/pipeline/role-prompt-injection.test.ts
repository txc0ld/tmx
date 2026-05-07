import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { injectRolePromptForAgent, isPipelineRoleMode } from './role-prompt-injection';

describe('isPipelineRoleMode', () => {
  it('accepts the four real pipeline roles', () => {
    expect(isPipelineRoleMode('planner')).toBe(true);
    expect(isPipelineRoleMode('builder')).toBe(true);
    expect(isPipelineRoleMode('reviewer')).toBe(true);
    expect(isPipelineRoleMode('reviewer-codex')).toBe(true);
  });

  it('rejects stub modes used by the smoke template', () => {
    expect(isPipelineRoleMode('planner-stub')).toBe(false);
    expect(isPipelineRoleMode('builder-stub')).toBe(false);
    expect(isPipelineRoleMode('reviewer-stub')).toBe(false);
  });

  it('rejects undefined / empty / arbitrary modes', () => {
    expect(isPipelineRoleMode(undefined)).toBe(false);
    expect(isPipelineRoleMode('')).toBe(false);
    expect(isPipelineRoleMode('foo')).toBe(false);
    expect(isPipelineRoleMode('controller')).toBe(false);
  });
});

describe('injectRolePromptForAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips injection when mode is not a real role', async () => {
    const readRolePrompt = vi.fn();
    const write = vi.fn();
    const listen = vi.fn();
    const res = await injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'planner-stub',
      deps: { readRolePrompt, write, listen },
    });
    expect(res).toEqual({ injected: false, reason: 'mode not a pipeline role' });
    expect(readRolePrompt).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('skips injection when prompt is null (not authored)', async () => {
    const readRolePrompt = vi.fn().mockResolvedValue(null);
    const write = vi.fn();
    const listen = vi.fn();
    const res = await injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'planner',
      deps: { readRolePrompt, write, listen },
    });
    expect(res).toEqual({ injected: false, reason: 'prompt absent or empty' });
    expect(write).not.toHaveBeenCalled();
  });

  it('writes the prompt + CR after PTY-silence elapses', async () => {
    const readRolePrompt = vi.fn().mockResolvedValue('# Planner role\nbe disciplined');
    const write = vi.fn().mockResolvedValue(undefined);
    let outputHandler: ((ev: { id: string }) => void) | null = null;
    const unlisten = vi.fn();
    const listen = vi.fn().mockImplementation((cb: (ev: { id: string }) => void) => {
      outputHandler = cb;
      return Promise.resolve(unlisten);
    });

    const promise = injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'planner',
      deps: { readRolePrompt, write, listen },
    });

    // Drain microtasks so the listener registers.
    await Promise.resolve();
    await Promise.resolve();

    // Simulate one PTY chunk arriving, then 1.2s of silence.
    outputHandler!({ id: 'pty-1' });
    await vi.advanceTimersByTimeAsync(1200);
    // The fire() schedules a setTimeout(300) for the trailing \r.
    await vi.advanceTimersByTimeAsync(310);

    const res = await promise;
    expect(res.injected).toBe(true);
    expect(write).toHaveBeenNthCalledWith(1, 'pty-1', '# Planner role\nbe disciplined');
    expect(write).toHaveBeenNthCalledWith(2, 'pty-1', '\r');
  });

  it('strips ANSI escapes + control chars from the prompt before write', async () => {
    const dirty = 'normal text \x1b[31mred\x1b[0m and \x07 bell';
    const readRolePrompt = vi.fn().mockResolvedValue(dirty);
    const write = vi.fn().mockResolvedValue(undefined);
    const unlisten = vi.fn();
    let outputHandler: ((ev: { id: string }) => void) | null = null;
    const listen = vi.fn().mockImplementation((cb: (ev: { id: string }) => void) => {
      outputHandler = cb;
      return Promise.resolve(unlisten);
    });

    const promise = injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'builder',
      deps: { readRolePrompt, write, listen },
    });

    await Promise.resolve();
    await Promise.resolve();
    outputHandler!({ id: 'pty-1' });
    await vi.advanceTimersByTimeAsync(1200);
    await vi.advanceTimersByTimeAsync(310);

    await promise;
    const written = write.mock.calls[0]?.[1] ?? '';
    expect(written).not.toContain('\x1b');
    expect(written).not.toContain('\x07');
    expect(written).toBe('normal text red and  bell');
  });

  it('falls back to the 15s ceiling when the agent never emits output', async () => {
    const readRolePrompt = vi.fn().mockResolvedValue('# Reviewer\nread-only');
    const write = vi.fn().mockResolvedValue(undefined);
    const unlisten = vi.fn();
    const listen = vi.fn().mockImplementation(() => Promise.resolve(unlisten));

    const promise = injectRolePromptForAgent({
      ptyId: 'pty-2',
      mode: 'reviewer',
      deps: { readRolePrompt, write, listen },
    });

    await Promise.resolve();
    await Promise.resolve();

    // No output event ever arrives. The 15s fallback fires.
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(310);

    const res = await promise;
    expect(res.injected).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('ignores PTY output for OTHER ids', async () => {
    const readRolePrompt = vi.fn().mockResolvedValue('# planner');
    const write = vi.fn().mockResolvedValue(undefined);
    const unlisten = vi.fn();
    let outputHandler: ((ev: { id: string }) => void) | null = null;
    const listen = vi.fn().mockImplementation((cb: (ev: { id: string }) => void) => {
      outputHandler = cb;
      return Promise.resolve(unlisten);
    });

    const promise = injectRolePromptForAgent({
      ptyId: 'pty-A',
      mode: 'planner',
      deps: { readRolePrompt, write, listen },
    });

    await Promise.resolve();
    await Promise.resolve();

    outputHandler!({ id: 'pty-B' }); // another tile's PTY
    await vi.advanceTimersByTimeAsync(1200);
    expect(write).not.toHaveBeenCalled();

    // Now real output for our PTY:
    outputHandler!({ id: 'pty-A' });
    await vi.advanceTimersByTimeAsync(1200);
    await vi.advanceTimersByTimeAsync(310);

    await promise;
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('reports `read failed` reason when the IPC throws', async () => {
    const readRolePrompt = vi.fn().mockRejectedValue(new Error('IPC validation: unknown role'));
    const write = vi.fn();
    const listen = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'planner',
      deps: { readRolePrompt, write, listen },
    });

    expect(res.injected).toBe(false);
    expect(res.reason).toContain('read failed');
    expect(write).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
