/**
 * Unit tests for the pipeline-launch shortcut detector.
 *
 * Mounting <App /> in happy-dom drags in PTY/IPC plumbing, lifecycle
 * dispatchers, and Tauri-only side effects (canvas store, theme store
 * localStorage probes) that aren't worth stubbing for one shortcut.
 * Instead we exercise the pure detector directly — the App-level
 * wiring is a single `if (isPipelineLaunchShortcut(e))` call inside
 * the existing keydown handler, which `npx tsc --noEmit` + the
 * existing app boot logic cover.
 */
import { describe, it, expect } from 'vitest';
import { isPipelineLaunchShortcut } from './utils/keyboardShortcuts';

function makeEvent(init: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  targetTag?: string;
}): KeyboardEvent {
  const target = init.targetTag
    ? Object.assign(document.createElement(init.targetTag), {})
    : null;
  // KeyboardEventInit doesn't include target; jsdom honors `target` set on
  // the event object after construction for our purposes.
  const ev = new KeyboardEvent('keydown', {
    key: init.key,
    metaKey: !!init.metaKey,
    ctrlKey: !!init.ctrlKey,
    shiftKey: !!init.shiftKey,
  });
  if (target) {
    Object.defineProperty(ev, 'target', { value: target, configurable: true });
  }
  return ev;
}

describe('isPipelineLaunchShortcut', () => {
  it('matches Cmd+Shift+P (uppercase P)', () => {
    expect(isPipelineLaunchShortcut(makeEvent({ key: 'P', metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('matches Ctrl+Shift+P (uppercase P)', () => {
    expect(isPipelineLaunchShortcut(makeEvent({ key: 'P', ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('also matches lowercase p defensively', () => {
    expect(isPipelineLaunchShortcut(makeEvent({ key: 'p', metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('does not fire without modifier', () => {
    expect(isPipelineLaunchShortcut(makeEvent({ key: 'P', shiftKey: true }))).toBe(false);
  });

  it('does not fire without Shift (collides with reload would not, but the spec is Cmd+Shift+P)', () => {
    expect(isPipelineLaunchShortcut(makeEvent({ key: 'p', metaKey: true }))).toBe(false);
  });

  it('does not fire on a different key', () => {
    expect(isPipelineLaunchShortcut(makeEvent({ key: 'k', metaKey: true, shiftKey: true }))).toBe(false);
  });

  it('does NOT fire when focus is in a TEXTAREA (modal goal field)', () => {
    expect(isPipelineLaunchShortcut(makeEvent({
      key: 'P', metaKey: true, shiftKey: true, targetTag: 'textarea',
    }))).toBe(false);
  });

  it('does NOT fire when focus is in an INPUT', () => {
    expect(isPipelineLaunchShortcut(makeEvent({
      key: 'P', ctrlKey: true, shiftKey: true, targetTag: 'input',
    }))).toBe(false);
  });
});
