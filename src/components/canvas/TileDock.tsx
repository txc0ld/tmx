import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { screenToCanvas } from '@/utils/layout';
import { colors, radius, glass, motion, tileColors, fonts } from '@/design/tokens';
import type { TileType, Tile } from '@/types';

// Grouped by function — dividers rendered between groups
const DOCK_GROUPS: { type: TileType; label: string }[][] = [
  // Core
  [
    { type: 'terminal', label: 'Terminal' },
    { type: 'agent', label: 'Agent' },
    { type: 'runner', label: 'Runner' },
  ],
  // Content
  [
    { type: 'editor', label: 'Editor' },
    { type: 'diff', label: 'Diff' },
    { type: 'note', label: 'Note' },
    { type: 'todo', label: 'Todo' },
    { type: 'kanban', label: 'Kanban' },
  ],
  // Panels
  [
    { type: 'filetree', label: 'Files' },
    { type: 'browser', label: 'Browser' },
    { type: 'git', label: 'Git' },
  ],
  // Infra
  [
    { type: 'ssh', label: 'SSH' },
    { type: 'docker', label: 'Docker' },
    { type: 'usage', label: 'Usage' },
  ],
];

const SIZES: Record<string, { w: number; h: number }> = {
  terminal: { w: 600, h: 400 }, agent: { w: 600, h: 450 }, browser: { w: 600, h: 500 },
  editor: { w: 500, h: 400 }, diff: { w: 500, h: 400 }, todo: { w: 320, h: 400 },
  note: { w: 320, h: 300 }, kanban: { w: 700, h: 500 }, filetree: { w: 280, h: 500 },
  group: { w: 400, h: 300 }, runner: { w: 600, h: 400 }, ssh: { w: 500, h: 400 },
  docker: { w: 500, h: 450 },
  git: { w: 350, h: 500 },
  usage: { w: 320, h: 480 },
};

const DEFAULTS: Record<string, Record<string, unknown>> = {
  terminal: { cwd: '~', branch: '', node: '', splits: [] },
  agent: { agent: 'claude', model: 'opus-4', effort: 'high', mode: 'code', version: '', cwd: '~', branch: '', status: 'idle', elapsed: 0 },
  browser: { url: 'http://localhost:3000' },
  editor: { filePath: '', language: 'typescript' },
  diff: { filePath: '', hunks: [], comments: [] },
  todo: { items: [] },
  note: { content: '' },
  kanban: { columns: [] },
  filetree: { rootPath: '~', expandedPaths: [] },
  group: { label: 'Group', childTileIds: [], collapsed: false },
  runner: { command: '', cwd: '~', status: 'idle', lastOutput: '' },
  ssh: { host: '', port: 22, user: '', connected: false },
  docker: { containers: [] },
  git: { repoPath: '~' },
  usage: {},
};

function spawnTile(type: TileType) {
  const state = useCanvasStore.getState();
  const pid = state.activeProject;
  const project = useProjectStore.getState().projects.find(p => p.id === pid);
  const projectCwd = project?.cwd || '~';
  const transform = state.transforms[pid] || { x: 0, y: 0, scale: 1 };
  const existingTiles = state.tiles[pid] || [];
  const size = SIZES[type] || { w: 400, h: 300 };
  const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2, transform);

  // Find a non-overlapping position by spiraling outward
  let x = center.x - size.w / 2;
  let y = center.y - size.h / 2;
  const step = 40;
  let attempt = 0;

  while (attempt < 30) {
    const overlaps = existingTiles.some(t =>
      x < t.x + t.w && x + size.w > t.x &&
      y < t.y + t.h && y + size.h > t.y
    );
    if (!overlaps) break;
    // Cascade diagonally
    attempt++;
    x = center.x - size.w / 2 + attempt * step;
    y = center.y - size.h / 2 + attempt * step;
  }

  // Override cwd-related fields with active project's directory
  const cwdOverrides: Record<string, Record<string, unknown>> = {
    terminal: { cwd: projectCwd },
    agent: { cwd: projectCwd },
    runner: { cwd: projectCwd },
    filetree: { rootPath: projectCwd },
    git: { repoPath: projectCwd },
  };

  state.addTile({
    id: crypto.randomUUID(),
    type,
    x,
    y,
    w: size.w,
    h: size.h,
    ...DEFAULTS[type],
    ...cwdOverrides[type],
  } as Tile);
}

function Divider() {
  return (
    <div style={{
      width: 1,
      height: 16,
      background: colors.outlineGhost,
      flexShrink: 0,
      margin: '0 4px',
    }} />
  );
}

export function TileDock() {
  return (
    <div data-canvas-overlay role="toolbar" aria-label="Tile dock — spawn new tiles" style={{
      position: 'absolute',
      bottom: 12,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: 1,
      ...glass,
      padding: '4px 10px',
      borderRadius: radius.full,
      zIndex: 50,
    }}>
      {DOCK_GROUPS.map((group, gi) => (
        <div key={gi} style={{ display: 'contents' }}>
          {gi > 0 && <Divider />}
          {group.map(item => (
            <button
              key={item.type}
              onClick={() => spawnTile(item.type)}
              title={`New ${item.label}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 10px',
                borderRadius: radius.full,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                transition: `all ${motion.hover}`,
                fontSize: '0.6875rem',
                fontFamily: fonts.mono,
                fontWeight: 500,
                letterSpacing: '0.01em',
                color: colors.onSurfaceVariant,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--tx-outline-variant)';
                e.currentTarget.style.color = 'var(--tx-on-surface)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--tx-on-surface-variant)';
              }}
            >
              <div style={{
                width: 6, height: 6,
                borderRadius: radius.full,
                background: tileColors[item.type] || colors.primary,
                flexShrink: 0,
              }} />
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
