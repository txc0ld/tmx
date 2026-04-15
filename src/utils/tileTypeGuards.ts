import type {
  Tile, AgentTile, TerminalTile, EditorTile, DiffTile, BrowserTile,
  TodoTile, KanbanTile, FileTreeTile, GroupTile, RunnerTile, SshTile,
  DockerTile, GitTile, UsageTile, NoteTile,
} from '@/types';

/**
 * Type guards for each tile variant. Replace `as unknown as AgentTile`
 * casts across the codebase — the guards narrow the union properly and
 * catch drift if a type is renamed.
 */
export const isAgentTile = (t: Tile): t is AgentTile => t.type === 'agent';
export const isTerminalTile = (t: Tile): t is TerminalTile => t.type === 'terminal';
export const isEditorTile = (t: Tile): t is EditorTile => t.type === 'editor';
export const isDiffTile = (t: Tile): t is DiffTile => t.type === 'diff';
export const isBrowserTile = (t: Tile): t is BrowserTile => t.type === 'browser';
export const isTodoTile = (t: Tile): t is TodoTile => t.type === 'todo';
export const isKanbanTile = (t: Tile): t is KanbanTile => t.type === 'kanban';
export const isFileTreeTile = (t: Tile): t is FileTreeTile => t.type === 'filetree';
export const isGroupTile = (t: Tile): t is GroupTile => t.type === 'group';
export const isRunnerTile = (t: Tile): t is RunnerTile => t.type === 'runner';
export const isSshTile = (t: Tile): t is SshTile => t.type === 'ssh';
export const isDockerTile = (t: Tile): t is DockerTile => t.type === 'docker';
export const isGitTile = (t: Tile): t is GitTile => t.type === 'git';
export const isUsageTile = (t: Tile): t is UsageTile => t.type === 'usage';
export const isNoteTile = (t: Tile): t is NoteTile => t.type === 'note';

/**
 * Tiles that own a PTY. Use this to find connected-via-pty sources when
 * wiring without rewriting `'ptyId' in t && typeof t.ptyId === 'string'`
 * at every call site.
 */
export type PtyOwningTile = AgentTile | TerminalTile | RunnerTile | SshTile | DockerTile;

export function hasPty(t: Tile): t is PtyOwningTile & { ptyId: string } {
  return 'ptyId' in t && typeof (t as { ptyId?: unknown }).ptyId === 'string' && !!(t as { ptyId?: string }).ptyId;
}
