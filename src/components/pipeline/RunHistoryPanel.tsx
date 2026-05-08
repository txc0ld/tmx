import { useEffect, useMemo, useState } from 'react';
import type { PipelineRun, PipelineState } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';
import { useProjectStore } from '@/stores/projectStore';

/**
 * Run History panel — lists all pipeline runs for the active project.
 *
 * The Pipeline Controller tile only ever surfaces the run it's bound to,
 * which means runs that have completed (or whose controller tile was
 * cleared from the canvas) become invisible. This panel is the
 * always-on register: every run for the project, sorted newest-first,
 * with a click-through to RunLogsModal for inspection.
 *
 * Sibling-modal conventions: fixed overlay, CSS-var theming, opaque card,
 * `data-canvas-overlay` so the canvas wheel handler bails, Escape→close,
 * click-outside is a no-op (a half-applied filter chip would silently
 * lose state otherwise — explicit close is cheap).
 *
 * `runs` and `activeProjectId` are read directly from the live Zustand
 * stores in production but DI'd in tests so we don't have to seed the
 * store from every test case. `onOpenLogs` is also DI'd — App.tsx mounts
 * RunLogsModal itself, this panel just signals which run to open.
 */

type Group = 'active' | 'awaiting' | 'completed' | 'failed';

interface Props {
  onClose: () => void;
  /** Called with the clicked run; parent renders the logs modal. */
  onOpenLogs: (run: PipelineRun) => void;
  /** DI hook — defaults to live Zustand store. */
  runs?: Record<string, PipelineRun>;
  /** DI hook — defaults to projectStore.active. */
  activeProjectId?: string | null;
}

const ACTIVE_STATES: ReadonlySet<PipelineState> = new Set([
  'planning',
  'building',
  'reviewing',
  'merging',
]);
const COMPLETED_STATES: ReadonlySet<PipelineState> = new Set(['done']);
const FAILED_STATES: ReadonlySet<PipelineState> = new Set(['failed', 'escalated']);

function classify(state: PipelineState): Group {
  if (FAILED_STATES.has(state)) return 'failed';
  if (COMPLETED_STATES.has(state)) return 'completed';
  if (state.startsWith('awaiting_')) return 'awaiting';
  if (ACTIVE_STATES.has(state)) return 'active';
  // 'idle' falls back to active (run created, no movement yet).
  return 'active';
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10_000,
  background: 'rgba(0, 0, 0, 0.75)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--tx-font-mono)',
  fontSize: 12,
  color: 'var(--tx-text)',
};

const card: React.CSSProperties = {
  background: 'var(--tx-surface-2)',
  border: '1px solid var(--tx-border)',
  borderRadius: 6,
  width: 'min(800px, 94vw)',
  height: 'min(600px, 90vh)',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
};

const header: React.CSSProperties = {
  padding: '14px 18px',
  borderBottom: '1px solid var(--tx-border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const chipRow: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  padding: '10px 18px',
  borderBottom: '1px solid var(--tx-border)',
  flexWrap: 'wrap',
};

const body: React.CSSProperties = {
  padding: '8px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  overflowY: 'auto',
  flex: 1,
};

const footer: React.CSSProperties = {
  padding: '12px 18px',
  borderTop: '1px solid var(--tx-border)',
  display: 'flex',
  justifyContent: 'flex-end',
};

const closeBtn: React.CSSProperties = {
  padding: '6px 14px',
  color: 'var(--tx-text)',
  cursor: 'pointer',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  fontFamily: 'inherit',
  fontSize: 12,
  background: 'var(--tx-surface-2)',
};

const chipBase: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 12,
  border: '1px solid var(--tx-border)',
  background: 'var(--tx-surface-2)',
  color: 'var(--tx-text-muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const chipActive: React.CSSProperties = {
  background: 'var(--tx-accent)',
  color: 'var(--tx-accent-fg, #000)',
  borderColor: 'var(--tx-accent)',
  fontWeight: 700,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  borderRadius: 4,
  cursor: 'pointer',
  border: '1px solid transparent',
  background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
};

