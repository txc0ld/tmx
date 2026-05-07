import type { Tile, Wire, PipelineRole, AgentTile, PipelineControllerTile } from '@/types';
import type { PipelineTemplate } from '@/stores/templateStore';

interface InstantiateInput {
  runId: string;
  originX: number;
  originY: number;
}

interface InstantiateOutput {
  tiles: Tile[];
  wires: Wire[];
  roleToTileId: Partial<Record<PipelineRole, string>>;
}

function uid(): string {
  return crypto.randomUUID();
}

const ROLE_TITLES: Record<PipelineRole, string> = {
  planner: 'Planner',
  builder: 'Builder',
  reviewer: 'Reviewer',
  'reviewer-codex': 'Reviewer (Codex)',
  'red-team': 'Red Team',
  controller: 'Controller',
};

export function instantiatePipelineTemplate(
  template: PipelineTemplate,
  input: InstantiateInput,
): InstantiateOutput {
  const roleToTileId: Partial<Record<PipelineRole, string>> = {};
  const tiles: Tile[] = [];

  for (const spec of template.tiles) {
    const id = uid();
    roleToTileId[spec.role] = id;

    const base = {
      id,
      x: input.originX + spec.position.x,
      y: input.originY + spec.position.y,
      w: spec.position.w,
      h: spec.position.h,
      title: ROLE_TITLES[spec.role],
    };

    if (spec.type === 'pipeline-controller') {
      const tile: PipelineControllerTile = { ...base, type: 'pipeline-controller', runId: input.runId };
      tiles.push(tile);
    } else if (spec.type === 'agent') {
      const cfg = spec.config as Partial<AgentTile>;
      const tile: AgentTile = {
        ...base,
        type: 'agent',
        agent: (cfg.agent as AgentTile['agent']) ?? 'claude',
        model: (cfg.model as string) ?? 'opus-4-7',
        effort: (cfg.effort as string) ?? '',
        mode: (cfg.mode as string) ?? '',
        version: (cfg.version as string) ?? '',
        cwd: (cfg.cwd as string) ?? '',
        branch: (cfg.branch as string) ?? '',
        status: 'idle',
        elapsed: 0,
      };
      tiles.push(tile);
    } else {
      console.warn(`[pipeline] unsupported tile type in PipelineTemplate: ${spec.type}`);
    }
  }

  const wires: Wire[] = [];
  for (const w of template.wires) {
    const fromTile = roleToTileId[w.fromRole];
    const toTile = roleToTileId[w.toRole];
    if (!fromTile || !toTile) continue;
    wires.push({
      id: uid(),
      fromTile,
      fromPort: 'output',
      toTile,
      toPort: 'input',
      wireType: w.wireType,
      active: false,
    });
  }

  return { tiles, wires, roleToTileId };
}
