import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTemplateStore, type TileTemplate } from '@/stores/templateStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import { colors, spacing, typography, glass, radius, motion, tileColors, fonts, alpha } from '@/design/tokens';
import { isMac, modShortcut } from '@/utils/platform';
import { isTemplatePinned, toggleTemplatePin } from '@/components/canvas/TileDock';
import { useSettingsStore } from '@/stores/settingsStore';
import { PipelineOnboardingTooltip, dismissPipelineOnboarding } from '@/components/topbar/PipelineOnboardingTooltip';
import type { Project, TileType, Tile, PipelineRun } from '@/types';

interface TopBarProps {
  project: Project | undefined;
  onAddTile: (type: TileType) => void;
  onAddFromTemplate: (template: TileTemplate) => void;
  onOpenPalette: () => void;
  onStartPipelineRun: () => void;
  onOpenRunHistory: () => void;
}

export function TopBar({ project, onAddFromTemplate, onOpenPalette, onStartPipelineRun, onOpenRunHistory }: TopBarProps) {
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
        // macOS: leave room for traffic lights on the left
        padding: isMac() ? `0 ${spacing.md} 0 80px` : `0 ${spacing.md}`,
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
                  <TemplateRow
                    key={t.id}
                    template={t}
                    onAdd={() => { onAddFromTemplate(t); setDropdownOpen(false); }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pipeline run launcher — opens StartPipelineRunModal. Disabled when
          no project is selected (the launch flow needs a cwd). When any run
          on the active project is in an `awaiting_*` gate, badges with the
          count and routes the click to focus the controller tile instead.
          The wrapping div is `position: relative` so the one-time
          onboarding tooltip can anchor below the button. */}
      <div style={{ position: 'relative', // @ts-expect-error webkit
        WebkitAppRegion: 'no-drag' }}>
        <PipelineButton
          project={project}
          onStartPipelineRun={() => { dismissPipelineOnboarding(); onStartPipelineRun(); }}
        />
        <PipelineOnboardingTooltip />
      </div>

      {/* Run history — opens the always-on register of pipeline runs for the
          active project. Disabled when there is no active project (the panel
          would have nothing to scope to). */}
      <RunHistoryButton project={project} onOpenRunHistory={onOpenRunHistory} />

      {/* Settings gear — sits to the left of layout/clear, the action group */}
      <SettingsGearButton />

      {/* Layout buttons */}
      <LayoutMenuButton />
      <ClearCanvasButton />

      {/* Palette shortcut */}
      <button
        onClick={onOpenPalette}
        // @ts-expect-error webkit
        style={{ WebkitAppRegion: 'no-drag', height: 28, padding: `0 ${spacing.sm}`, display: 'flex', alignItems: 'center', gap: 4, background: 'var(--tx-outline-ghost)', border: `1px solid ${colors.outlineGhost}`, borderRadius: radius.md, color: colors.secondary, ...typography.labelSm, cursor: 'pointer', transition: `all ${motion.hover}`, fontFamily: fonts.mono }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--tx-outline-variant)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--tx-outline-ghost)'; }}
      >
        {modShortcut('K')}
      </button>

      {/* Local time */}
      <LocalClock />

      {/* Window controls — hidden on macOS where native traffic lights are used */}
      {!isMac() && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          // @ts-expect-error webkit
          WebkitAppRegion: 'no-drag',
        }}>
          <button aria-label="Minimize window" onPointerDown={e => e.stopPropagation()} onClick={() => appWindow.minimize()} style={windowBtnStyle} onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }} onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>
            <span style={{ width: 8, height: 1.5, background: 'var(--tx-bg)', borderRadius: 1, display: 'block' }} />
          </button>
          <button aria-label="Maximize window" onPointerDown={e => e.stopPropagation()} onClick={() => appWindow.toggleMaximize()} style={windowBtnStyle} onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }} onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>□</button>
          <button aria-label="Close window" onPointerDown={e => e.stopPropagation()} onClick={() => appWindow.close()} style={windowBtnStyle} onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }} onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}>✕</button>
        </div>
      )}
    </div>
  );
}

