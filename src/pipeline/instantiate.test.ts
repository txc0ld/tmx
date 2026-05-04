import { describe, it, expect } from 'vitest';
import { instantiatePipelineTemplate } from './instantiate';
import { helloWorldTemplate } from './templates';

describe('instantiatePipelineTemplate', () => {
  it('produces one tile per template tile + offsets by origin', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r1', originX: 100, originY: 200 });
    expect(out.tiles.length).toBe(tpl.tiles.length);
    const planner = out.tiles.find(t => t.title?.startsWith('Planner'));
    expect(planner?.x).toBe(100);
    expect(planner?.y).toBe(200);
  });

  it('binds the controller tile to the runId', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r-xyz', originX: 0, originY: 0 });
    const ctrl = out.tiles.find(t => t.type === 'pipeline-controller');
    expect(ctrl).toBeDefined();
    expect((ctrl as { runId: string }).runId).toBe('r-xyz');
  });

  it('produces one wire per template wire with resolved tile ids', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r1', originX: 0, originY: 0 });
    expect(out.wires.length).toBe(tpl.wires.length);
    for (const w of out.wires) {
      expect(out.tiles.some(t => t.id === w.fromTile)).toBe(true);
      expect(out.tiles.some(t => t.id === w.toTile)).toBe(true);
    }
  });

  it('returns role→tileId map for controller binding', () => {
    const tpl = helloWorldTemplate();
    const out = instantiatePipelineTemplate(tpl, { runId: 'r1', originX: 0, originY: 0 });
    expect(out.roleToTileId.planner).toBeDefined();
    expect(out.roleToTileId.builder).toBeDefined();
    expect(out.roleToTileId.reviewer).toBeDefined();
    expect(out.roleToTileId.controller).toBeDefined();
  });
});
