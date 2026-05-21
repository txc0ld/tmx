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
    // One-shot agent tiles (e.g. Reviewer in the Anthropic Trio template)
    // run via `agent_run_oneshot` headlessly — no live tile on the canvas.
    // Skip both the tile and the roleToTileId entry so wires referencing
    // this role gracefully degrade through the existing missing-endpoint
    // skip path below. The matching dispatcher
    // (`single-reviewer-dispatcher.ts`) fires the one-shot on transition
    // into `reviewing`.
    const cfgUnknown = spec.config as { oneshot?: unknown };
    if (spec.type === 'agent' && cfgUnknown.oneshot === true) {
      continue;
    }

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
      // Tiles for the four real pipeline roles get a back-pointer to the run
      // + the role string so the global PTY router (App.tsx) can forward
      // their output into `ingestPtyChunk`. Controller / unknown roles skip
      // the binding — they don't emit sentinels.
      const isPipelineRoleTile =
        spec.role === 'planner' || spec.role === 'builder' || spec.role === 'reviewer';
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
        ...(isPipelineRoleTile
          ? { pipelineRunId: input.runId, pipelineRole: spec.role as 'planner' | 'builder' | 'reviewer' }
          : {}),
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
