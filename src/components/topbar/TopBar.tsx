import { useState, useEffect, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTemplateStore, type TileTemplate } from '@/stores/templateStore';
import { colors, spacing, typography, glass, radius, motion, tileColors, fonts, alpha } from '@/design/tokens';
import type { Project, TileType, Tile } from '@/types';

interface TopBarProps {
  project: Project | undefined;
  onAddTile: (type: TileType) => void;
  onAddFromTemplate: (template: TileTemplate) => void;
  onOpenPalette: () => void;
}

export function TopBar({ project, onAddFromTemplate, onOpenPalette }: TopBarProps) {
  const templates = useTemplateStore(s => s.templates);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const appWindow = getCurrentWindow();

  // Group templates into ordered sections
  const sectionOrder: { key: string; label: string; types: string[] }[] = [
    { key: 'core', label: 'Core', types: ['terminal', 'agent', 'runner'] },
    { key: 'content', label: 'Content', types: ['editor', 'diff', 'note', 'todo', 'kanban'] },
    { key: 'panels', label: 'Panels', types: ['filetree', 'browser', 'git'] },
    { key: 'infra', label: 'Infrastructure', types: ['ssh', 'docker'] },
  ];

  const sections = sectionOrder.map(sec => ({
    ...sec,
    items: templates.filter(t => sec.types.includes(t.category)),
  })).filter(sec => sec.items.length > 0);

  return (
    <div
      data-tauri-drag-region
      style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${spacing.md}`,
        background: colors.surfaceLowest,
        borderBottom: `1px solid ${colors.outlineGhost}`,
        gap: spacing.md,
        flexShrink: 0,
        // @ts-expect-error webkit property
        WebkitAppRegion: 'drag',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: spacing.sm, flex: 1 }}>
        <span style={{ ...typography.titleMd, color: colors.onSurface }}>
          {project?.name || 'TerminalX'}
        </span>
        {project?.description && (
          <span style={{ ...typography.labelSm, color: colors.secondary }}>
            {project.description}
          </span>
        )}
      </div>

      {/* Add tile from template */}
      <div ref={dropdownRef} style={{ position: 'relative', // @ts-expect-error webkit
        WebkitAppRegion: 'no-drag' }}>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          style={{
            height: 28, padding: `0 ${spacing.sm}`,
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'var(--tx-outline-ghost)',
            border: `1px solid ${colors.outlineGhost}`,
            borderRadius: radius.md, color: colors.onSurfaceVariant,
            ...typography.labelSm, cursor: 'pointer', transition: `all ${motion.hover}`,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--tx-outline-variant)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--tx-outline-ghost)'; }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Add Tile
        </button>

        {dropdownOpen && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6,
            ...glass,
            padding: '6px',
            minWidth: 260,
            maxHeight: 480,
            overflowY: 'auto',
            zIndex: 100,
          }}>
            {sections.map((sec, si) => (
              <div key={sec.key}>
                {si > 0 && (
                  <div style={{
                    height: 1,
                    background: colors.outlineGhost,
                    margin: '6px 8px',
                  }} />
                )}
                <div style={{
                  ...typography.labelSm,
                  color: colors.secondary,
                  padding: '6px 10px 4px',
                  textTransform: 'uppercase',
                  fontSize: '0.5625rem',
                  letterSpacing: '0.1em',
                  fontWeight: 600,
                }}>
                  {sec.label}
                </div>
                {sec.items.map(t => (
                  <button
                    key={t.id}
                    onClick={() => { onAddFromTemplate(t); setDropdownOpen(false); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '7px 10px',
                      background: 'none',
                      border: 'none',
                      borderRadius: radius.sm,
                      color: colors.onSurfaceVariant,
                      cursor: 'pointer',
                      transition: `background ${motion.hover}`,
                      textAlign: 'left',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 6); }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
                  >
                    <div style={{
                      width: 7,
                      height: 7,
                      borderRadius: radius.full,
                      background: tileColors[t.category] || colors.primary,
                      flexShrink: 0,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        ...typography.labelMd,
                        fontSize: '0.8125rem',
                        color: colors.onSurface,
                        lineHeight: 1.3,
                      }}>
                        {t.name}
                      </div>
                      {t.description && (
                        <div style={{
                          ...typography.labelSm,
                          fontSize: '0.625rem',
                          color: colors.secondary,
                          lineHeight: 1.3,
                          marginTop: 1,
                        }}>
                          {t.description}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Layout buttons */}
      <SaveLayoutButton />
      <DefaultLayoutButton />

      {/* Palette shortcut */}
      <button
        onClick={onOpenPalette}
        // @ts-expect-error webkit
        style={{ WebkitAppRegion: 'no-drag', height: 28, padding: `0 ${spacing.sm}`, display: 'flex', alignItems: 'center', gap: 4, background: 'var(--tx-outline-ghost)', border: `1px solid ${colors.outlineGhost}`, borderRadius: radius.md, color: colors.secondary, ...typography.labelSm, cursor: 'pointer', transition: `all ${motion.hover}`, fontFamily: fonts.mono }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--tx-outline-variant)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--tx-outline-ghost)'; }}
      >
        Ctrl+K
      </button>

      {/* Local time */}
      <LocalClock />

      {/* Window controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        // @ts-expect-error webkit
        WebkitAppRegion: 'no-drag',
      }}>
        <button onPointerDown={e => e.stopPropagation()} onClick={() => appWindow.minimize()} style={windowBtnStyle} onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }} onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>
          <span style={{ width: 8, height: 1.5, background: 'var(--tx-bg)', borderRadius: 1, display: 'block' }} />
        </button>
        <button onPointerDown={e => e.stopPropagation()} onClick={() => appWindow.toggleMaximize()} style={windowBtnStyle} onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }} onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>□</button>
        <button onPointerDown={e => e.stopPropagation()} onClick={() => appWindow.close()} style={windowBtnStyle} onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }} onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>✕</button>
      </div>
    </div>
  );
}

function LocalClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{
      ...typography.labelSm, color: colors.secondary, fontFamily: fonts.mono,
      // @ts-expect-error webkit
      WebkitAppRegion: 'no-drag',
    }}>
      {time}
    </span>
  );
}

function SaveLayoutButton() {
  const handleSave = useCallback(() => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    if (!pid) return;
    const layout = {
      tiles: (store.tiles[pid] || []).map(t => {
        // Strip runtime state (ptyId, status, etc.) — keep position + config
        const { ...rest } = t as unknown as Record<string, unknown>;
        delete rest.ptyId;
        return rest;
      }),
      transform: store.transforms[pid] || { x: 0, y: 0, scale: 1 },
    };
    localStorage.setItem(`tx-saved-layout-${pid}`, JSON.stringify(layout));
    import('@/stores/toastStore').then(({ useToastStore }) => {
      useToastStore.getState().addToast('Layout saved', 'success');
    });
  }, []);

  return (
    <button
      onClick={handleSave}
      title="Save current layout"
      style={{
        // @ts-expect-error webkit property
        WebkitAppRegion: 'no-drag',
        height: 28, padding: `0 ${spacing.sm}`,
        display: 'flex', alignItems: 'center', gap: 5,
        background: 'var(--tx-outline-ghost)',
        border: `1px solid ${colors.outlineGhost}`,
        borderRadius: radius.md, color: colors.onSurfaceVariant,
        ...typography.labelSm, cursor: 'pointer', transition: `all ${motion.hover}`,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--tx-outline-variant)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--tx-outline-ghost)'; }}
    >
      Save
    </button>
  );
}

function DefaultLayoutButton() {
  const handleClick = useCallback(() => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    const project = useProjectStore.getState().projects.find(p => p.id === pid);
    const cwd = project?.cwd || '~';

    // Clear existing tiles
    const existing = store.tiles[pid] || [];
    for (const t of existing) store.removeTile(t.id);

    // Try restoring a saved layout first
    try {
      const raw = localStorage.getItem(`tx-saved-layout-${pid}`);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.tiles && saved.tiles.length > 0) {
          store.setTransform(saved.transform || { x: 0, y: 0, scale: 1 });
          for (const t of saved.tiles) {
            store.addTile({ ...t, id: crypto.randomUUID(), ptyId: undefined } as Tile);
          }
          return;
        }
      }
    } catch { /* fall through to default */ }

    // Layout dimensions
    const GAP = 16;
    const fileW = 260, termW = 560, sideW = 300;
    const topH = 340, botH = 340;
    const totalW = fileW + GAP + termW + GAP + sideW;
    const totalH = topH + GAP + botH;

    // Center layout in the user's viewport
    // Account for sidebar (56px) and topbar (44px) + statusbar (28px)
    const viewW = window.innerWidth - 56;
    const viewH = window.innerHeight - 44 - 28;
    const padX = Math.max(GAP, Math.round((viewW - totalW) / 2));
    const padY = Math.max(GAP, Math.round((viewH - totalH) / 2));

    const tiles: Tile[] = [
      { id: crypto.randomUUID(), type: 'filetree', title: 'Files', x: padX, y: padY, w: fileW, h: topH + GAP + botH, rootPath: cwd, expandedPaths: [] } as Tile,
      { id: crypto.randomUUID(), type: 'terminal', title: 'Terminal', x: padX + fileW + GAP, y: padY, w: termW, h: topH, cwd, branch: '', node: '', splits: [] } as Tile,
      { id: crypto.randomUUID(), type: 'agent', title: 'Agent', x: padX + fileW + GAP, y: padY + topH + GAP, w: termW, h: botH, agent: 'claude', model: 'opus-4', effort: 'high', mode: 'code', version: '', cwd, branch: '', status: 'idle', elapsed: 0 } as Tile,
      { id: crypto.randomUUID(), type: 'todo', title: 'Tasks', x: padX + fileW + GAP + termW + GAP, y: padY, w: sideW, h: topH, items: [] } as Tile,
      { id: crypto.randomUUID(), type: 'git', title: 'Git', x: padX + fileW + GAP + termW + GAP, y: padY + topH + GAP, w: sideW, h: botH, repoPath: cwd } as Tile,
    ];

    // Reset transform first so tile positions map 1:1 to screen
    store.setTransform({ x: 0, y: 0, scale: 1 });
    for (const t of tiles) store.addTile(t);
  }, []);

  return (
    <button
      onClick={handleClick}
      title="Apply default workspace layout"
      style={{
        // @ts-expect-error webkit property
        WebkitAppRegion: 'no-drag',
        height: 28, padding: `0 ${spacing.sm}`,
        display: 'flex', alignItems: 'center', gap: 5,
        background: 'var(--tx-outline-ghost)',
        border: `1px solid ${colors.outlineGhost}`,
        borderRadius: radius.md, color: colors.onSurfaceVariant,
        ...typography.labelSm, cursor: 'pointer', transition: `all ${motion.hover}`,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--tx-outline-variant)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--tx-outline-ghost)'; }}
    >
      <span style={{ fontSize: 11, lineHeight: 1 }}>&#9638;</span> Layout
    </button>
  );
}

const windowBtnStyle: React.CSSProperties = {
  width: 20, height: 20, borderRadius: '50%',
  background: 'var(--tx-accent)', border: 'none',
  color: 'var(--tx-bg)', fontSize: 10, fontWeight: 700,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', opacity: 0.7, transition: 'opacity 150ms ease', padding: 0,
  lineHeight: 1,
};
