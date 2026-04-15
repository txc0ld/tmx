import { describe, expect, it } from 'vitest';
import {
  validateWorkspaceImport,
  validateTile,
  validateWire,
  validateTransform,
  WorkspaceImportError,
} from '@/utils/workspaceImport';

function baseTile(over: Record<string, unknown> = {}) {
  return { id: 't1', type: 'note', x: 0, y: 0, w: 200, h: 200, content: 'hi', ...over };
}

describe('validateWorkspaceImport', () => {
  it('accepts a minimal well-formed payload', () => {
    const result = validateWorkspaceImport({
      version: 1,
      tiles: [baseTile()],
      wires: [],
      transform: { x: 0, y: 0, scale: 1 },
    });
    expect(result.tiles).toHaveLength(1);
    expect(result.wires).toHaveLength(0);
    expect(result.transform).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('rejects non-object root', () => {
    expect(() => validateWorkspaceImport(null)).toThrow(WorkspaceImportError);
    expect(() => validateWorkspaceImport('{}')).toThrow(WorkspaceImportError);
    expect(() => validateWorkspaceImport([])).toThrow(WorkspaceImportError);
  });

  it('rejects unsupported version', () => {
    expect(() => validateWorkspaceImport({ version: 99, tiles: [] }))
      .toThrow(/version/i);
  });

  it('rejects when tiles is missing or not an array', () => {
    expect(() => validateWorkspaceImport({ version: 1 })).toThrow(/tiles/);
    expect(() => validateWorkspaceImport({ version: 1, tiles: 'nope' })).toThrow(/tiles/);
  });

  it('rejects too many tiles', () => {
    const many = Array.from({ length: 5001 }, (_, i) => baseTile({ id: `t${i}` }));
    expect(() => validateWorkspaceImport({ version: 1, tiles: many }))
      .toThrow(/Too many tiles/);
  });

  it('rejects duplicate tile IDs', () => {
    expect(() => validateWorkspaceImport({
      version: 1,
      tiles: [baseTile({ id: 'a' }), baseTile({ id: 'a' })],
    })).toThrow(/Duplicate tile id/);
  });

  it('reports which tile failed', () => {
    expect(() => validateWorkspaceImport({
      version: 1,
      tiles: [baseTile(), baseTile({ id: 't2', type: 'unknown-type' })],
    })).toThrow(/Tile \[1\]: Unknown tile type/);
  });

  it('drops runtime-only ptyId', () => {
    const result = validateWorkspaceImport({
      version: 1,
      tiles: [{
        id: 't1', type: 'terminal', x: 0, y: 0, w: 200, h: 200,
        cwd: '/tmp', branch: 'main', node: 'default', ptyId: 'should-be-dropped',
      }],
    });
    expect((result.tiles[0] as { ptyId?: string }).ptyId).toBeUndefined();
  });

  it('defaults missing transform to identity', () => {
    const result = validateWorkspaceImport({ version: 1, tiles: [] });
    expect(result.transform).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('clamps absurd transform values', () => {
    const result = validateTransform({ x: 999_999_999, y: -999_999_999, scale: 1_000 });
    expect(result.x).toBe(1_000_000);
    expect(result.y).toBe(-1_000_000);
    expect(result.scale).toBe(10);
  });

  it('accepts NaN-like values by normalising them to zero', () => {
    const result = validateTransform({ x: NaN, y: Infinity, scale: -Infinity });
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.scale).toBe(1);
  });
});

describe('validateTile — per-type', () => {
  it('rejects unknown tile type', () => {
    expect(() => validateTile({ id: 'x', type: 'mystery', x: 0, y: 0, w: 100, h: 100 }))
      .toThrow(/Unknown tile type/);
  });

  it('rejects NaN/Infinity coordinates', () => {
    expect(() => validateTile({ id: 'x', type: 'note', x: NaN, y: 0, w: 100, h: 100, content: '' }))
      .toThrow(/finite number/);
    expect(() => validateTile({ id: 'x', type: 'note', x: 0, y: Infinity, w: 100, h: 100, content: '' }))
      .toThrow(/finite number/);
  });

  it('rejects tile smaller than minimum dimensions', () => {
    expect(() => validateTile({ id: 'x', type: 'note', x: 0, y: 0, w: 10, h: 100, content: '' }))
      .toThrow(/out of range/);
  });

  it('rejects tile larger than max dimensions', () => {
    expect(() => validateTile({ id: 'x', type: 'note', x: 0, y: 0, w: 100, h: 99_999, content: '' }))
      .toThrow(/out of range/);
  });

  it('validates agent status + agent type', () => {
    const base = { id: 'x', type: 'agent', x: 0, y: 0, w: 400, h: 300, agent: 'claude', model: 'sonnet', effort: 'default', mode: 'chat', version: '1', cwd: '/tmp', branch: 'main', status: 'idle', elapsed: 0 };
    expect(() => validateTile({ ...base, agent: 'bogus' })).toThrow(/Bad agent/);
    expect(() => validateTile({ ...base, status: 'asleep' })).toThrow(/Bad status/);
    expect(validateTile(base).type).toBe('agent');
  });

  it('rejects dangerous browser URL schemes', () => {
    expect(() => validateTile({ id: 'b', type: 'browser', x: 0, y: 0, w: 200, h: 200, url: 'javascript:alert(1)' }))
      .toThrow(/Unsafe browser URL/);
    expect(() => validateTile({ id: 'b', type: 'browser', x: 0, y: 0, w: 200, h: 200, url: 'file:///etc/passwd' }))
      .toThrow(/Unsafe browser URL/);
    expect(validateTile({ id: 'b', type: 'browser', x: 0, y: 0, w: 200, h: 200, url: 'https://example.com' }).type).toBe('browser');
  });

  it('validates runner status', () => {
    const base = { id: 'r', type: 'runner', x: 0, y: 0, w: 400, h: 300, command: 'echo hi', cwd: '/tmp' };
    expect(() => validateTile({ ...base, status: 'exploding' })).toThrow(/Bad runner status/);
    expect(validateTile({ ...base, status: 'pass' }).type).toBe('runner');
  });

  it('validates diff mode', () => {
    const base = { id: 'd', type: 'diff', x: 0, y: 0, w: 400, h: 300 };
    expect(() => validateTile({ ...base, mode: 'nope' })).toThrow(/Bad diff mode/);
    expect(validateTile({ ...base, mode: 'compare' }).type).toBe('diff');
  });

  it('validates ssh port range', () => {
    const base = { id: 's', type: 'ssh', x: 0, y: 0, w: 400, h: 300, host: 'example.com', user: 'root' };
    expect(() => validateTile({ ...base, port: 0 })).toThrow(/out of range/);
    expect(() => validateTile({ ...base, port: 70000 })).toThrow(/out of range/);
    expect(validateTile({ ...base, port: 2222 }).type).toBe('ssh');
  });

  it('allows path-style strings anywhere on disk (no location filtering)', () => {
    // The import validator length-caps strings but should never reject based
    // on where a path points. The OS/filesystem layer enforces permissions.
    const t = validateTile({
      id: 'e', type: 'editor', x: 0, y: 0, w: 400, h: 300,
      filePath: 'Z:\\some\\deep\\network\\share\\file.txt', language: 'text',
    });
    expect((t as { filePath: string }).filePath).toContain('network');
  });
});

describe('validateWire', () => {
  const tileIds = new Set(['a', 'b']);

  it('accepts a well-formed wire', () => {
    const w = validateWire({
      id: 'w1', fromTile: 'a', toTile: 'b',
      fromPort: 'output', toPort: 'input',
      wireType: 'context-pipe', active: false,
    }, tileIds);
    expect(w.wireType).toBe('context-pipe');
  });

  it('rejects unknown wire type', () => {
    expect(() => validateWire({
      id: 'w1', fromTile: 'a', toTile: 'b',
      fromPort: 'output', toPort: 'input',
      wireType: 'teleport', active: false,
    }, tileIds)).toThrow(/Unknown wire type/);
  });

  it('rejects dangling wire endpoints', () => {
    expect(() => validateWire({
      id: 'w1', fromTile: 'a', toTile: 'ghost',
      fromPort: 'output', toPort: 'input',
      wireType: 'context-pipe', active: false,
    }, tileIds)).toThrow(/missing tile/);
  });

  it('rejects bad ports', () => {
    expect(() => validateWire({
      id: 'w1', fromTile: 'a', toTile: 'b',
      fromPort: 'spigot', toPort: 'input',
      wireType: 'context-pipe', active: false,
    }, tileIds)).toThrow(/fromPort/);
  });
});
