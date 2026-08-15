import { describe, expect, it } from 'vitest';
import { keyToSequence } from './xtermInput';

function key(key: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', { key, ...init });
}

describe('keyToSequence', () => {
  it('maps control letters to control bytes', () => {
    expect(keyToSequence(key('c', { ctrlKey: true }))).toBe('\x03');
    expect(keyToSequence(key('z', { ctrlKey: true }))).toBe('\x1a');
  });

  it('preserves plain Ctrl+D for shell EOF', () => {
    expect(keyToSequence(key('d', { ctrlKey: true }))).toBe('\x04');
  });

  it('maps modified arrows using xterm-compatible CSI modifiers', () => {
    expect(keyToSequence(key('ArrowLeft', { ctrlKey: true }))).toBe('\x1b[1;5D');
    expect(keyToSequence(key('ArrowRight', { altKey: true }))).toBe('\x1b[1;3C');
    expect(keyToSequence(key('ArrowUp', { shiftKey: true }))).toBe('\x1b[1;2A');
    expect(keyToSequence(key('ArrowDown', { ctrlKey: true, shiftKey: true }))).toBe('\x1b[1;6B');
  });

  it('uses application cursor mode for unmodified arrows only', () => {
    expect(keyToSequence(key('ArrowUp'), true)).toBe('\x1bOA');
    expect(keyToSequence(key('ArrowUp', { ctrlKey: true }), true)).toBe('\x1b[1;5A');
  });

  it('leaves Ctrl+Shift printable app shortcuts to the app layer', () => {
    expect(keyToSequence(key('P', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});
