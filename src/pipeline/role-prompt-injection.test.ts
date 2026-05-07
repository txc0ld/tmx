import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  injectRolePromptForAgent,
  isPipelineRoleMode,
  substituteInvariants,
} from './role-prompt-injection';

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

// Phase 3b.7: INVARIANTS.md substitution.
//
// Pure-function tests on the substitution logic, then end-to-end through
// `injectRolePromptForAgent` with a stubbed `readInvariants` to confirm the
// IPC round-trip is wired correctly.
describe('substituteInvariants', () => {
  it('replaces the placeholder with content when invariants is non-empty', () => {
    const prompt = 'before\n`{INVARIANTS_PLACEHOLDER}`\nafter';
    const out = substituteInvariants(prompt, 'do not delete migrations');
    expect(out).toBe('before\n`do not delete migrations`\nafter');
    expect(out).not.toContain('{INVARIANTS_PLACEHOLDER}');
  });

  it('replaces the placeholder with the (none specified) fallback when invariants is null', () => {
    const prompt = 'before\n`{INVARIANTS_PLACEHOLDER}`\nafter';
    const out = substituteInvariants(prompt, null);
    expect(out).toBe('before\n`(none specified — proceed with role defaults)`\nafter');
    expect(out).not.toContain('{INVARIANTS_PLACEHOLDER}');
  });

  it('uses the fallback when invariants is empty / whitespace-only', () => {
    const promptEmpty = '`{INVARIANTS_PLACEHOLDER}`';
    expect(substituteInvariants(promptEmpty, '')).toContain('(none specified');
    expect(substituteInvariants(promptEmpty, '   \n\t  ')).toContain('(none specified');
  });

  it('passes through unchanged when prompt has no placeholder', () => {
    const prompt = '# Old prompt with no placeholder\nbe disciplined';
    expect(substituteInvariants(prompt, 'rule X')).toBe(prompt);
    expect(substituteInvariants(prompt, null)).toBe(prompt);
  });

  it('replaces every occurrence when the placeholder appears multiple times', () => {
    const prompt = 'A: {INVARIANTS_PLACEHOLDER} B: {INVARIANTS_PLACEHOLDER} C';
    const out = substituteInvariants(prompt, 'rule-A');
    expect(out).toBe('A: rule-A B: rule-A C');
    expect(out).not.toContain('{INVARIANTS_PLACEHOLDER}');
  });
});

describe('injectRolePromptForAgent — INVARIANTS.md injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeDeps(promptContent: string, invariants: string | null) {
    const readRolePrompt = vi.fn().mockResolvedValue(promptContent);
    const write = vi.fn().mockResolvedValue(undefined);
    let outputHandler: ((ev: { id: string }) => void) | null = null;
    const unlisten = vi.fn();
    const listen = vi.fn().mockImplementation((cb: (ev: { id: string }) => void) => {
      outputHandler = cb;
      return Promise.resolve(unlisten);
    });
    const readInvariants = vi.fn().mockResolvedValue(invariants);
    return {
      readRolePrompt,
      write,
      listen,
      readInvariants,
      unlisten,
      getHandler: () => outputHandler,
    };
  }

  async function fire(getHandler: () => ((ev: { id: string }) => void) | null, id: string) {
    // Drain microtasks until both readRolePrompt + readInvariants resolve and
    // the listener registers. Three turns covers: (1) readRolePrompt, (2)
    // readInvariants, (3) deps.listen() promise resolution.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const handler = getHandler();
    handler!({ id });
    await vi.advanceTimersByTimeAsync(1200);
    await vi.advanceTimersByTimeAsync(310);
  }

  it('substitutes INVARIANTS.md content into the prompt before writing', async () => {
    const prompt = '# Planner\n`{INVARIANTS_PLACEHOLDER}`\n## What you do\n...';
    const deps = makeDeps(prompt, 'never delete migrations');

    const promise = injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'planner',
      projectDir: '/some/proj',
      deps,
    });
    await fire(deps.getHandler, 'pty-1');
    await promise;

    expect(deps.readInvariants).toHaveBeenCalledWith('/some/proj');
    const written = deps.write.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('never delete migrations');
    expect(written).not.toContain('{INVARIANTS_PLACEHOLDER}');
  });

  it('substitutes the (none specified) fallback when INVARIANTS.md is missing', async () => {
    const prompt = '# Builder\n`{INVARIANTS_PLACEHOLDER}`\nrest';
    const deps = makeDeps(prompt, null);

    const promise = injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'builder',
      projectDir: '/some/proj',
      deps,
    });
    await fire(deps.getHandler, 'pty-1');
    await promise;

    expect(deps.readInvariants).toHaveBeenCalledWith('/some/proj');
    const written = deps.write.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('(none specified');
    expect(written).not.toContain('{INVARIANTS_PLACEHOLDER}');
  });

  it('skips the invariants IPC entirely when prompt has no placeholder', async () => {
    const prompt = '# Old prompt with no placeholder\nbe disciplined';
    const deps = makeDeps(prompt, 'should-never-be-read');

    const promise = injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'reviewer',
      projectDir: '/some/proj',
      deps,
    });
    await fire(deps.getHandler, 'pty-1');
    await promise;

    expect(deps.readInvariants).not.toHaveBeenCalled();
    const written = deps.write.mock.calls[0]?.[1] ?? '';
    expect(written).toBe(prompt);
  });

  it('uses the fallback string when projectDir is omitted', async () => {
    const prompt = '# Planner\n`{INVARIANTS_PLACEHOLDER}`\n';
    const deps = makeDeps(prompt, 'should-not-matter');

    const promise = injectRolePromptForAgent({
      ptyId: 'pty-1',
      mode: 'planner',
      // projectDir intentionally omitted
      deps,
    });
    await fire(deps.getHandler, 'pty-1');
    await promise;

    // No projectDir → readInvariants is bypassed, fallback string used.
    expect(deps.readInvariants).not.toHaveBeenCalled();
    const written = deps.write.mock.calls[0]?.[1] ?? '';
    expect(written).toContain('(none specified');
  });
});
