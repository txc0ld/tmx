import { useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineRun, PipelineState } from '@/types';
import { usePipelineStore } from '@/stores/pipelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { readFileText as defaultReadFileText } from '@/utils/ipc';

/**
 * Run History panel — lists all pipeline runs for the active project.
 *
 * Pipeline Controller tile only surfaces the run it's bound to, so once a
 * run completes (or its controller is cleared) it becomes invisible. This
 * panel is the always-on register: every run for the project, sorted
 * newest-first, with a click-through to RunLogsModal for inspection.
 *
 * Sibling-modal conventions: fixed overlay, CSS-var theming, opaque card,
 * `data-canvas-overlay` so the canvas wheel handler bails, Escape→close,
 * click-outside is a no-op (a half-applied filter chip would silently lose
 * state otherwise — explicit close is cheap).
 *
 * `runs` / `activeProjectId` / `onOpenLogs` are dep-injected — App.tsx
 * passes the live stores in production; tests pass literals so they don't
 * have to seed the global stores per case.
 */

type Group = 'active' | 'awaiting' | 'completed' | 'failed';

interface Props {
  onClose: () => void;
  onOpenLogs: (run: PipelineRun) => void;
  /**
   * Optional "re-run with this goal" handler. When provided each row
   * renders a small Re-run button that hands the run record up to the
   * caller (App.tsx) so it can read PIPELINE_GOAL.md and open the launch
   * modal pre-filled. Click stops propagation so the row's row-click
   * (open logs) doesn't fire as well.
   */
  onRerun?: (run: PipelineRun) => void;
  runs?: Record<string, PipelineRun>;
  activeProjectId?: string | null;
  /**
   * Override for the goal-file reader. Tests inject a stub; production
   * uses the `readFileText` IPC. Errors (worktree deleted, missing file)
   * resolve to an empty string and the run silently falls back to
   * branch-only matching.
   */
  readFileText?: (path: string) => Promise<string>;
}

const FAILED: ReadonlySet<PipelineState> = new Set(['failed', 'escalated']);
const ACTIVE: ReadonlySet<PipelineState> = new Set(['planning', 'building', 'reviewing', 'merging', 'idle']);

function classify(s: PipelineState): Group {
  if (FAILED.has(s)) return 'failed';
  if (s === 'done') return 'completed';
  if (s.startsWith('awaiting_')) return 'awaiting';
  if (ACTIVE.has(s)) return 'active';
  return 'active';
}

const FILTERS: { key: Group; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'awaiting', label: 'Awaiting' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
];

const PILL_BG: Record<Group, string> = {
  awaiting: 'var(--tx-accent)',
  completed: 'var(--tx-success, #3a8)',
  failed: 'var(--tx-error, #d44)',
  active: 'var(--tx-text-muted)',
};
const PILL_FG: Record<Group, string> = {
  awaiting: 'var(--tx-accent-fg, #000)',
  completed: '#001008',
  failed: '#fff',
  active: 'var(--tx-bg)',
};

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 10_000, background: 'rgba(0,0,0,0.75)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'var(--tx-font-mono)', fontSize: 12, color: 'var(--tx-text)',
};
const card: React.CSSProperties = {
  background: 'var(--tx-surface-2)', border: '1px solid var(--tx-border)',
  borderRadius: 6, width: 'min(800px, 94vw)', height: 'min(600px, 90vh)',
  display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
};
const chipBase: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 12, border: '1px solid var(--tx-border)',
  background: 'var(--tx-surface-2)', color: 'var(--tx-text-muted)',
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 0.5,
};
const chipActive: React.CSSProperties = {
  background: 'var(--tx-accent)', color: 'var(--tx-accent-fg, #000)',
  borderColor: 'var(--tx-accent)', fontWeight: 700,
};
const closeBtn: React.CSSProperties = {
  padding: '6px 14px', color: 'var(--tx-text)', cursor: 'pointer',
  border: '1px solid var(--tx-border)', borderRadius: 3,
  fontFamily: 'inherit', fontSize: 12, background: 'var(--tx-surface-2)',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 12px', borderRadius: 4, cursor: 'pointer',
  border: '1px solid transparent',
  background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
};

