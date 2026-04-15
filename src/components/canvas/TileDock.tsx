import { useState, useEffect, useRef } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTemplateStore, type TileTemplate } from '@/stores/templateStore';
import { screenToCanvas } from '@/utils/layout';
import { colors, radius, glass, motion, tileColors, fonts, spacing, typography, alpha } from '@/design/tokens';
import type { TileType, Tile } from '@/types';

// All tile types available for the dock. Order here is the default
// order; users can hide/reorder via the ⚙ customize popover.
const ALL_DOCK_ITEMS: { type: TileType; label: string }[] = [
  { type: 'terminal', label: 'Terminal' },
  { type: 'agent', label: 'Agent' },
  { type: 'runner', label: 'Runner' },
  { type: 'editor', label: 'Editor' },
  { type: 'diff', label: 'Diff' },
  { type: 'note', label: 'Note' },
  { type: 'todo', label: 'Todo' },
  { type: 'kanban', label: 'Kanban' },
  { type: 'filetree', label: 'Files' },
  { type: 'browser', label: 'Browser' },
  { type: 'git', label: 'Git' },
  { type: 'ssh', label: 'SSH' },
  { type: 'docker', label: 'Docker' },
  { type: 'usage', label: 'Usage' },
];

// Dock entries are either a base tile type ("Agent", "Terminal" — uses
// type-level defaults) or a specific template ID ("Codex", "Gemini",
// "npm test runner" — uses the template's saved config).
export type DockEntry =
  | { kind: 'type'; type: TileType }
  | { kind: 'template'; templateId: string };

const DEFAULT_ORDER: DockEntry[] = ALL_DOCK_ITEMS.map(i => ({ kind: 'type', type: i.type }));
const STORAGE_KEY = 'tx-dock-items';

function loadDockOrder(): DockEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ORDER;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_ORDER;
    const known = new Set(ALL_DOCK_ITEMS.map(i => i.type));
    const out: DockEntry[] = [];
    for (const v of parsed) {
      // Legacy: bare string of tile type
      if (typeof v === 'string') {
        if (known.has(v as TileType)) out.push({ kind: 'type', type: v as TileType });
        continue;
      }
      if (v && typeof v === 'object') {
        if (v.kind === 'type' && known.has(v.type)) {
          out.push({ kind: 'type', type: v.type as TileType });
        } else if (v.kind === 'template' && typeof v.templateId === 'string') {
          out.push({ kind: 'template', templateId: v.templateId });
        }
      }
    }
    return out;
  } catch {
    return DEFAULT_ORDER;
  }
}

function saveDockOrder(order: DockEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  window.dispatchEvent(new CustomEvent('tx-dock-updated'));
}

function entryKey(e: DockEntry): string {
  return e.kind === 'type' ? `type:${e.type}` : `tpl:${e.templateId}`;
}

function entryEquals(a: DockEntry, b: DockEntry): boolean {
  return entryKey(a) === entryKey(b);
}

// Public helpers so other UI (TopBar Add Tile menu) can pin/unpin
// items to the dock without duplicating storage logic.
export function getDockOrder(): DockEntry[] {
  return loadDockOrder();
}

export function isInDockEntry(entry: DockEntry): boolean {
  return loadDockOrder().some(e => entryEquals(e, entry));
}

export function isTemplatePinned(templateId: string): boolean {
  return loadDockOrder().some(e => e.kind === 'template' && e.templateId === templateId);
}

export function toggleTemplatePin(templateId: string): boolean {
  const entry: DockEntry = { kind: 'template', templateId };
  const order = loadDockOrder();
  const exists = order.some(e => entryEquals(e, entry));
  const next = exists ? order.filter(e => !entryEquals(e, entry)) : [...order, entry];
  saveDockOrder(next);
  return !exists;
}

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

// Column-major spawn grid: tiles stack 3-down, then shift right.
const GRID_ROWS = 3;
const GRID_GAP = 8;
const SLOT_W = 700;
const SLOT_H = 500;

