import { useEffect, useMemo, useState } from 'react';
import type { PipelineRun } from '@/types';
import {
  readFileText as defaultReadFileText,
  pipelineFailureBundleSummary as defaultBundleSummary,
  type FailureBundleSummary,
} from '@/utils/ipc';

/**
 * Run Logs panel — surfaces the on-disk artifacts for a pipeline run so
 * the user can inspect what happened without dropping to a shell.
 *
 *  - Telemetry tab    → reads `<projectDir>/.terminalx/pipeline-telemetry/<runId>.jsonl`
 *  - Plan/Spec tab    → reads `run.artifacts.plan.{planPath,specPath}` rooted at worktree
 *  - Failure bundle   → shows the on-disk tarball path (only on terminal-failed/escalated)
 *
 * Sibling-modal conventions: fixed overlay, CSS-var theming,
 * `data-canvas-overlay` so the canvas wheel handler bails, Escape→close,
 * click-outside is a no-op (a half-typed search filter would silently
 * lose focus state otherwise; explicit close is cheap).
 *
 * Both `readFileText` and `openShell` are dependency-injected so the
 * modal stays trivially testable.  See sibling tests for the pattern.
 */

interface Props {
  run: PipelineRun;
  /**
   * Project root on disk. Required to resolve telemetry / failure-bundle
   * paths. The controller resolves this from `useProjectStore`; tests
   * pass a literal.
   */
  projectDir: string;
  onClose: () => void;
  /** DI hook — defaults to the IPC binding. Tests pass `vi.fn()`. */
  readFileText?: (path: string) => Promise<string>;
  /**
   * DI hook for revealing the failure-bundle directory in the OS file
   * manager.  Defaults to `@tauri-apps/plugin-shell::open`.
   */
  openShell?: (path: string) => Promise<void>;
  /**
   * DI hook for the in-process bundle summary IPC. Tests pass a
   * `vi.fn()` returning a `FailureBundleSummary` shape; production
   * threads through `pipelineFailureBundleSummary` from `utils/ipc`.
   */
  bundleSummary?: (bundlePath: string) => Promise<FailureBundleSummary>;
}

type Tab = 'telemetry' | 'plan' | 'bundle';

const overlayStyle: React.CSSProperties = {
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

const modalStyle: React.CSSProperties = {
  background: 'var(--tx-surface-2)',
  border: '1px solid var(--tx-border)',
  borderRadius: 6,
  width: 'min(900px, 94vw)',
  height: 'min(720px, 90vh)',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
};

const headerStyle: React.CSSProperties = {
  padding: '14px 18px',
  borderBottom: '1px solid var(--tx-border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const tabsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  padding: '8px 12px 0',
  borderBottom: '1px solid var(--tx-border)',
};

const tabBase: React.CSSProperties = {
  padding: '6px 12px',
  border: '1px solid var(--tx-border)',
  borderBottom: 'none',
  borderRadius: '4px 4px 0 0',
  background: 'var(--tx-surface-2)',
  color: 'var(--tx-text-muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
};

const tabActive: React.CSSProperties = {
  background: 'var(--tx-surface-3, rgba(255,255,255,0.04))',
  color: 'var(--tx-text)',
  fontWeight: 600,
};

const tabDisabled: React.CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.45,
};

const bodyStyle: React.CSSProperties = {
  padding: '14px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  overflowY: 'auto',
  flex: 1,
  minHeight: 200,
};

const footerStyle: React.CSSProperties = {
  padding: '12px 18px',
  borderTop: '1px solid var(--tx-border)',
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
};

const buttonBase: React.CSSProperties = {
  padding: '6px 14px',
  color: 'var(--tx-text)',
  cursor: 'pointer',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  fontFamily: 'inherit',
  fontSize: 12,
  background: 'var(--tx-surface-2)',
};

const inputStyle: React.CSSProperties = {
  padding: '5px 8px',
  background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  color: 'var(--tx-text)',
  fontFamily: 'inherit',
  fontSize: 12,
  width: '100%',
};

function joinPath(base: string, sub: string): string {
  if (!base) return sub;
  if (base.endsWith('/') || base.endsWith('\\')) return `${base}${sub}`;
  return `${base}/${sub}`;
}

function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i <= 0 ? path : path.slice(0, i);
}

