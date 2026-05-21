import { useState, useRef, useEffect, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePipelineStore } from '@/stores/pipelineStore';
import { gitAvailable } from '@/utils/ipc';
import { useThemeStore } from '@/stores/themeStore';
import { resolveProjectIcon } from '@/utils/projectIcon';
import { colors, radius, spacing, fonts, motion, typography, glass } from '@/design/tokens';
import { screenToCanvas } from '@/utils/layout';
import { isTerminalState } from '@/pipeline/state-machine';
import type { Project, PipelineRun } from '@/types';

interface ProjectSidebarProps {
  projects: Project[];
  active: string;
  onSelect: (projectId: string) => void;
  /**
   * DI for tests / Storybook: override the runs map. Production reads
   * `pipelineStore.runs` directly via the `usePipelineStore` selector.
   */
  runs?: Record<string, PipelineRun>;
}

/**
 * Indicator state for a single project's pipeline footprint.
 *
 *   - `'active'`: at least one non-terminal run on this project.
 *   - `'unviewed-failed'`: at least one terminal run in `failed`/`escalated`
 *      that the user hasn't yet acknowledged via the run-logs modal
 *      (per `tx-run-viewed-${runId}` localStorage key).
 *   - `'none'`: nothing to show.
 *
 * `unviewed-failed` takes priority over `active` because it's a louder
 * signal (something needs attention; an in-flight run is just status).
 */
export type ProjectIndicatorKind = 'active' | 'unviewed-failed' | 'none';

const RUN_VIEWED_KEY_PREFIX = 'tx-run-viewed-';

/** SSR-safe localStorage probe for the per-run viewed flag. */
function isRunViewed(runId: string): boolean {
  try {
    return localStorage.getItem(`${RUN_VIEWED_KEY_PREFIX}${runId}`) === '1';
  } catch {
    return false;
  }
}

/**
 * Compute (count, kind) for the sidebar dot. Pure — testable without
 * mounting the component. `count` includes only non-terminal runs (the
 * tooltip says "N pipeline run(s) active") so terminal-but-unviewed-failed
 * runs flip the kind to red without bumping a count that would mislead.
 */
export function computeProjectIndicator(
  runs: PipelineRun[],
  viewedCheck: (runId: string) => boolean = isRunViewed,
): { kind: ProjectIndicatorKind; activeCount: number } {
  let activeCount = 0;
  let hasUnviewedFailed = false;
  for (const r of runs) {
    if (!isTerminalState(r.state)) {
      activeCount += 1;
    } else if ((r.state === 'failed' || r.state === 'escalated') && !viewedCheck(r.id)) {
      hasUnviewedFailed = true;
    }
  }
  if (hasUnviewedFailed) return { kind: 'unviewed-failed', activeCount };
  if (activeCount > 0) return { kind: 'active', activeCount };
  return { kind: 'none', activeCount: 0 };
}

type ModalMode = null | 'menu' | 'new' | 'clone' | 'post-clone';

