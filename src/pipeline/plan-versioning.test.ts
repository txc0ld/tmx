import { describe, it, expect } from 'vitest';
import { nextPlanVersionSuffix, versionedPlanPath } from './plan-versioning';

describe('nextPlanVersionSuffix', () => {
  it('returns "" for an empty lineage (v1, no suffix)', () => {
    expect(nextPlanVersionSuffix(0)).toBe('');
  });

  it('returns "-v2" when one version already exists', () => {
    expect(nextPlanVersionSuffix(1)).toBe('-v2');
  });

  it('returns "-v6" when five versions already exist', () => {
    expect(nextPlanVersionSuffix(5)).toBe('-v6');
  });

  it('clamps negative-ish input to "" defensively', () => {
    // Defensive: shouldn't happen, but a malformed runtime state shouldn't
    // produce a `-v0` filename.
    expect(nextPlanVersionSuffix(-1)).toBe('');
  });
});

describe('versionedPlanPath', () => {
  it('returns the original path unchanged for v1', () => {
    expect(versionedPlanPath('foo.md', 0)).toBe('foo.md');
    expect(versionedPlanPath('docs/plans/2026-foo.md', 0)).toBe('docs/plans/2026-foo.md');
  });

  it('inserts the suffix before the .md extension', () => {
    expect(versionedPlanPath('docs/plans/2026-foo.md', 2)).toBe('docs/plans/2026-foo-v3.md');
  });

  it('handles a path with no extension by appending at the end', () => {
    expect(versionedPlanPath('docs/plans/PLAN_NO_EXT', 1)).toBe('docs/plans/PLAN_NO_EXT-v2');
  });

  it('handles multiple dots by inserting before the LAST dot', () => {
    expect(versionedPlanPath('foo.bar.md', 2)).toBe('foo.bar-v3.md');
  });

  it('does not treat a dot in the directory as an extension', () => {
    // A dotted directory name (e.g. '.terminalx') must not fool the splitter
    // into producing 'docs.v1/plans/foo-v2'.
    expect(versionedPlanPath('docs.v1/plans/foo', 1)).toBe('docs.v1/plans/foo-v2');
  });

  it('handles Windows-style backslash separators', () => {
    expect(versionedPlanPath('docs\\plans\\foo.md', 1)).toBe('docs\\plans\\foo-v2.md');
  });
});