/**
 * Lightweight markdown-ish renderer — same surface as PlanPreviewModal's
 * but we don't import that helper to avoid a cross-module dep.  Handles
 * `#` / `##` / `###` headings and treats everything else as a
 * preserve-whitespace paragraph.  Code fences fall through to the
 * default branch which keeps them readable as monospace text.
 */
function renderHeadingsOnly(content: string): React.ReactNode {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h3 = line.match(/^###\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      blocks.push(
        <h1 key={`h-${i}`} style={{ margin: '12px 0 4px', fontSize: 16, fontWeight: 700 }}>
          {h1[1]}
        </h1>,
      );
      i++;
      continue;
    }
    if (h2) {
      blocks.push(
        <h2 key={`h-${i}`} style={{ margin: '10px 0 4px', fontSize: 14, fontWeight: 700 }}>
          {h2[1]}
        </h2>,
      );
      i++;
      continue;
    }
    if (h3) {
      blocks.push(
        <h3 key={`h-${i}`} style={{ margin: '8px 0 2px', fontSize: 13, fontWeight: 700 }}>
          {h3[1]}
        </h3>,
      );
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && !/^#{1,3}\s+/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(
      <div
        key={`p-${i}`}
        style={{
          whiteSpace: 'pre-wrap',
          fontFamily: 'var(--tx-font-mono)',
          lineHeight: 1.5,
        }}
      >
        {buf.join('\n')}
      </div>,
    );
  }
  return blocks;
}

interface TelemetryRow {
  raw: string;
  parsed: Record<string, unknown> | null;
}

function parseTelemetry(text: string): TelemetryRow[] {
  const rows: TelemetryRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        parsed = v as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
    rows.push({ raw: line, parsed });
  }
  // Most recent first — telemetry is append-only so file order is chronological.
  rows.reverse();
  return rows;
}

function summarizeRow(row: TelemetryRow): { ts: string; event: string; detail: string } {
  if (!row.parsed) {
    return { ts: '?', event: 'unparsed', detail: row.raw };
  }
  const at = typeof row.parsed.at === 'string' ? row.parsed.at : '?';
  const event = typeof row.parsed.event === 'string' ? row.parsed.event : 'unknown';
  // Strip the noise fields so the per-row "detail" stays readable.
  const { at: _at, event: _ev, runId: _rid, ...rest } = row.parsed;
  void _at;
  void _ev;
  void _rid;
  return { ts: at, event, detail: JSON.stringify(rest) };
}