function pillStyle(group: Group): React.CSSProperties {
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 10,
    background: PILL_BG[group], color: PILL_FG[group],
    fontSize: 10, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap',
  };
}

export function RunHistoryPanel({
  onClose,
  onOpenLogs,
  onRerun,
  runs,
  activeProjectId,
  readFileText,
}: Props) {
  // Always subscribe so React state updates flow even when DI is omitted; the
  // value is only consumed if the corresponding prop is undefined.
  const liveRuns = usePipelineStore((s) => s.runs);
  const liveActiveProjectId = useProjectStore((s) => s.active);
  const effRuns = runs ?? liveRuns;
  const effPid = activeProjectId === undefined ? liveActiveProjectId : activeProjectId;
  const effRead = readFileText ?? defaultReadFileText;

  // Empty set = "All"; multi-select toggles add/remove from the set.
  const [filters, setFilters] = useState<Set<Group>>(new Set());
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Per-run goal cache. `undefined` = not yet attempted, `string` = result
  // (empty string for read failures so we don't keep retrying). Stored in a
  // ref + version-counter pair so we trigger one re-render per goal landing
  // without thrashing on every concurrent resolve.
  const goalCache = useRef<Map<string, string>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const [goalTick, setGoalTick] = useState(0);

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

  const trimmedSearch = search.trim();
  const lowerSearch = trimmedSearch.toLowerCase();

  // Lazy goal-file fetch: only run once a search term is active. Branch-only
  // matching upfront keeps the panel snappy with 50+ runs; we pay the IPC
  // cost only when the user has expressed search intent.
  useEffect(() => {
    if (!effPid) return;
    if (trimmedSearch === '') return;
    const mine = Object.values(effRuns).filter((r) => r.projectId === effPid);
    for (const r of mine) {
      if (goalCache.current.has(r.id)) continue;
      if (inFlight.current.has(r.id)) continue;
      inFlight.current.add(r.id);
      const path = `${r.worktreePath}/PIPELINE_GOAL.md`;
      effRead(path)
        .then((txt) => {
          goalCache.current.set(r.id, txt ?? '');
        })
        .catch(() => {
          // Worktree deleted, file missing, IPC error — cache empty so we
          // don't retry; branch-only match still works.
          goalCache.current.set(r.id, '');
        })
        .finally(() => {
          inFlight.current.delete(r.id);
          setGoalTick((t) => t + 1);
        });
    }
  }, [effRuns, effPid, trimmedSearch, effRead]);

  const fromMs = useMemo(() => {
    if (!dateFrom) return null;
    const t = new Date(dateFrom).getTime();
    return Number.isFinite(t) ? t : null;
  }, [dateFrom]);
  const toMs = useMemo(() => {
    if (!dateTo) return null;
    // Inclusive end-of-day so a "to=2026-05-09" pick keeps runs from that day.
    const t = new Date(dateTo).getTime();
    return Number.isFinite(t) ? t + 86_400_000 - 1 : null;
  }, [dateTo]);

  const visible = useMemo(() => {
    if (!effPid) return [];
    const mine = Object.values(effRuns).filter((r) => r.projectId === effPid);
    const byChip = filters.size === 0 ? mine : mine.filter((r) => filters.has(classify(r.state)));
    const byDate = byChip.filter((r) => {
      if (fromMs !== null && r.startedAt < fromMs) return false;
      if (toMs !== null && r.startedAt > toMs) return false;
      return true;
    });
    const bySearch =
      lowerSearch === ''
        ? byDate
        : byDate.filter((r) => {
            if (r.branch.toLowerCase().includes(lowerSearch)) return true;
            const goal = goalCache.current.get(r.id);
            if (goal && goal.toLowerCase().includes(lowerSearch)) return true;
            return false;
          });
    return bySearch.sort((a, b) => b.startedAt - a.startedAt);
    // `goalTick` participates so re-renders triggered by async goal-cache
    // landings re-evaluate the substring match (the cache itself is a ref).
  }, [effRuns, effPid, filters, fromMs, toMs, lowerSearch, goalTick]);

  const hasAnyFilter =
    filters.size > 0 || trimmedSearch !== '' || dateFrom !== '' || dateTo !== '';
  const clearAll = () => {
    setFilters(new Set());
    setSearch('');
    setDateFrom('');
    setDateTo('');
  };

  const toggle = (g: Group) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <div
      data-canvas-overlay
      data-testid="run-history-panel"
      style={overlay}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" aria-label="Run history" style={card} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--tx-border)' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Run history</div>
          <div style={{ color: 'var(--tx-text-muted)', marginTop: 4 }}>
            All pipeline runs for this project, newest first. Click a row to inspect logs.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '10px 18px', borderBottom: '1px solid var(--tx-border)', flexWrap: 'wrap' }}>
          <button
            type="button"
            data-testid="run-history-filter-all"
            onClick={() => setFilters(new Set())}
            style={filters.size === 0 ? { ...chipBase, ...chipActive } : chipBase}
          >
            All
          </button>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              data-testid={`run-history-filter-${f.key}`}
              onClick={() => toggle(f.key)}
              style={filters.has(f.key) ? { ...chipBase, ...chipActive } : chipBase}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '10px 18px',
            borderBottom: '1px solid var(--tx-border)',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            data-testid="run-history-search"
            placeholder="Search by branch or goal..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: '1 1 220px',
              minWidth: 180,
              padding: '6px 10px',
              borderRadius: 3,
              border: '1px solid var(--tx-border)',
              background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
              color: 'var(--tx-text)',
              fontFamily: 'inherit',
              fontSize: 12,
              outline: 'none',
            }}
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: 'var(--tx-text-muted)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            From
            <input
              type="date"
              data-testid="run-history-date-from"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={{
                padding: '5px 8px',
                borderRadius: 3,
                border: '1px solid var(--tx-border)',
                background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
                color: 'var(--tx-text)',
                fontFamily: 'inherit',
                fontSize: 12,
              }}
            />
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: 'var(--tx-text-muted)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            To
            <input
              type="date"
              data-testid="run-history-date-to"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={{
                padding: '5px 8px',
                borderRadius: 3,
                border: '1px solid var(--tx-border)',
                background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
                color: 'var(--tx-text)',
                fontFamily: 'inherit',
                fontSize: 12,
              }}
            />
          </label>
        </div>

        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', flex: 1 }}>
          {visible.length === 0 && !hasAnyFilter && (
            <div data-testid="run-history-empty" style={{ color: 'var(--tx-text-muted)', padding: '20px 8px' }}>
              No runs yet for this project.
            </div>
          )}
          {visible.length === 0 && hasAnyFilter && (
            <div
              data-testid="run-history-empty-filtered"
              style={{
                color: 'var(--tx-text-muted)',
                padding: '20px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                alignItems: 'flex-start',
              }}
            >
              <span>No runs match your filters. Clear search?</span>
              <button
                type="button"
                data-testid="run-history-clear-filters"
                onClick={clearAll}
                style={{
                  padding: '4px 10px',
                  borderRadius: 3,
                  border: '1px solid var(--tx-border)',
                  background: 'var(--tx-surface-2)',
                  color: 'var(--tx-text)',
                  fontFamily: 'inherit',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Clear filters
              </button>
            </div>
          )}
          {visible.map((run) => {
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
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--tx-accent)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'transparent'; }}
              >
                <span data-testid="run-history-row-pill" style={pillStyle(group)}>{run.state}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {run.branch}
                </span>
                <span style={{ color: 'var(--tx-text-muted)', whiteSpace: 'nowrap' }}>
                  {new Date(run.startedAt).toLocaleString()}
                </span>
                <code style={{ color: 'var(--tx-text-muted)' }}>{run.id.slice(0, 8)}</code>
                {onRerun && (
                  <button
                    type="button"
                    data-testid="run-history-row-rerun"
                    title="Re-run with this goal on a fresh branch"
                    onClick={(e) => {
                      // Stop the row's onClick (which opens logs) from
                      // firing — a single click on Re-run should rerun,
                      // not also open the logs modal.
                      e.stopPropagation();
                      onRerun(run);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    style={{
                      padding: '2px 8px',
                      borderRadius: 3,
                      border: '1px solid var(--tx-border)',
                      background: 'var(--tx-surface-2)',
                      color: 'var(--tx-text)',
                      fontFamily: 'inherit',
                      fontSize: 11,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Re-run
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--tx-border)', display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" data-testid="run-history-close" onClick={onClose} style={closeBtn}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