function pillStyle(group: Group): React.CSSProperties {
  // Color-coded by spec: accent for awaiting, green for done, red for
  // failed/escalated, muted for active states.
  let bg = 'var(--tx-text-muted)';
  let fg = 'var(--tx-bg)';
  if (group === 'awaiting') {
    bg = 'var(--tx-accent)';
    fg = 'var(--tx-accent-fg, #000)';
  } else if (group === 'completed') {
    bg = 'var(--tx-success, #3a8)';
    fg = '#001008';
  } else if (group === 'failed') {
    bg = 'var(--tx-error, #d44)';
    fg = '#fff';
  }
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    background: bg,
    color: fg,
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    whiteSpace: 'nowrap',
  };
}

const FILTERS: { key: Group; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'awaiting', label: 'Awaiting' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
];

export function RunHistoryPanel({ onClose, onOpenLogs, runs, activeProjectId }: Props) {
  // Subscribe to live stores when DI not provided. Calling the hooks
  // unconditionally with a stable selector keeps React happy; the values
  // are then only consumed if the prop is undefined.
  const liveRuns = usePipelineStore((s) => s.runs);
  const liveActiveProjectId = useProjectStore((s) => s.active);

  const effectiveRuns = runs ?? liveRuns;
  const effectiveProjectId = activeProjectId === undefined ? liveActiveProjectId : activeProjectId;

  // Multi-select filter chips. Empty set = "All" (everything passes).
  const [enabledFilters, setEnabledFilters] = useState<Set<Group>>(new Set());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visibleRuns = useMemo(() => {
    if (!effectiveProjectId) return [];
    const filtered = Object.values(effectiveRuns)
      .filter((r) => r.projectId === effectiveProjectId);
    const groupFiltered =
      enabledFilters.size === 0
        ? filtered
        : filtered.filter((r) => enabledFilters.has(classify(r.state)));
    // Newest first by startedAt.
    return groupFiltered.sort((a, b) => b.startedAt - a.startedAt);
  }, [effectiveRuns, effectiveProjectId, enabledFilters]);

  const toggleFilter = (g: Group) => {
    setEnabledFilters((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  const clearFilters = () => setEnabledFilters(new Set());

  return (
    <div
      data-canvas-overlay
      data-testid="run-history-panel"
      style={overlay}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" aria-label="Run history" style={card} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Run history</div>
          <div style={{ color: 'var(--tx-text-muted)' }}>
            All pipeline runs for this project, newest first. Click a row to inspect logs.
          </div>
        </div>

        <div style={chipRow}>
          <button
            type="button"
            data-testid="run-history-filter-all"
            onClick={clearFilters}
            style={enabledFilters.size === 0 ? { ...chipBase, ...chipActive } : chipBase}
          >
            All
          </button>
          {FILTERS.map((f) => {
            const on = enabledFilters.has(f.key);
            return (
              <button
                key={f.key}
                type="button"
                data-testid={`run-history-filter-${f.key}`}
                onClick={() => toggleFilter(f.key)}
                style={on ? { ...chipBase, ...chipActive } : chipBase}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div style={body}>
          {visibleRuns.length === 0 && (
            <div data-testid="run-history-empty" style={{ color: 'var(--tx-text-muted)', padding: '20px 8px' }}>
              No runs yet for this project.
            </div>
          )}
          {visibleRuns.map((run) => {
            const group = classify(run.state);
            return (
              <div
                key={run.id}
                role="button"
                tabIndex={0}
                data-testid="run-history-row"
                data-runid={run.id}
                onClick={() => onOpenLogs(run)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenLogs(run);
                  }
                }}
                style={rowStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--tx-accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'transparent';
                }}
              >
                <span data-testid="run-history-row-pill" style={pillStyle(group)}>
                  {run.state}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {run.branch}
                </span>
                <span style={{ color: 'var(--tx-text-muted)', whiteSpace: 'nowrap' }}>
                  {new Date(run.startedAt).toLocaleString()}
                </span>
                <code style={{ color: 'var(--tx-text-muted)' }}>{run.id.slice(0, 8)}</code>
              </div>
            );
          })}
        </div>

        <div style={footer}>
          <button type="button" data-testid="run-history-close" onClick={onClose} style={closeBtn}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