function spawnTileFromEntry(entry: DockEntry, templates: TileTemplate[]) {
  // Resolve entry → tile type + extra config to merge in
  let type: TileType;
  let extraConfig: Record<string, unknown> = {};
  if (entry.kind === 'type') {
    type = entry.type;
  } else {
    const tpl = templates.find(t => t.id === entry.templateId);
    if (!tpl) return; // template was deleted — silently skip
    type = tpl.category as TileType;
    extraConfig = (tpl.config || {}) as Record<string, unknown>;
  }

  const state = useCanvasStore.getState();
  const pid = state.activeProject;
  const project = useProjectStore.getState().projects.find(p => p.id === pid);
  const projectCwd = project?.cwd || '~';
  const transform = state.transforms[pid] || { x: 0, y: 0, scale: 1 };
  const existingTiles = state.tiles[pid] || [];
  const size = SIZES[type] || { w: 400, h: 300 };

  const anchor = screenToCanvas(24, 24, transform);
  let x = anchor.x;
  let y = anchor.y;
  for (let idx = 0; idx < 300; idx++) {
    const col = Math.floor(idx / GRID_ROWS);
    const row = idx % GRID_ROWS;
    x = anchor.x + col * (SLOT_W + GRID_GAP);
    y = anchor.y + row * (SLOT_H + GRID_GAP);
    const overlaps = existingTiles.some(t =>
      x < t.x + t.w && x + size.w > t.x &&
      y < t.y + t.h && y + size.h > t.y
    );
    if (!overlaps) break;
  }

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
    x, y,
    w: size.w, h: size.h,
    ...DEFAULTS[type],
    ...extraConfig,
    ...cwdOverrides[type],
  } as Tile);
}

// Resolve an entry → display label + dot color + tooltip, regardless
// of whether it points to a tile type or a template.
function resolveEntry(
  entry: DockEntry,
  templates: TileTemplate[],
): { label: string; color: string; tooltip: string; valid: boolean } | null {
  if (entry.kind === 'type') {
    const item = ALL_DOCK_ITEMS.find(i => i.type === entry.type);
    if (!item) return null;
    return {
      label: item.label,
      color: tileColors[entry.type] || colors.primary,
      tooltip: `New ${item.label}`,
      valid: true,
    };
  }
  const tpl = templates.find(t => t.id === entry.templateId);
  if (!tpl) {
    return {
      label: 'Missing template',
      color: colors.outlineVariant,
      tooltip: `Template "${entry.templateId}" no longer exists`,
      valid: false,
    };
  }
  return {
    label: tpl.name,
    color: tileColors[tpl.category as keyof typeof tileColors] || colors.primary,
    tooltip: tpl.description ? `${tpl.name} — ${tpl.description}` : tpl.name,
    valid: true,
  };
}