function TemplateRow({ template, onAdd }: { template: TileTemplate; onAdd: () => void }) {
  const [pinned, setPinned] = useState(() => isTemplatePinned(template.id));

  // Keep in sync if the dock is changed elsewhere
  useEffect(() => {
    const handler = () => setPinned(isTemplatePinned(template.id));
    window.addEventListener('tx-dock-updated', handler);
    return () => window.removeEventListener('tx-dock-updated', handler);
  }, [template.id]);

  const togglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nowPinned = toggleTemplatePin(template.id);
    setPinned(nowPinned);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onAdd}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(); } }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%',
        padding: '7px 10px',
        borderRadius: radius.sm,
        color: colors.onSurfaceVariant,
        cursor: 'pointer',
        transition: `background ${motion.hover}`,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 6); }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
    >
      <div style={{
        width: 7, height: 7,
        borderRadius: radius.full,
        background: tileColors[template.category as keyof typeof tileColors] || colors.primary,
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          ...typography.labelMd,
          fontSize: '0.8125rem',
          color: colors.onSurface,
          lineHeight: 1.3,
        }}>
          {template.name}
        </div>
        {template.description && (
          <div style={{
            ...typography.labelSm,
            fontSize: '0.625rem',
            color: colors.secondary,
            lineHeight: 1.3,
            marginTop: 1,
          }}>
            {template.description}
          </div>
        )}
      </div>
      <button
        onClick={togglePin}
        title={pinned ? 'Unpin from quick-launch dock' : 'Pin to quick-launch dock'}
        style={{
          width: 22, height: 22,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', borderRadius: radius.sm,
          cursor: 'pointer',
          color: pinned ? colors.primary : colors.secondary,
          fontSize: 12, lineHeight: 1,
          transition: `color ${motion.hover}, background ${motion.hover}`,
          flexShrink: 0,
          padding: 0,
          opacity: pinned ? 1 : 0.7,
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 10);
          e.currentTarget.style.opacity = '1';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'none';
          e.currentTarget.style.opacity = pinned ? '1' : '0.7';
        }}
      >
        {pinned ? '★' : '☆'}
      </button>
    </div>
  );
}

/**
 * Pipeline button + attention badge.
 *
 * Two interaction modes by `pendingRuns.length`:
 *  - 0 pending → original behavior: clicking opens `StartPipelineRunModal`.
 *  - ≥1 pending → click focuses the most recent pending run's controller
 *    tile (so the user lands on the gate instead of starting a fresh run).
 *    If the run has no `tiles.controller`, fall back to the launch modal.
 *
 * The badge itself is a small accent-painted pill on the top-right of the
 * button with the count, lifted off the button surface via a 2px halo
 * matching the topbar background. Pulses subtly via a 2s keyframe so it
 * draws the eye without becoming distracting.
 *
 * Dependency-injected pieces (`getStore`, `getPipelineStore`) keep the
 * component testable without rendering the whole canvas. Production
 * defaults route through the live Zustand stores.
 */
export interface PipelineButtonDeps {
  /**
   * Returns a snapshot of the canvas store. Tests stub this with a fake
   * store containing `setFocusedTile` and `bringToFront` spies.
   */
  getCanvasStore?: () => Pick<ReturnType<typeof useCanvasStore.getState>, 'setFocusedTile' | 'bringToFront'>;
  /**
   * Switch the active project (cross-project pending-run focus). Tests
   * stub this with a spy; production routes through `projectStore.setActive`.
   * The badge button uses this when the most-recent pending run lives on
   * a different project — clicking from any project brings the user to
   * that project AND focuses its controller tile.
   */
  setActiveProject?: (projectId: string) => void;
}

