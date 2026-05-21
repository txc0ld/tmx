import { describe, expect, it } from 'vitest';
import { joinPath } from './path';

describe('joinPath', () => {
  it('joins POSIX paths without double separators', () => {
    expect(joinPath('/Users/me/repo/', '.tx-worktrees', 'r1')).toBe('/Users/me/repo/.tx-worktrees/r1');
  });

  it('joins Windows drive paths with backslashes', () => {
    expect(joinPath('C:\\Users\\me\\repo', '.tx-worktrees', 'r1')).toBe('C:\\Users\\me\\repo\\.tx-worktrees\\r1');
  });

  it('preserves UNC-style separators', () => {
    expect(joinPath('\\\\server\\share\\repo\\', '.terminalx/pipeline-runs', 'r1.json')).toBe(
      '\\\\server\\share\\repo\\.terminalx\\pipeline-runs\\r1.json',
    );
  });
});
