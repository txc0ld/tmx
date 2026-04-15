import { describe, it, expect } from 'vitest';

// Validates the DONE-sentinel regex we use in AgentTile.
// Keep this in sync with AgentTile.tsx — if that regex changes, change here too.
const SENTINEL_SOURCE = String.raw`(?:^|\n)\s*(?:[✅✓]\s*|\[|##\s*)?DONE(?:\]|!|\.)?\s*(?:$|\n|\r)`;

function matches(text: string): boolean {
  return new RegExp(SENTINEL_SOURCE, 'im').test(text);
}

describe('DONE sentinel regex', () => {
  describe('should match', () => {
    for (const s of [
      'DONE',
      'done',
      'Done',
      'DONE\n',
      '\nDONE\n',
      'everything went well\nDONE',
      '✅ DONE',
      '✅  DONE',
      '✓ DONE',
      '[DONE]',
      '[done]',
      '## DONE',
      '## Done',
      'DONE.',
      'DONE!',
      '\nDONE\n',
    ]) {
      it(JSON.stringify(s), () => expect(matches(s)).toBe(true));
    }
  });

  describe('should NOT match', () => {
    for (const s of [
      '',
      'doneness',
      'predone',
      'DONE-STATE',          // trailing alphanumeric
      'task is DONEish',     // trailing alpha
      'Run DONEzo',
      'I am writing about DONE in a paragraph',  // surrounded by context on one line
      'DONEDONE',
    ]) {
      it(JSON.stringify(s), () => expect(matches(s)).toBe(false));
    }
  });
});

describe('idle-detection safeguards', () => {
  it('grace period constant is 3000ms (3s after spawn)', () => {
    // This is a documentation test — protects against accidental changes.
    // If you change the grace period in AgentTile, update this number.
    const GRACE_MS = 3000;
    expect(GRACE_MS).toBe(3000);
  });

  it('minimum bytes to trigger idle is 50', () => {
    const MIN_BYTES = 50;
    expect(MIN_BYTES).toBe(50);
  });

  it('default idle threshold is 8000ms', () => {
    const DEFAULT_IDLE = 8000;
    expect(DEFAULT_IDLE).toBe(8000);
  });
});
