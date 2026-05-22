import { describe, expect, it } from 'vitest';
import { stripRuntimeTileState, stripRuntimeTilesState } from '@/utils/runtimeState';
import type { Tile } from '@/types';

describe('runtime state stripping', () => {
  it('drops stale PTY ids before persisting or restoring tiles', () => {
    const terminal: Tile = {
      id: 'term-1',
      type: 'terminal',
      title: 'Terminal',
      x: 0,
      y: 0,
      w: 600,
      h: 400,
      cwd: 'C:/repo',
      branch: '',
      node: '',
      ptyId: 'old-main-pty',
      splits: [{ id: 'split-1', direction: 'horizontal', ratio: 0.5, ptyId: 'old-split-pty' }],
    };

    const stripped = stripRuntimeTileState(terminal);

    expect('ptyId' in stripped).toBe(false);
    expect(stripped.type).toBe('terminal');
    if (stripped.type !== 'terminal') throw new Error('expected terminal tile');
    expect(stripped.splits?.[0].ptyId).toBe('');
    expect(terminal.type).toBe('terminal');
    expect(terminal.ptyId).toBe('old-main-pty');
    expect(terminal.splits?.[0].ptyId).toBe('old-split-pty');
  });

  it('resets running runner tiles to idle', () => {
    const runner: Tile = {
      id: 'run-1',
      type: 'runner',
      x: 0,
      y: 0,
      w: 500,
      h: 250,
      command: 'pnpm test',
      cwd: 'C:/repo',
      status: 'running',
      lastOutput: '',
      ptyId: 'old-runner-pty',
    };

    const [stripped] = stripRuntimeTilesState([runner]);

    expect(stripped.type).toBe('runner');
    if (stripped.type !== 'runner') throw new Error('expected runner tile');
    expect(stripped.status).toBe('idle');
    expect('ptyId' in stripped).toBe(false);
  });
});
