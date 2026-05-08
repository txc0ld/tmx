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

  it('skips agent tiles with config.oneshot === true (no live tile)', () => {
    // Anthropic Trio shape: reviewer has oneshot=true → skipped from tiles +
    // roleToTileId. Wires referencing reviewer (the builder→reviewer
    // agent-chain and reviewer→builder task-assign) must be dropped via
    // the existing "missing endpoint" wire skip path.
    const tpl = {
      kind: 'pipeline' as const,
      id: 'tx.test.oneshot',
      name: 'Oneshot',
      isBuiltin: false,
      tiles: [
        { role: 'planner' as const, type: 'agent' as const,
          position: { x: 0, y: 0, w: 100, h: 100 }, config: {} },
        { role: 'builder' as const, type: 'agent' as const,
          position: { x: 200, y: 0, w: 100, h: 100 }, config: {} },
        { role: 'reviewer' as const, type: 'agent' as const,
          position: { x: 400, y: 0, w: 100, h: 100 }, config: { oneshot: true } },
        { role: 'controller' as const, type: 'pipeline-controller' as const,
          position: { x: 0, y: 200, w: 500, h: 100 }, config: {} },
      ],
      wires: [
        { fromRole: 'planner' as const, toRole: 'builder' as const, wireType: 'agent-chain' as const },
        { fromRole: 'builder' as const, toRole: 'reviewer' as const, wireType: 'agent-chain' as const },
        { fromRole: 'reviewer' as const, toRole: 'builder' as const, wireType: 'task-assign' as const },
      ],
      pipeline: {
        retryBudget: { reviewerReject: 3, ciFail: 3 },
        dualReviewer: false,
        requireMergeGate: true,
        skillBindings: {},
      },
    };
    const out = instantiatePipelineTemplate(tpl, { runId: 'r1', originX: 0, originY: 0 });
    // Reviewer tile dropped — only planner + builder agent tiles + controller.
    expect(out.tiles.length).toBe(3);
    expect(out.tiles.find(t => t.title === 'Reviewer')).toBeUndefined();
    expect(out.roleToTileId.reviewer).toBeUndefined();
    expect(out.roleToTileId.planner).toBeDefined();
    expect(out.roleToTileId.builder).toBeDefined();
    expect(out.roleToTileId.controller).toBeDefined();
    // Only the planner→builder wire survives; the two reviewer wires drop.
    expect(out.wires.length).toBe(1);
    expect(out.wires[0].fromTile).toBe(out.roleToTileId.planner);
    expect(out.wires[0].toTile).toBe(out.roleToTileId.builder);
  });

  it('skips wires whose fromRole or toRole has no tile', () => {
    // Hand-rolled template that references a 'reviewer-codex' role with no matching tile.
    const tpl = {
      kind: 'pipeline' as const,
      id: 'tx.test.partial',
      name: 'Partial',
      isBuiltin: false,
      tiles: [
        { role: 'planner' as const, type: 'agent' as const,
          position: { x: 0, y: 0, w: 100, h: 100 }, config: {} },
        { role: 'controller' as const, type: 'pipeline-controller' as const,
          position: { x: 0, y: 200, w: 100, h: 100 }, config: {} },
      ],
      wires: [
        { fromRole: 'planner' as const, toRole: 'reviewer-codex' as const, wireType: 'agent-chain' as const },
        { fromRole: 'reviewer' as const, toRole: 'planner' as const, wireType: 'task-assign' as const },
      ],
      pipeline: {
        retryBudget: { reviewerReject: 3, ciFail: 3 },
        dualReviewer: false,
        requireMergeGate: true,
        skillBindings: {},
      },
    };
    const out = instantiatePipelineTemplate(tpl, { runId: 'r1', originX: 0, originY: 0 });
    // Both wires reference at least one absent role → both should be skipped.
    expect(out.wires.length).toBe(0);
    // Tiles still produced for the two declared roles.
    expect(out.tiles.length).toBe(2);
  });
});
