import type { TerminalSplit, Tile } from '@/types';

function stripSplitRuntimeState(split: TerminalSplit): TerminalSplit {
  return { ...split, ptyId: '' };
}

export function stripRuntimeTileState(tile: Tile): Tile {
  const next = { ...tile } as Tile & { ptyId?: string; splits?: TerminalSplit[] };
  delete next.ptyId;

  if (next.type === 'terminal' && Array.isArray(next.splits)) {
    next.splits = next.splits.map(stripSplitRuntimeState);
  }

  if (next.type === 'runner') {
    next.status = next.status === 'running' ? 'idle' : next.status;
  }

  return next as Tile;
}

export function stripRuntimeTilesState(tiles: Tile[]): Tile[] {
  return tiles.map(stripRuntimeTileState);
}
