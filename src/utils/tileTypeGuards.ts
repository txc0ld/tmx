import type {
  Tile, AgentTile, TerminalTile, RunnerTile, SshTile, DockerTile,
} from '@/types';

/**
 * Type guards for tile-variant narrowing. Kept tight on purpose — we only
 * export what we actually use, and add more on demand. An earlier version
 * exported every variant as a preemptive set, but most were never imported
 * and became dead exports.
 */
export const isAgentTile = (t: Tile): t is AgentTile => t.type === 'agent';

/**
 * Tiles that own a PTY. Use this in wire / pipe logic to find connected-
 * via-pty sources without hand-rolling `'ptyId' in t && typeof t.ptyId
 * === 'string'` at every call site.
 */
export type PtyOwningTile = AgentTile | TerminalTile | RunnerTile | SshTile | DockerTile;

export function hasPty(t: Tile): t is PtyOwningTile & { ptyId: string } {
  return 'ptyId' in t && typeof (t as { ptyId?: unknown }).ptyId === 'string' && !!(t as { ptyId?: string }).ptyId;
}