export function ProjectSidebar({ projects, active, onSelect, runs: runsProp }: ProjectSidebarProps) {
  const [modal, setModal] = useState<ModalMode>(null);
  // Always subscribe so background runs landing while ProjectSidebar is
  // mounted (which is always — it's the persistent left rail) trigger a
  // re-render. Tests can override via `runs` prop and never trip the live
  // store.
  const liveRuns = usePipelineStore((s) => s.runs);
  const effRuns = runsProp ?? liveRuns;

  // Group runs by projectId once per render. `O(R)` where R = total runs.
  const runsByProject = useMemo(() => {
    const out: Record<string, PipelineRun[]> = {};
    for (const r of Object.values(effRuns)) {
      (out[r.projectId] ??= []).push(r);
    }
    return out;
  }, [effRuns]);
  const [hasGit, setHasGit] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDest, setCloneDest] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastClonedProject, setLastClonedProject] = useState<Project | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [projectIcons, setProjectIcons] = useState<Record<string, string>>({});

  // Resolve favicons/logos from project repos
  useEffect(() => {
    for (const p of projects) {
      if (p.cwd && !projectIcons[p.id]) {
        resolveProjectIcon(p.cwd).then(url => {
          if (url) setProjectIcons(prev => ({ ...prev, [p.id]: url }));
        });
      }
    }
  }, [projects]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check git on mount
  useEffect(() => {
    gitAvailable().then(setHasGit).catch(() => setHasGit(false));
  }, []);

  // Close modal on outside click
  useEffect(() => {
    if (!modal) return;
    const handler = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        resetModal();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modal]);

  // Auto-extract name from GitHub URL
  useEffect(() => {
    if (cloneUrl) {
      const match = cloneUrl.match(/\/([^/]+?)(\.git)?$/);
      if (match) setCloneName(match[1]);
    }
  }, [cloneUrl]);

  const resetModal = () => {
    setModal(null);
    setNewName('');
    setNewPath('');
    setCloneUrl('');
    setCloneDest('');
    setCloneName('');
    setError('');
    setLastClonedProject(null);
  };

  const pickFolder = async () => {
    const selected = await open({ directory: true, title: 'Select folder' });
    return selected as string | null;
  };

  const handleNewProject = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    setLoading(true);
    setError('');
    try {
      const project: Project = {
        id: crypto.randomUUID(),
        name: newName.trim(),
        icon: newName.trim().charAt(0).toUpperCase(),
        color: useThemeStore.getState().getActiveTheme().accent,
        description: '',
        cwd: newPath,
      };
      await useProjectStore.getState().addProject(project);
      useProjectStore.getState().setActive(project.id);
      resetModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleClone = async () => {
    if (!cloneUrl.trim() || !cloneDest.trim() || !cloneName.trim()) return;
    setLoading(true);
    setError('');
    try {
      const fullPath = `${cloneDest}/${cloneName}`;
      const project = await useProjectStore.getState().cloneFromGithub(cloneUrl, fullPath, cloneName);
      useTimelineStore.getState().recordEvent('git-operation', `Cloned repo ${cloneUrl} to ${fullPath}`);
      setLastClonedProject(project);
      setModal('post-clone');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const spawnTerminalForProject = (project: Project) => {
    const state = useCanvasStore.getState();
    const transform = state.transforms[state.activeProject] || { x: 0, y: 0, scale: 1 };
    const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2, transform);
    state.addTile({
      id: crypto.randomUUID(),
      type: 'terminal',
      x: center.x - 300,
      y: center.y - 200,
      w: 600,
      h: 400,
      cwd: project.cwd,
      branch: '',
      node: '',
      splits: [],
    });
  };

  const handleDeleteProject = async (id: string) => {
    await useProjectStore.getState().deleteProject(id);
  };

  return (
    <div style={{
      width: 56,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingBottom: spacing.md,
      gap: spacing.sm,
      background: colors.surfaceLowest,
      borderRight: `1px solid ${colors.outlineGhost}`,
      flexShrink: 0,
      position: 'relative',
      userSelect: 'none',
    }}>
      {/* Project icons */}
      {projects.map((project, i) => {
        const isActive = project.id === active;
        const isSolid = i % 2 === 0;
        const iconUrl = projectIcons[project.id];
        const indicator = computeProjectIndicator(runsByProject[project.id] ?? []);
        const tooltipBase = `${project.name}${project.description ? ' — ' + project.description : ''}`;
        const tooltipExtra =
          indicator.kind === 'active'
            ? `\n${indicator.activeCount} pipeline run${indicator.activeCount === 1 ? '' : 's'} active`
            : indicator.kind === 'unviewed-failed'
              ? '\nPipeline run failed — click to inspect'
              : '';
        return (
          <div
            key={project.id}
            onClick={() => onSelect(project.id)}
            onContextMenu={e => {
              e.preventDefault();
              if (confirm(`Remove "${project.name}" from projects?`)) {
                handleDeleteProject(project.id);
              }
            }}
            title={`${tooltipBase}${tooltipExtra}\nRight-click to remove`}
            data-testid={`project-sidebar-icon-${project.id}`}
            style={{
              position: 'relative',
              width: 40, height: 40,
              borderRadius: radius.lg,
              background: iconUrl ? colors.surfaceLowest : (isSolid ? colors.primary : colors.bg),
              border: `1.5px solid ${colors.primary}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: isSolid ? colors.bg : colors.primary,
              fontFamily: fonts.title, fontWeight: 700, fontSize: 14,
              cursor: 'pointer', transition: `all ${motion.hover}`,
              overflow: 'hidden',
              opacity: isActive ? 1 : 0.6,
            }}
          >
            {isActive && (
              <div style={{
                position: 'absolute', left: -8, top: '50%',
                transform: 'translateY(-50%)',
                width: 3, height: 20, borderRadius: radius.full,
                background: colors.primary,
                zIndex: 1,
              }} />
            )}
            {iconUrl ? (
              <img
                src={iconUrl}
                alt={project.name}
                style={{
                  width: 28, height: 28,
                  objectFit: 'contain',
                  borderRadius: 4,
                }}
                onError={e => {
                  // Fallback to letter if image fails to load
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              project.icon
            )}
            {/* Pipeline-run indicator dot — top-right of the icon. Accent
                pulse for in-flight runs, solid red for unviewed
                failed/escalated. Subscribes via the runsByProject memo so
                background runs on inactive projects still surface. */}
            {indicator.kind !== 'none' && (
              <span
                data-testid={`project-sidebar-indicator-${project.id}`}
                data-indicator-kind={indicator.kind}
                aria-label={
                  indicator.kind === 'active'
                    ? `${indicator.activeCount} pipeline run${indicator.activeCount === 1 ? '' : 's'} active`
                    : 'Pipeline run failed'
                }
                style={{
                  position: 'absolute',
                  top: -2,
                  right: -2,
                  width: 10,
                  height: 10,
                  borderRadius: radius.full,
                  background:
                    indicator.kind === 'unviewed-failed'
                      ? 'var(--tx-error, #d44)'
                      : 'var(--tx-accent)',
                  boxShadow: '0 0 0 2px var(--tx-bg)',
                  pointerEvents: 'none',
                  animation:
                    indicator.kind === 'active'
                      ? 'tx-sidebar-indicator-pulse 2s ease-in-out infinite'
                      : undefined,
                  zIndex: 2,
                }}
              />
            )}
          </div>
        );
      })}
      <style>{`@keyframes tx-sidebar-indicator-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.18); opacity: 0.8; }
      }`}</style>

      {/* Add project button */}
      <div
        onClick={() => setModal(modal ? null : 'menu')}
        style={{
          width: 40, height: 40, borderRadius: radius.lg,
          border: `1.5px dashed ${colors.outlineVariant}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: colors.onSurfaceVariant, fontSize: 20, fontWeight: 300,
          cursor: 'pointer', transition: `all ${motion.hover}`,
          opacity: 0.5,
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'var(--tx-accent)'; e.currentTarget.style.color = 'var(--tx-accent)'; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.borderColor = 'var(--tx-outline-variant)'; e.currentTarget.style.color = 'var(--tx-on-surface-variant)'; }}
        title="Add project"
      >
        +
      </div>

      {/* Modal popover */}
      {modal && (
        <div ref={modalRef} style={{
          position: 'absolute',
          left: 64,
          bottom: 8,
          ...glass,
          padding: spacing.md,
          width: 320,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          gap: spacing.sm,
        }}>
          {/* Menu */}
          {modal === 'menu' && (
            <>
              <div style={{ ...typography.labelMd, color: colors.onSurface }}>Add Project</div>
              <button onClick={() => setModal('new')} style={menuBtnStyle}>
                New Project
                <span style={{ ...typography.labelSm, color: colors.secondary }}>from existing folder</span>
              </button>
              {hasGit && (
                <button onClick={() => setModal('clone')} style={menuBtnStyle}>
                  Clone from GitHub
                  <span style={{ ...typography.labelSm, color: colors.secondary }}>git clone a repo</span>
                </button>
              )}
              {!hasGit && (
                <div style={{ ...typography.labelSm, color: colors.secondary, padding: `4px 0` }}>
                  Git not found in PATH — install Git to enable cloning.
                </div>
              )}
            </>
          )}

          {/* New Project Form */}
          {modal === 'new' && (
            <>
              <div style={{ ...typography.labelMd, color: colors.onSurface }}>New Project</div>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Project name"
                style={inputStyle}
                autoFocus
              />
              <div style={{ display: 'flex', gap: spacing.xs }}>
                <input
                  value={newPath}
                  onChange={e => setNewPath(e.target.value)}
                  placeholder="Path to folder"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button onClick={async () => { const p = await pickFolder(); if (p) setNewPath(p); }} style={smallBtnStyle}>
                  Browse
                </button>
              </div>
              {error && <div style={{ ...typography.labelSm, color: colors.primary }}>{error}</div>}
              <div style={{ display: 'flex', gap: spacing.xs, justifyContent: 'flex-end' }}>
                <button onClick={resetModal} style={smallBtnStyle}>Cancel</button>
                <button onClick={handleNewProject} disabled={loading} style={accentBtnStyle}>
                  {loading ? 'Creating...' : 'Create'}
                </button>
              </div>
            </>
          )}

          {/* Clone Form */}
          {modal === 'clone' && (
            <>
              <div style={{ ...typography.labelMd, color: colors.onSurface }}>Clone from GitHub</div>
              <input
                value={cloneUrl}
                onChange={e => setCloneUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
                style={inputStyle}
                autoFocus
              />
              <input
                value={cloneName}
                onChange={e => setCloneName(e.target.value)}
                placeholder="Project name"
                style={inputStyle}
              />
              <div style={{ display: 'flex', gap: spacing.xs }}>
                <input
                  value={cloneDest}
                  onChange={e => setCloneDest(e.target.value)}
                  placeholder="Clone destination folder"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button onClick={async () => { const p = await pickFolder(); if (p) setCloneDest(p); }} style={smallBtnStyle}>
                  Browse
                </button>
              </div>
              {error && <div style={{ ...typography.labelSm, color: colors.primary }}>{error}</div>}
              <div style={{ display: 'flex', gap: spacing.xs, justifyContent: 'flex-end' }}>
                <button onClick={resetModal} style={smallBtnStyle}>Cancel</button>
                <button onClick={handleClone} disabled={loading} style={accentBtnStyle}>
                  {loading ? 'Cloning...' : 'Clone'}
                </button>
              </div>
            </>
          )}

          {/* Post-clone actions */}
          {modal === 'post-clone' && lastClonedProject && (
            <>
              <div style={{ ...typography.labelMd, color: colors.primary }}>Cloned successfully</div>
              <div style={{ ...typography.labelSm, color: colors.onSurfaceVariant }}>
                {lastClonedProject.name} is ready at {lastClonedProject.cwd}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs, marginTop: spacing.xs }}>
                <button onClick={() => { spawnTerminalForProject(lastClonedProject); resetModal(); }} style={menuBtnStyle}>
                  Open Terminal here
                  <span style={{ ...typography.labelSm, color: colors.secondary }}>start working immediately</span>
                </button>
                <button onClick={resetModal} style={menuBtnStyle}>
                  Just close
                  <span style={{ ...typography.labelSm, color: colors.secondary }}>open the canvas empty</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 32,
  background: 'transparent',
  border: '1px solid var(--tx-outline-ghost)',
  borderRadius: '0.375rem',
  color: 'var(--tx-on-surface)',
  fontFamily: fonts.body,
  fontSize: '0.8125rem',
  padding: '0 8px',
  width: '100%',
  transition: 'border-color 150ms ease',
};

const smallBtnStyle: React.CSSProperties = {
  height: 32,
  padding: '0 10px',
  background: 'var(--tx-outline-ghost)',
  border: '1px solid var(--tx-outline-ghost)',
  borderRadius: '0.375rem',
  color: 'var(--tx-on-surface-variant)',
  fontFamily: fonts.body,
  fontSize: '0.75rem',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'all 150ms ease',
};

// Applied to disabled buttons via attribute selector in index.html
const accentBtnStyle: React.CSSProperties = {
  height: 32,
  padding: '0 14px',
  background: 'var(--tx-accent)',
  border: 'none',
  borderRadius: '0.375rem',
  color: 'var(--tx-bg)',
  fontFamily: fonts.body,
  fontSize: '0.75rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const menuBtnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  padding: '8px 10px',
  background: 'none',
  border: '1px solid var(--tx-outline-ghost)',
  borderRadius: '0.5rem',
  color: 'var(--tx-on-surface-variant)',
  fontFamily: fonts.body,
  fontSize: '0.8125rem',
  cursor: 'pointer',
  textAlign: 'left',
  width: '100%',
  transition: 'background 150ms ease',
};