export function TileDock() {
  const [order, setOrder] = useState<DockEntry[]>(() => loadDockOrder());
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  // Mirror dragIdx in a ref so the very first dragover (which fires before
  // React commits the dragstart state update) can still preventDefault.
  // Without this the OS thinks the drop target rejects the drop and onDrop
  // never fires.
  const dragIdxRef = useRef<number | null>(null);
  const customizeRef = useRef<HTMLDivElement>(null);
  const templates = useTemplateStore(s => s.templates);

  useEffect(() => {
    if (!customizeOpen) return;
    const handler = (e: MouseEvent) => {
      if (customizeRef.current && !customizeRef.current.contains(e.target as Node)) {
        setCustomizeOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [customizeOpen]);

  // Re-load order when another component (Add Tile menu) pins/unpins an item
  useEffect(() => {
    const handler = () => setOrder(loadDockOrder());
    window.addEventListener('tx-dock-updated', handler);
    return () => window.removeEventListener('tx-dock-updated', handler);
  }, []);

  const updateOrder = (next: DockEntry[]) => {
    setOrder(next);
    saveDockOrder(next);
  };

  const visible = order.map(e => ({ entry: e, info: resolveEntry(e, templates) }))
    .filter((x): x is { entry: DockEntry; info: NonNullable<ReturnType<typeof resolveEntry>> } => x.info !== null);

  // Drag-to-reorder. Dragging a dock button computes the target slot
  // by comparing pointer x against each button's midpoint, then commits
  // on drop. dragIdx = which entry is being dragged, dropIdx = where it
  // would land (used for the live insertion indicator line).
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    if (dragIdxRef.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    const next = before ? idx : idx + 1;
    setDropIdx(prev => (prev === next ? prev : next));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const di = dragIdxRef.current;
    if (di === null || dropIdx === null) {
      dragIdxRef.current = null;
      setDragIdx(null); setDropIdx(null);
      return;
    }
    const next = [...order];
    const [moved] = next.splice(di, 1);
    let target = dropIdx;
    if (di < target) target -= 1;
    next.splice(target, 0, moved);
    updateOrder(next);
    dragIdxRef.current = null;
    setDragIdx(null); setDropIdx(null);
  };

  return (
    <div
      ref={customizeRef}
      data-canvas-overlay
      role="toolbar"
      aria-label="Tile dock — spawn new tiles"
      style={{
        position: 'absolute',
        bottom: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        ...glass,
        padding: '4px 6px 4px 10px',
        borderRadius: radius.full,
        zIndex: 50,
      }}
    >
      {visible.map(({ entry, info }, idx) => {
        const isDragging = dragIdx === idx;
        const showIndicatorBefore = dropIdx === idx && dragIdx !== null && dragIdx !== idx && dragIdx !== idx - 1;
        const showIndicatorAfter = dropIdx === idx + 1 && dragIdx !== null && dragIdx !== idx && dragIdx !== idx + 1;
        return (
          <div
            key={entryKey(entry)}
            style={{ display: 'flex', alignItems: 'center', position: 'relative' }}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDrop={handleDrop}
          >
            {showIndicatorBefore && <DropIndicator />}
            <button
              draggable
              onDragStart={(e) => {
                dragIdxRef.current = idx;
                setDragIdx(idx);
                setDropIdx(idx);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', entryKey(entry));
              }}
              onDragEnd={() => {
                dragIdxRef.current = null;
                setDragIdx(null); setDropIdx(null);
              }}
              onClick={() => {
                // Suppress click that fires after a drag
                if (dragIdx !== null) return;
                spawnTileFromEntry(entry, templates);
              }}
              title={info.tooltip}
              disabled={!info.valid}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 10px',
                borderRadius: radius.full,
                border: 'none',
                background: 'transparent',
                cursor: info.valid ? (isDragging ? 'grabbing' : 'grab') : 'not-allowed',
                transition: `background ${motion.hover}, color ${motion.hover}`,
                fontSize: '0.6875rem',
                fontFamily: fonts.mono,
                fontWeight: 500,
                letterSpacing: '0.01em',
                color: info.valid ? colors.onSurfaceVariant : alpha(colors.secondary, 40),
                opacity: !info.valid ? 0.5 : (isDragging ? 0.4 : 1),
              }}
              onMouseEnter={e => {
                if (!info.valid || isDragging) return;
                e.currentTarget.style.background = 'var(--tx-outline-variant)';
                e.currentTarget.style.color = 'var(--tx-on-surface)';
              }}
              onMouseLeave={e => {
                if (!info.valid) return;
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--tx-on-surface-variant)';
              }}
            >
              <div style={{
                width: 6, height: 6,
                borderRadius: radius.full,
                background: info.color,
                flexShrink: 0,
              }} />
              {info.label}
            </button>
            {showIndicatorAfter && <DropIndicator />}
          </div>
        );
      })}

      {visible.length > 0 && (
        <div style={{
          width: 1, height: 16,
          background: colors.outlineGhost,
          flexShrink: 0,
          margin: '0 4px',
        }} />
      )}

      <button
        onClick={() => setCustomizeOpen(o => !o)}
        title="Customize dock"
        style={{
          display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          width: 24, height: 24,
          padding: 0,
          borderRadius: radius.full,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          transition: `all ${motion.hover}`,
          color: colors.onSurfaceVariant,
          fontSize: 12,
          lineHeight: 1,
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
        ⚙
      </button>

      {customizeOpen && (
        <CustomizePanel
          order={order}
          templates={templates}
          onChange={updateOrder}
          onReset={() => updateOrder(DEFAULT_ORDER)}
        />
      )}
    </div>
  );
}

function CustomizePanel({
  order, templates, onChange, onReset,
}: {
  order: DockEntry[];
  templates: TileTemplate[];
  onChange: (next: DockEntry[]) => void;
  onReset: () => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const dragIdxRef = useRef<number | null>(null);
  const visibleKeys = new Set(order.map(entryKey));
  // Hidden tile-type entries (templates only show in Add Tile menu)
  const hiddenTypes = ALL_DOCK_ITEMS.filter(i => !visibleKeys.has(`type:${i.type}`));

  const toggleType = (type: TileType) => {
    const entry: DockEntry = { kind: 'type', type };
    if (visibleKeys.has(entryKey(entry))) {
      onChange(order.filter(e => !entryEquals(e, entry)));
    } else {
      onChange([...order, entry]);
    }
  };

  const removeAt = (idx: number) => {
    onChange(order.filter((_, i) => i !== idx));
  };

  const move = (idx: number, delta: -1 | 1) => {
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= order.length) return;
    const next = [...order];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    onChange(next);
  };

  const handleRowDragOver = (e: React.DragEvent, idx: number) => {
    if (dragIdxRef.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const next = before ? idx : idx + 1;
    setDropIdx(prev => (prev === next ? prev : next));
  };

  const handleRowDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const di = dragIdxRef.current;
    if (di === null || dropIdx === null) {
      dragIdxRef.current = null;
      setDragIdx(null); setDropIdx(null); return;
    }
    const next = [...order];
    const [moved] = next.splice(di, 1);
    let target = dropIdx;
    if (di < target) target -= 1;
    next.splice(target, 0, moved);
    onChange(next);
    dragIdxRef.current = null;
    setDragIdx(null); setDropIdx(null);
  };

  return (
    <div style={{
      position: 'absolute',
      bottom: 'calc(100% + 8px)',
      right: 0,
      ...glass,
      padding: 6,
      minWidth: 280,
      maxHeight: 420,
      overflowY: 'auto',
      zIndex: 100,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 8px 6px',
      }}>
        <div style={{
          ...typography.labelSm,
          color: colors.secondary,
          textTransform: 'uppercase',
          fontSize: '0.5625rem',
          letterSpacing: '0.1em',
          fontWeight: 600,
        }}>
          Visible — drag to reorder
        </div>
        <button
          onClick={onReset}
          style={{
            ...typography.labelSm,
            fontSize: '0.625rem',
            color: colors.secondary,
            background: 'none', border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = colors.onSurface; }}
          onMouseLeave={e => { e.currentTarget.style.color = colors.secondary; }}
        >
          Reset
        </button>
      </div>

      {order.length === 0 && (
        <div style={{
          ...typography.labelSm, fontSize: '0.6875rem',
          color: colors.secondary,
          padding: '6px 10px',
          fontStyle: 'italic',
        }}>
          Dock is empty — add tiles below or pin templates from the Add Tile menu.
        </div>
      )}

      {order.map((entry, idx) => {
        const info = resolveEntry(entry, templates);
        if (!info) return null;
        const isDragging = dragIdx === idx;
        const showLineBefore = dropIdx === idx && dragIdx !== null && dragIdx !== idx && dragIdx !== idx - 1;
        const showLineAfter = dropIdx === idx + 1 && idx === order.length - 1 && dragIdx !== null && dragIdx !== idx;
        return (
          <div key={entryKey(entry)}>
            {showLineBefore && <RowDropLine />}
            <div
              draggable
              onDragStart={(e) => {
                dragIdxRef.current = idx;
                setDragIdx(idx);
                setDropIdx(idx);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', entryKey(entry));
              }}
              onDragOver={(e) => handleRowDragOver(e, idx)}
              onDrop={handleRowDrop}
              onDragEnd={() => {
                dragIdxRef.current = null;
                setDragIdx(null); setDropIdx(null);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 6px',
                borderRadius: radius.sm,
                transition: `background ${motion.hover}`,
                cursor: isDragging ? 'grabbing' : 'grab',
                opacity: isDragging ? 0.4 : 1,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 4); }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              <span style={{
                color: colors.outlineVariant, fontSize: 11, lineHeight: 1,
                userSelect: 'none', flexShrink: 0,
              }}>⋮⋮</span>
              <div style={{
                width: 7, height: 7, borderRadius: radius.full,
                background: info.color,
                flexShrink: 0,
              }} />
              <div style={{
                flex: 1, minWidth: 0,
                ...typography.labelMd, fontSize: '0.8125rem',
                color: info.valid ? colors.onSurface : colors.secondary,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {info.label}
                {entry.kind === 'template' && (
                  <span style={{
                    ...typography.labelSm, fontSize: '0.5625rem',
                    color: colors.secondary,
                    marginLeft: 6,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                  }}>
                    template
                  </span>
                )}
              </div>
              <button onClick={() => move(idx, -1)} disabled={idx === 0} title="Move up" style={iconBtnStyle(idx === 0)}>▲</button>
              <button onClick={() => move(idx, 1)} disabled={idx === order.length - 1} title="Move down" style={iconBtnStyle(idx === order.length - 1)}>▼</button>
              <button
                onClick={() => removeAt(idx)}
                title="Remove from dock"
                style={iconBtnStyle(false)}
                onMouseEnter={e => { e.currentTarget.style.color = colors.red; }}
                onMouseLeave={e => { e.currentTarget.style.color = colors.secondary; }}
              >
                ✕
              </button>
            </div>
            {showLineAfter && <RowDropLine />}
          </div>
        );
      })}

      {hiddenTypes.length > 0 && (
        <>
          <div style={{ height: 1, background: colors.outlineGhost, margin: '6px 8px' }} />
          <div style={{
            ...typography.labelSm,
            color: colors.secondary,
            padding: '4px 8px 6px',
            textTransform: 'uppercase',
            fontSize: '0.5625rem',
            letterSpacing: '0.1em',
            fontWeight: 600,
          }}>
            Hidden tile types — click to add
          </div>
          {hiddenTypes.map(item => (
            <button
              key={item.type}
              onClick={() => toggleType(item.type)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%',
                padding: '6px 10px',
                background: 'none', border: 'none',
                borderRadius: radius.sm,
                color: colors.secondary,
                cursor: 'pointer', textAlign: 'left',
                transition: `background ${motion.hover}`,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 6); }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              <div style={{
                width: 7, height: 7, borderRadius: radius.full,
                background: tileColors[item.type] || colors.primary,
                flexShrink: 0,
              }} />
              <div style={{ flex: 1, ...typography.labelMd, fontSize: '0.8125rem' }}>
                {item.label}
              </div>
              <span style={{ fontSize: 12, color: colors.secondary }}>＋</span>
            </button>
          ))}
        </>
      )}

      <div style={{
        ...typography.labelSm, fontSize: '0.625rem',
        color: colors.secondary,
        padding: `${spacing.xs} ${spacing.sm} 2px`,
        fontStyle: 'italic',
      }}>
        Pin specific configs (Codex, Gemini, etc.) by clicking ★ in the Add Tile menu.
      </div>
    </div>
  );
}

function RowDropLine() {
  return (
    <div style={{
      height: 2,
      background: colors.primary,
      borderRadius: 1,
      margin: '2px 6px',
      boxShadow: `0 0 6px ${alpha(colors.primary, 60)}`,
    }} />
  );
}

function DropIndicator() {
  return (
    <div style={{
      width: 2,
      height: 22,
      background: colors.primary,
      borderRadius: 1,
      flexShrink: 0,
      margin: '0 1px',
      boxShadow: `0 0 6px ${alpha(colors.primary, 60)}`,
    }} />
  );
}

function iconBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 22, height: 22,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', borderRadius: radius.sm,
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? alpha(colors.secondary, 30) : colors.secondary,
    fontSize: 10, lineHeight: 1,
    transition: `color ${motion.hover}`,
    flexShrink: 0,
    padding: 0,
  };
}