/**
 * Format a byte count for the bundle-size line. Single-decimal KB / MB
 * is plenty of resolution; we don't need full IEC pedantry.
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function RunLogsModal({
  run,
  projectDir,
  onClose,
  readFileText = defaultReadFileText,
  openShell,
  bundleSummary = defaultBundleSummary,
}: Props) {
  const isTerminalFailed = run.state === 'failed' || run.state === 'escalated';
  const bundleEnabled = isTerminalFailed;

  const [tab, setTab] = useState<Tab>('telemetry');
  const [search, setSearch] = useState('');

  // Telemetry state
  const [telemetryText, setTelemetryText] = useState<string | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);

  // Plan/spec state
  const [planText, setPlanText] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [specText, setSpecText] = useState<string | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);

  // Failure bundle summary state — null until the IPC has resolved.
  const [bundleSummaryData, setBundleSummaryData] = useState<FailureBundleSummary | null>(
    null,
  );
  const [bundleSummaryError, setBundleSummaryError] = useState<string | null>(null);

  // Path resolution
  const telemetryPath = useMemo(
    () => joinPath(joinPath(projectDir, '.terminalx/pipeline-telemetry'), `${run.id}.jsonl`),
    [projectDir, run.id],
  );
  const bundlePath = useMemo(
    () => joinPath(joinPath(projectDir, '.terminalx/failure-bundles'), `${run.id}.tar.gz`),
    [projectDir, run.id],
  );
  const plan = run.artifacts.plan;
  const planFullPath = plan ? joinPath(run.worktreePath, plan.planPath) : '';
  const specFullPath = plan ? joinPath(run.worktreePath, plan.specPath) : '';

  // Escape → close.
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

  // Lazy-load each tab's data on first activation. Telemetry refreshes
  // on every tab-switch so the user sees fresh state if they re-open.
  useEffect(() => {
    if (tab !== 'telemetry') return;
    let cancelled = false;
    setTelemetryText(null);
    setTelemetryError(null);
    readFileText(telemetryPath).then(
      (text) => {
        if (!cancelled) setTelemetryText(text);
      },
      (err: unknown) => {
        if (!cancelled) {
          setTelemetryError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tab, telemetryPath, readFileText]);

  useEffect(() => {
    if (tab !== 'plan') return;
    if (!plan) return;
    let cancelled = false;
    setPlanText(null);
    setPlanError(null);
    setSpecText(null);
    setSpecError(null);
    readFileText(planFullPath).then(
      (text) => {
        if (!cancelled) setPlanText(text);
      },
      (err: unknown) => {
        if (!cancelled) {
          setPlanError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    readFileText(specFullPath).then(
      (text) => {
        if (!cancelled) setSpecText(text);
      },
      (err: unknown) => {
        if (!cancelled) {
          setSpecError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tab, plan, planFullPath, specFullPath, readFileText]);

  // Bundle summary loads on first activation of the bundle tab. The
  // summary IPC is read-only and idempotent, so a re-fetch on tab
  // re-entry is fine — keeps the size / counters fresh if the bundle
  // was regenerated in the background.
  useEffect(() => {
    if (tab !== 'bundle') return;
    if (!bundleEnabled) return;
    let cancelled = false;
    setBundleSummaryData(null);
    setBundleSummaryError(null);
    bundleSummary(bundlePath).then(
      (s) => {
        if (!cancelled) setBundleSummaryData(s);
      },
      (err: unknown) => {
        if (!cancelled) {
          setBundleSummaryError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tab, bundleEnabled, bundlePath, bundleSummary]);

  const telemetryRows = useMemo(
    () => (telemetryText ? parseTelemetry(telemetryText) : []),
    [telemetryText],
  );
  const filteredRows = useMemo(() => {
    if (!search.trim()) return telemetryRows;
    const needle = search.toLowerCase();
    return telemetryRows.filter((r) => r.raw.toLowerCase().includes(needle));
  }, [telemetryRows, search]);

  async function handleRevealBundle() {
    const fn = openShell ?? (await import('@tauri-apps/plugin-shell')).open;
    try {
      await fn(parentDir(bundlePath));
    } catch (err) {
      // Reveal failures aren't fatal — the path is still visible.
      console.warn('failed to reveal bundle dir', err);
    }
  }

  return (
    <div
      data-canvas-overlay
      data-testid="run-logs-modal"
      style={overlayStyle}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Run logs"
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Run logs</div>
          <div style={{ color: 'var(--tx-text-muted)' }}>
            <code data-testid="run-logs-runid">{run.id}</code>
            <span style={{ marginLeft: 8 }}>
              state: <code style={{ color: 'var(--tx-accent)' }}>{run.state}</code>
            </span>
          </div>
        </div>

        <div style={tabsStyle} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'telemetry'}
            data-testid="run-logs-tab-telemetry"
            onClick={() => setTab('telemetry')}
            style={{ ...tabBase, ...(tab === 'telemetry' ? tabActive : {}) }}
          >
            Telemetry
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'plan'}
            data-testid="run-logs-tab-plan"
            onClick={() => setTab('plan')}
            style={{ ...tabBase, ...(tab === 'plan' ? tabActive : {}) }}
          >
            Plan/Spec
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'bundle'}
            disabled={!bundleEnabled}
            title={bundleEnabled ? undefined : 'Failure bundle is only generated for failed/escalated runs'}
            data-testid="run-logs-tab-bundle"
            onClick={() => bundleEnabled && setTab('bundle')}
            style={{
              ...tabBase,
              ...(tab === 'bundle' ? tabActive : {}),
              ...(bundleEnabled ? {} : tabDisabled),
            }}
          >
            Failure bundle
          </button>
        </div>

        <div style={bodyStyle}>
          {tab === 'telemetry' && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <code data-testid="run-logs-telemetry-path" style={{ color: 'var(--tx-text-muted)' }}>
                  {telemetryPath}
                </code>
                <input
                  data-testid="run-logs-search"
                  type="search"
                  placeholder="Filter rows by substring…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={inputStyle}
                />
              </div>
              {telemetryError !== null && (
                <div data-testid="run-logs-telemetry-error" style={{ color: 'var(--tx-error)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Failed to read telemetry</div>
                  <div>{telemetryError}</div>
                </div>
              )}
              {telemetryError === null && telemetryText === null && (
                <div data-testid="run-logs-telemetry-loading" style={{ color: 'var(--tx-text-muted)' }}>
                  Loading telemetry…
                </div>
              )}
              {telemetryText !== null && filteredRows.length === 0 && (
                <div data-testid="run-logs-telemetry-empty" style={{ color: 'var(--tx-text-muted)' }}>
                  {telemetryRows.length === 0
                    ? 'No telemetry events recorded.'
                    : 'No rows match the filter.'}
                </div>
              )}
              {filteredRows.length > 0 && (
                <ul
                  data-testid="run-logs-telemetry-list"
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  {filteredRows.map((row, idx) => {
                    const sum = summarizeRow(row);
                    return (
                      <li
                        key={idx}
                        data-testid="run-logs-telemetry-row"
                        style={{
                          padding: '6px 8px',
                          background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
                          border: '1px solid var(--tx-border)',
                          borderRadius: 3,
                          display: 'flex',
                          gap: 10,
                          alignItems: 'baseline',
                        }}
                      >
                        <span style={{ color: 'var(--tx-text-muted)', whiteSpace: 'nowrap' }}>
                          {sum.ts}
                        </span>
                        <strong style={{ color: 'var(--tx-accent)' }}>{sum.event}</strong>
                        <span
                          style={{
                            color: 'var(--tx-text-muted)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            flex: 1,
                          }}
                        >
                          {sum.detail}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {tab === 'plan' && (
            <>
              {!plan && (
                <div data-testid="run-logs-plan-missing" style={{ color: 'var(--tx-text-muted)' }}>
                  No plan artifact attached to this run.
                </div>
              )}
              {plan && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      planFullPath && specFullPath ? '1fr 1fr' : '1fr',
                    gap: 12,
                    flex: 1,
                    minHeight: 0,
                  }}
                >
                  {planFullPath && (
                    <PaneView
                      label="Plan"
                      path={planFullPath}
                      content={planText}
                      error={planError}
                      testid="run-logs-plan-pane"
                    />
                  )}
                  {specFullPath && (
                    <PaneView
                      label="Spec"
                      path={specFullPath}
                      content={specText}
                      error={specError}
                      testid="run-logs-spec-pane"
                    />
                  )}
                </div>
              )}
            </>
          )}

          {tab === 'bundle' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ color: 'var(--tx-text-muted)' }}>
                The failure bundle archives telemetry, preflight, git status/diff, and
                versions for the run. Reveal in Finder/Explorer to inspect.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: 1, color: 'var(--tx-text-muted)' }}>
                  Bundle path
                </span>
                <code data-testid="run-logs-bundle-path">{bundlePath}</code>
              </div>

              {/* Inline summary derived from inspecting the tarball
                  in-process. Loading / error / data states are
                  mutually exclusive so the testids stay clean. */}
              {bundleSummaryError !== null && (
                <div
                  data-testid="run-logs-bundle-summary-error"
                  style={{ color: 'var(--tx-error)' }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    Couldn't read the bundle
                  </div>
                  <div>{bundleSummaryError}</div>
                </div>
              )}
              {bundleSummaryError === null && bundleSummaryData === null && (
                <div
                  data-testid="run-logs-bundle-summary-loading"
                  style={{ color: 'var(--tx-text-muted)' }}
                >
                  Inspecting bundle…
                </div>
              )}
              {bundleSummaryData !== null && (
                <div
                  data-testid="run-logs-bundle-summary"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: 10,
                    background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
                    border: '1px solid var(--tx-border)',
                    borderRadius: 4,
                  }}
                >
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <SummaryStat
                      label="Size"
                      value={formatBytes(bundleSummaryData.bytes)}
                      testid="run-logs-bundle-summary-size"
                    />
                    <SummaryStat
                      label="Telemetry events"
                      value={String(bundleSummaryData.telemetry_line_count)}
                      testid="run-logs-bundle-summary-telemetry-count"
                    />
                    {bundleSummaryData.run_state && (
                      <SummaryStat
                        label="Run state"
                        value={bundleSummaryData.run_state}
                        testid="run-logs-bundle-summary-state"
                      />
                    )}
                    {bundleSummaryData.failure_reason && (
                      <SummaryStat
                        label="Failure reason"
                        value={bundleSummaryData.failure_reason}
                        testid="run-logs-bundle-summary-reason"
                      />
                    )}
                  </div>

                  {Object.keys(bundleSummaryData.retry_counters).length > 0 && (
                    <div
                      data-testid="run-logs-bundle-summary-retries"
                      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                    >
                      <span
                        style={{
                          textTransform: 'uppercase',
                          fontSize: 10,
                          letterSpacing: 1,
                          color: 'var(--tx-text-muted)',
                        }}
                      >
                        Retry counters
                      </span>
                      <code>
                        {Object.entries(bundleSummaryData.retry_counters)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(', ')}
                      </code>
                    </div>
                  )}

                  {bundleSummaryData.git_status && (
                    <div
                      data-testid="run-logs-bundle-summary-git-status"
                      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                    >
                      <span
                        style={{
                          textTransform: 'uppercase',
                          fontSize: 10,
                          letterSpacing: 1,
                          color: 'var(--tx-text-muted)',
                        }}
                      >
                        Git status
                      </span>
                      <code>{bundleSummaryData.git_status}</code>
                    </div>
                  )}

                  {bundleSummaryData.last_events.length > 0 && (
                    <div
                      data-testid="run-logs-bundle-summary-last-events"
                      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                    >
                      <span
                        style={{
                          textTransform: 'uppercase',
                          fontSize: 10,
                          letterSpacing: 1,
                          color: 'var(--tx-text-muted)',
                        }}
                      >
                        Last {bundleSummaryData.last_events.length} events
                      </span>
                      <ul
                        style={{
                          margin: 0,
                          padding: 0,
                          listStyle: 'none',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        {bundleSummaryData.last_events.map((e, idx) => (
                          <li
                            key={idx}
                            data-testid="run-logs-bundle-summary-last-event-row"
                            style={{ fontFamily: 'var(--tx-font-mono)' }}
                          >
                            {e}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {!bundleSummaryData.artifacts_present && (
                    <div
                      data-testid="run-logs-bundle-summary-artifacts-missing"
                      style={{ color: 'var(--tx-text-muted)', fontStyle: 'italic' }}
                    >
                      artifacts.json missing or unparseable — run state / retry counters not shown.
                    </div>
                  )}
                </div>
              )}

              <div>
                <button
                  type="button"
                  data-testid="run-logs-bundle-reveal"
                  onClick={handleRevealBundle}
                  style={{
                    ...buttonBase,
                    background: 'var(--tx-accent)',
                    borderColor: 'var(--tx-accent)',
                    color: '#000',
                    fontWeight: 600,
                  }}
                >
                  Reveal in Finder
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            data-testid="run-logs-close"
            onClick={onClose}
            style={buttonBase}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

interface PaneProps {
  label: string;
  path: string;
  content: string | null;
  error: string | null;
  testid: string;
}

function PaneView({ label, path, content, error, testid }: PaneProps) {
  return (
    <div
      data-testid={testid}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 0,
        border: '1px solid var(--tx-border)',
        borderRadius: 4,
        padding: 10,
        background: 'var(--tx-surface-1, rgba(0,0,0,0.2))',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <strong style={{ fontSize: 12 }}>{label}</strong>
        <code data-testid={`${testid}-path`} style={{ color: 'var(--tx-text-muted)', fontSize: 11 }}>
          {path}
        </code>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {error !== null && (
          <div data-testid={`${testid}-error`} style={{ color: 'var(--tx-error)' }}>
            {error}
          </div>
        )}
        {error === null && content === null && (
          <div data-testid={`${testid}-loading`} style={{ color: 'var(--tx-text-muted)' }}>
            Loading…
          </div>
        )}
        {content !== null && (
          <div data-testid={`${testid}-content`}>{renderHeadingsOnly(content)}</div>
        )}
      </div>
    </div>
  );
}

interface SummaryStatProps {
  label: string;
  value: string;
  testid: string;
}

/**
 * Compact stat tile for the failure-bundle summary header — a small
 * label above a monospace value. The label is uppercase + tracked
 * matching the rest of the summary chrome.
 */
function SummaryStat({ label, value, testid }: SummaryStatProps) {
  return (
    <div
      data-testid={testid}
      style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
    >
      <span
        style={{
          textTransform: 'uppercase',
          fontSize: 10,
          letterSpacing: 1,
          color: 'var(--tx-text-muted)',
        }}
      >
        {label}
      </span>
      <code style={{ fontFamily: 'var(--tx-font-mono)' }}>{value}</code>
    </div>
  );
}