export function PipelineButton({
  project,
  onStartPipelineRun,
  deps,
}: {
  project: Project | undefined;
  onStartPipelineRun: () => void;
  deps?: PipelineButtonDeps;
}) {
  const runs = usePipelineStore(s => s.runs);

  // Active-project pending list — the badge count reflects only the active
  // project (so the user isn't surprised by a "3" that includes projects
  // they never look at). Cross-project pending is consulted only on click.
  const pendingRuns = useMemo<PipelineRun[]>(() => {
    if (!project) return [];
    return Object.values(runs)
      .filter(r => r.projectId === project.id && r.state.startsWith('awaiting_'))
      // Most-recently started first, so a click targets the freshest gate.
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [runs, project]);

  // Cross-project pending list — used as a fallback when the active project
  // has nothing pending but another project does. Sorted newest-first so a
  // click lands on the freshest gate.
  const crossProjectPending = useMemo<PipelineRun[]>(() => {
    return Object.values(runs)
      .filter(r => r.state.startsWith('awaiting_'))
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [runs]);

  const pendingCount = pendingRuns.length;
  const hasPending = pendingCount > 0;
  // Off-project pending exists only when the active project is empty AND
  // some other project has a gate. Avoids flicker on a project with both
  // its own gates and external ones — local gates win.
  const hasOffProjectPending =
    !hasPending && project !== undefined && crossProjectPending.some(r => r.projectId !== project.id);

  const handleClick = useCallback(() => {
    if (!project) return;
    if (hasPending) {
      const target = pendingRuns[0];
      const controllerTileId = target.tiles?.controller;
      if (controllerTileId) {
        const cs = deps?.getCanvasStore?.() ?? useCanvasStore.getState();
        cs.bringToFront(controllerTileId);
        cs.setFocusedTile(controllerTileId);
        return;
      }
      // Fall through to launch modal if the controller tile is gone (e.g.
      // user closed it). Better than swallowing the click.
    } else if (crossProjectPending.length > 0) {
      // Cross-project gate exists. Switch project first so the canvas re-
      // renders with that project's tiles, THEN focus the controller. We
      // call setFocusedTile/bringToFront synchronously after setActive —
      // canvasStore reads `activeProject` from projectStore via a
      // subscription, but `bringToFront`/`setFocusedTile` operate on tile
      // ids in `zStack`/`focusedTile` which are project-scoped maps, so
      // the focus survives the project flip.
      const target = crossProjectPending[0];
      const controllerTileId = target.tiles?.controller;
      const setActive = deps?.setActiveProject ?? ((id: string) => {
        // Lazy require to avoid a top-level circular import; production
        // path runs once per click so the dynamic resolution cost is
        // negligible. Tests always inject `deps.setActiveProject`.
        useProjectStore.getState().setActive(id);
      });
      setActive(target.projectId);
      if (controllerTileId) {
        const cs = deps?.getCanvasStore?.() ?? useCanvasStore.getState();
        cs.bringToFront(controllerTileId);
        cs.setFocusedTile(controllerTileId);
      }
      return;
    }
    onStartPipelineRun();
  }, [project, hasPending, pendingRuns, crossProjectPending, onStartPipelineRun, deps]);

  const shortcutLabel = isMac() ? '⌘⇧P' : 'Ctrl+Shift+P';
  const baseTitle = project
    ? `Start a pipeline run (Plan → Build → Review) (${shortcutLabel})`
    : 'Select a project first';
  const title = hasPending
    ? `${pendingCount} run${pendingCount === 1 ? '' : 's'} need attention`
    : hasOffProjectPending
      ? 'Pipeline run awaiting attention on another project'
      : baseTitle;

  return (
    <div style={{
      // @ts-expect-error webkit
      WebkitAppRegion: 'no-drag',
      position: 'relative',
    }}>
      <button
        onClick={handleClick}
        disabled={!project}
        title={title}
        data-testid="topbar-pipeline-button"
        style={{
          height: 28,
          padding: `0 ${spacing.sm}`,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          background: project ? 'var(--tx-accent)' : 'var(--tx-outline-ghost)',
          border: `1px solid ${project ? 'var(--tx-accent)' : colors.outlineGhost}`,
          borderRadius: radius.md,
          color: project ? 'var(--tx-accent-fg, #000)' : colors.secondary,
          ...typography.labelSm,
          cursor: project ? 'pointer' : 'not-allowed',
          opacity: project ? 1 : 0.5,
          transition: `all ${motion.hover}`,
          fontWeight: 600,
        }}
        onMouseEnter={(e) => { if (project) e.currentTarget.style.filter = 'brightness(1.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.filter = ''; }}
      >
        <span style={{ fontSize: 14, lineHeight: 1 }}>▶</span> Pipeline
      </button>
      {!hasPending && hasOffProjectPending && (
        <span
          data-testid="topbar-pipeline-offproject-dot"
          aria-label="Pipeline run awaiting attention on another project"
          title="Pipeline run awaiting attention on another project"
          style={{
            position: 'absolute',
            top: -4,
            right: -4,
            width: 10,
            height: 10,
            borderRadius: 5,
            background: 'var(--tx-accent)',
            boxShadow: '0 0 0 2px var(--tx-bg)',
            pointerEvents: 'none',
            opacity: 0.7,
          }}
        />
      )}
      {hasPending && (
        <>
          <span
            data-testid="topbar-pipeline-badge"
            aria-label={`${pendingCount} pipeline run${pendingCount === 1 ? '' : 's'} awaiting input`}
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 8,
              background: 'var(--tx-accent)',
              color: 'var(--tx-accent-fg, #000)',
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '16px',
              textAlign: 'center',
              boxShadow: '0 0 0 2px var(--tx-bg)',
              pointerEvents: 'none',
              animation: 'tx-pipeline-pulse 2s ease-in-out infinite',
            }}
          >
            {pendingCount}
          </span>
          <style>{`@keyframes tx-pipeline-pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.12); }
          }`}</style>
        </>
      )}
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

// ─── Layout slots ───────────────────────────────────────────────────
// Users can save up to 5 named layout presets per project. Slot 0 is
// the built-in "Default" workspace; slots 1-5 are user slots that can
// be saved, loaded, renamed, and cleared from the dropdown.

const LAYOUT_SLOTS = 5;

type LayoutSlot = { name: string; tiles: Record<string, unknown>[]; transform: { x: number; y: number; scale: number } };

function loadSlots(pid: string): (LayoutSlot | null)[] {
  try {
    const raw = localStorage.getItem(`tx-layouts-${pid}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const arr = parsed.slice(0, LAYOUT_SLOTS);
        while (arr.length < LAYOUT_SLOTS) arr.push(null);
        return arr;
      }
    }
  } catch { /* fall through */ }
  // One-time migration from the legacy single-slot key into slot 1
  try {
    const legacy = localStorage.getItem(`tx-saved-layout-${pid}`);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (parsed?.tiles?.length) {
        const migrated: (LayoutSlot | null)[] = [
          { name: 'My Layout', tiles: parsed.tiles, transform: parsed.transform || { x: 0, y: 0, scale: 1 } },
          null, null, null, null,
        ];
        localStorage.setItem(`tx-layouts-${pid}`, JSON.stringify(migrated));
        localStorage.removeItem(`tx-saved-layout-${pid}`);
        return migrated;
      }
    }
  } catch { /* ignore */ }
  return Array(LAYOUT_SLOTS).fill(null);
}

function saveSlots(pid: string, slots: (LayoutSlot | null)[]) {
  localStorage.setItem(`tx-layouts-${pid}`, JSON.stringify(slots));
}

function applyDefaultLayout() {
  const store = useCanvasStore.getState();
  const pid = store.activeProject;
  const project = useProjectStore.getState().projects.find(p => p.id === pid);
  const cwd = project?.cwd || '~';

  const existing = store.tiles[pid] || [];
  for (const t of existing) store.removeTile(t.id);

  const GAP = 16;
  const fileW = 260, termW = 560, sideW = 300;
  const topH = 340, botH = 340;
  const totalW = fileW + GAP + termW + GAP + sideW;
  const totalH = topH + GAP + botH;

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

  store.setTransform({ x: 0, y: 0, scale: 1 });
  for (const t of tiles) store.addTile(t);
}

function LayoutMenuButton() {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<(LayoutSlot | null)[]>(() => {
    const pid = useCanvasStore.getState().activeProject;
    return pid ? loadSlots(pid) : Array(LAYOUT_SLOTS).fill(null);
  });
  const menuRef = useRef<HTMLDivElement>(null);

  // Re-load slots whenever the menu opens (project may have changed)
  useEffect(() => {
    if (!open) return;
    const pid = useCanvasStore.getState().activeProject;
    if (pid) setSlots(loadSlots(pid));
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toast = (msg: string, kind: 'success' | 'info' | 'error' = 'success') => {
    import('@/stores/toastStore').then(({ useToastStore }) => {
      useToastStore.getState().addToast(msg, kind);
    });
  };

  const saveToSlot = useCallback((idx: number) => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    if (!pid) return;
    const existing = loadSlots(pid);
    const currentName = existing[idx]?.name || '';
    const defaultName = currentName || `Layout ${idx + 1}`;
    const name = prompt(`Name this layout slot:`, defaultName);
    if (name === null) return; // cancelled
    const finalName = name.trim() || defaultName;
    const snapshot: LayoutSlot = {
      name: finalName,
      tiles: (store.tiles[pid] || []).map(t => {
        const rest = { ...t } as unknown as Record<string, unknown>;
        delete rest.ptyId;
        return rest;
      }),
      transform: store.transforms[pid] || { x: 0, y: 0, scale: 1 },
    };
    existing[idx] = snapshot;
    saveSlots(pid, existing);
    setSlots(existing);
    toast(`Saved "${finalName}" to slot ${idx + 1}`);
  }, []);

  const loadFromSlot = useCallback((idx: number) => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    if (!pid) return;
    const existing = loadSlots(pid);
    const slot = existing[idx];
    if (!slot) return;
    // Clear current canvas
    const current = store.tiles[pid] || [];
    for (const t of current) store.removeTile(t.id);
    store.setTransform(slot.transform || { x: 0, y: 0, scale: 1 });
    for (const t of slot.tiles) {
      store.addTile({ ...t, id: crypto.randomUUID(), ptyId: undefined } as Tile);
    }
    toast(`Loaded "${slot.name}"`);
    setOpen(false);
  }, []);

  const deleteSlot = useCallback((idx: number) => {
    const pid = useCanvasStore.getState().activeProject;
    if (!pid) return;
    const existing = loadSlots(pid);
    const name = existing[idx]?.name;
    if (!name) return;
    if (!confirm(`Delete layout "${name}"?`)) return;
    existing[idx] = null;
    saveSlots(pid, existing);
    setSlots(existing);
    toast(`Deleted "${name}"`, 'info');
  }, []);

  return (
    <div ref={menuRef} style={{ position: 'relative', // @ts-expect-error webkit
      WebkitAppRegion: 'no-drag' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Layout presets"
        style={{
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
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6,
          ...glass, padding: 6, minWidth: 280, zIndex: 100,
        }}>
          <button
            onClick={() => { applyDefaultLayout(); setOpen(false); }}
            style={menuRowStyle}
            onMouseEnter={e => { e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 6); }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
          >
            <div style={{ width: 7, height: 7, borderRadius: radius.full, background: colors.primary, flexShrink: 0 }} />
            <div style={{ flex: 1, textAlign: 'left', ...typography.labelMd, fontSize: '0.8125rem', color: colors.onSurface }}>
              Default Layout
            </div>
            <span style={{ ...typography.labelSm, fontSize: '0.625rem', color: colors.secondary }}>Files · Term · Agent · Tasks · Git</span>
          </button>

          <div style={{ height: 1, background: colors.outlineGhost, margin: '6px 8px' }} />

          <div style={{
            ...typography.labelSm,
            color: colors.secondary,
            padding: '4px 10px',
            textTransform: 'uppercase',
            fontSize: '0.5625rem',
            letterSpacing: '0.1em',
            fontWeight: 600,
          }}>
            Saved Slots
          </div>

          {slots.map((slot, idx) => (
            <SlotRow
              key={idx}
              idx={idx}
              slot={slot}
              onLoad={() => loadFromSlot(idx)}
              onSave={() => saveToSlot(idx)}
              onDelete={() => deleteSlot(idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const menuRowStyle: React.CSSProperties = {
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
};

function SlotRow({
  idx, slot, onLoad, onSave, onDelete,
}: {
  idx: number;
  slot: LayoutSlot | null;
  onLoad: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const filled = slot !== null;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 6px',
        borderRadius: radius.sm,
        transition: `background ${motion.hover}`,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = alpha(colors.onSurfaceVariant, 4); }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
    >
      <button
        onClick={filled ? onLoad : onSave}
        title={filled ? `Load "${slot!.name}"` : `Save current canvas to slot ${idx + 1}`}
        style={{
          flex: 1,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 6px',
          background: 'none', border: 'none', borderRadius: radius.sm,
          cursor: 'pointer', textAlign: 'left',
          color: filled ? colors.onSurface : colors.secondary,
        }}
      >
        <div style={{
          width: 7, height: 7, borderRadius: radius.full,
          background: filled ? colors.green : colors.outlineVariant,
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...typography.labelMd, fontSize: '0.8125rem', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {filled ? slot!.name : `Slot ${idx + 1}`}
          </div>
          <div style={{ ...typography.labelSm, fontSize: '0.625rem', color: colors.secondary, lineHeight: 1.3 }}>
            {filled ? `${slot!.tiles.length} tile${slot!.tiles.length === 1 ? '' : 's'} · click to load` : 'empty · click to save current'}
          </div>
        </div>
      </button>

      {filled && (
        <>
          <button
            onClick={onSave}
            title="Overwrite this slot with current canvas"
            style={slotIconBtnStyle}
            onMouseEnter={e => { e.currentTarget.style.color = colors.onSurface; }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.secondary; }}
          >
            ↻
          </button>
          <button
            onClick={onDelete}
            title="Delete this slot"
            style={slotIconBtnStyle}
            onMouseEnter={e => { e.currentTarget.style.color = colors.red; }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.secondary; }}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

const slotIconBtnStyle: React.CSSProperties = {
  width: 22, height: 22,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', borderRadius: radius.sm,
  cursor: 'pointer',
  color: colors.secondary,
  fontSize: 12, lineHeight: 1,
  transition: `color ${motion.hover}`,
  flexShrink: 0,
  padding: 0,
};

function RunHistoryButton({
  project,
  onOpenRunHistory,
}: {
  project: Project | undefined;
  onOpenRunHistory: () => void;
}) {
  const title = project ? 'Run history (all pipeline runs)' : 'Select a project first';
  return (
    <button
      onClick={onOpenRunHistory}
      disabled={!project}
      title={title}
      aria-label="Open run history"
      data-testid="topbar-run-history-button"
      style={{
        // @ts-expect-error webkit property
        WebkitAppRegion: 'no-drag',
        height: 28,
        padding: `0 ${spacing.sm}`,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: 'var(--tx-outline-ghost)',
        border: `1px solid ${colors.outlineGhost}`,
        borderRadius: radius.md,
        color: project ? colors.onSurfaceVariant : colors.secondary,
        ...typography.labelSm,
        cursor: project ? 'pointer' : 'not-allowed',
        opacity: project ? 1 : 0.5,
        transition: `all ${motion.hover}`,
      }}
      onMouseEnter={(e) => { if (project) e.currentTarget.style.background = 'var(--tx-outline-variant)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--tx-outline-ghost)'; }}
    >
      <span style={{ fontSize: 12, lineHeight: 1 }}>🕘</span> Runs
    </button>
  );
}

function SettingsGearButton() {
  const handleClick = useCallback(() => {
    useSettingsStore.getState().openAt();
  }, []);

  return (
    <button
      onClick={handleClick}
      aria-label="Open settings"
      title="Settings"
      data-testid="topbar-settings-gear"
      style={{
        // @ts-expect-error webkit property
        WebkitAppRegion: 'no-drag',
        height: 28,
        width: 28,
        padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--tx-outline-ghost)',
        border: `1px solid ${colors.outlineGhost}`,
        borderRadius: radius.md, color: colors.onSurfaceVariant,
        ...typography.labelSm, cursor: 'pointer', transition: `all ${motion.hover}`,
        fontSize: 14, lineHeight: 1,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--tx-outline-variant)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--tx-outline-ghost)'; }}
    >
      ⚙
    </button>
  );
}

function ClearCanvasButton() {
  const handleClick = useCallback(() => {
    const store = useCanvasStore.getState();
    const pid = store.activeProject;
    if (!pid) return;
    const existing = store.tiles[pid] || [];
    if (existing.length === 0) return;
    if (!confirm(`Clear all ${existing.length} tile${existing.length === 1 ? '' : 's'} from this canvas?`)) return;
    for (const t of existing) store.removeTile(t.id);
    import('@/stores/toastStore').then(({ useToastStore }) => {
      useToastStore.getState().addToast('Canvas cleared', 'success');
    });
  }, []);

  return (
    <button
      onClick={handleClick}
      title="Remove all tiles from the canvas"
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
      <span style={{ fontSize: 11, lineHeight: 1, transform: 'translateY(1px)' }}>✕</span> Clear
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
