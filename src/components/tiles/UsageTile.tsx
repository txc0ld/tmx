import { useEffect, useCallback, useMemo } from 'react';
import { useUsageStore, type OpenUsageProvider, type AgentSession } from '@/stores/usageStore';
import { colors, fonts, radius, spacing, typography, motion, alpha } from '@/design/tokens';

const EMPTY_PROVIDERS: OpenUsageProvider[] = [];
const EMPTY_SESSIONS: AgentSession[] = [];

function computeStats(sessions: AgentSession[]) {
  const byAgent: Record<string, { sessions: number; durationMins: number; tokens: number; cost: number }> = {};
  let totalDuration = 0;
  let activeSessions = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const s of sessions) {
    const dur = s.endedAt ? s.durationSecs : Math.round((Date.now() - s.startedAt) / 1000);
    if (!s.endedAt) activeSessions++;
    totalDuration += dur;
    totalTokens += s.estimatedTokens || 0;
    totalCost += s.estimatedCost || 0;
    if (!byAgent[s.agent]) byAgent[s.agent] = { sessions: 0, durationMins: 0, tokens: 0, cost: 0 };
    byAgent[s.agent].sessions++;
    byAgent[s.agent].durationMins += Math.round(dur / 60);
    byAgent[s.agent].tokens += s.estimatedTokens || 0;
    byAgent[s.agent].cost += s.estimatedCost || 0;
  }

  return {
    totalSessions: sessions.length,
    totalDurationMins: Math.round(totalDuration / 60),
    totalTokens,
    totalCost: Math.round(totalCost * 100) / 100,
    byAgent,
    activeSessions,
  };
}

export function UsageTile() {
  // Select stable primitives/arrays — never call getStats() inside a selector
  const sessions = useUsageStore(s => s.sessions ?? EMPTY_SESSIONS);
  const openUsageData = useUsageStore(s => s.openUsageData ?? EMPTY_PROVIDERS);
  const openUsageConnected = useUsageStore(s => s.openUsageConnected);
  const fetchOpenUsage = useUsageStore(s => s.fetchOpenUsage);

  const stats = useMemo(() => computeStats(sessions), [sessions.length]);

  // Poll OpenUsage API every 30s
  useEffect(() => {
    fetchOpenUsage();
    const interval = setInterval(fetchOpenUsage, 30000);
    return () => clearInterval(interval);
  }, [fetchOpenUsage]);

  const refresh = useCallback(() => { fetchOpenUsage(); }, [fetchOpenUsage]);

  return (
    <div style={{
      width: '100%', height: '100%',
      overflow: 'auto',
      display: 'flex', flexDirection: 'column',
      fontFamily: fonts.mono, fontSize: '0.75rem',
    }}>
      {/* Internal TerminalX usage */}
      <div style={{
        padding: `${spacing.sm} ${spacing.sm}`,
        borderBottom: `1px solid ${colors.outlineGhost}`,
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 6,
        }}>
          <span style={{ ...typography.labelSm, color: colors.onSurface, fontWeight: 600 }}>
            TerminalX Usage
          </span>
          <span style={{
            fontSize: '0.5625rem', color: colors.primary,
            background: alpha(colors.primary, 10),
            padding: '1px 5px', borderRadius: radius.sm,
          }}>
            {stats.activeSessions} active
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <StatCard label="Sessions" value={String(stats.totalSessions)} />
          <StatCard label="Total Time" value={formatDuration(stats.totalDurationMins)} />
          <StatCard label="Est. Tokens" value={stats.totalTokens > 1000 ? `${Math.round(stats.totalTokens / 1000)}k` : String(stats.totalTokens)} />
          <StatCard label="Est. Cost" value={`$${stats.totalCost.toFixed(2)}`} />
        </div>

        {/* Per-agent breakdown */}
        {Object.entries(stats.byAgent).length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.entries(stats.byAgent).map(([agent, data]) => (
              <div key={agent} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '3px 6px',
                background: alpha(colors.onSurfaceVariant, 3),
                borderRadius: radius.sm,
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: radius.full,
                  background: '#CCFF00', flexShrink: 0,
                }} />
                <span style={{ ...typography.labelSm, color: colors.onSurface, flex: 1, textTransform: 'capitalize' }}>
                  {agent}
                </span>
                <span style={{ ...typography.labelSm, color: colors.secondary }}>
                  {data.sessions} runs
                </span>
                <span style={{ ...typography.labelSm, color: colors.secondary }}>
                  {formatDuration(data.durationMins)}
                </span>
                {data.cost > 0 && (
                  <span style={{ ...typography.labelSm, color: colors.yellow, fontFamily: fonts.mono }}>
                    ${data.cost.toFixed(2)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* OpenUsage external data */}
      <div style={{ flex: 1, overflow: 'auto', padding: spacing.sm }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 6,
        }}>
          <span style={{ ...typography.labelSm, color: colors.onSurface, fontWeight: 600 }}>
            LLM Providers
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 5, height: 5, borderRadius: '50%',
              background: openUsageConnected ? colors.green : colors.secondary,
            }} />
            <span style={{ ...typography.labelSm, color: colors.secondary, fontSize: '0.5625rem' }}>
              {openUsageConnected ? 'OpenUsage' : 'Offline'}
            </span>
            <button
              onClick={refresh}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: colors.onSurfaceVariant, fontSize: 10, padding: '0 2px',
              }}
            >
              &#8635;
            </button>
          </div>
        </div>

        {openUsageConnected && openUsageData.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {openUsageData.map(provider => (
              <ProviderCard key={provider.id} provider={provider} />
            ))}
          </div>
        ) : (
          <div style={{
            padding: spacing.md, textAlign: 'center',
            color: colors.secondary, ...typography.labelSm,
          }}>
            {openUsageConnected
              ? 'No provider data yet'
              : 'Install OpenUsage to track external LLM costs'}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: '6px 8px',
      background: alpha(colors.onSurfaceVariant, 3),
      borderRadius: radius.sm,
    }}>
      <div style={{ ...typography.labelSm, color: colors.secondary, fontSize: '0.5625rem' }}>
        {label}
      </div>
      <div style={{ ...typography.titleMd, color: colors.onSurface, fontSize: '1rem', marginTop: 1 }}>
        {value}
      </div>
    </div>
  );
}

function ProviderCard({ provider }: { provider: OpenUsageProvider }) {
  return (
    <div style={{
      padding: '6px 8px',
      border: `1px solid ${colors.outlineGhost}`,
      borderRadius: radius.md,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 4,
      }}>
        <span style={{ ...typography.labelMd, color: colors.onSurface, textTransform: 'capitalize' }}>
          {provider.name}
        </span>
        {provider.plan && (
          <span style={{
            ...typography.labelSm, fontSize: '0.5625rem',
            color: colors.primary,
            background: alpha(colors.primary, 8),
            padding: '1px 5px', borderRadius: radius.sm,
          }}>
            {provider.plan}
          </span>
        )}
      </div>

      {provider.lines.map((line, i) => (
        <div key={i} style={{ marginTop: 4 }}>
          {line.type === 'progress' && (
            <>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                ...typography.labelSm, color: colors.secondary, fontSize: '0.5625rem',
                marginBottom: 2,
              }}>
                <span>{line.label}</span>
                <span>{line.value ?? 0} / {line.maxValue ?? 100}</span>
              </div>
              <div style={{
                height: 4, borderRadius: radius.full,
                background: alpha(colors.onSurfaceVariant, 8),
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: radius.full,
                  background: getProgressColor(line.value ?? 0, line.maxValue ?? 100),
                  width: `${Math.min(100, ((line.value ?? 0) / (line.maxValue || 1)) * 100)}%`,
                  transition: `width ${motion.enter}`,
                }} />
              </div>
              {line.resetAt && (
                <div style={{
                  ...typography.labelSm, color: colors.secondary,
                  fontSize: '0.5rem', marginTop: 2,
                }}>
                  Resets {formatResetDate(line.resetAt)}
                </div>
              )}
            </>
          )}
          {line.type === 'text' && (
            <div style={{ ...typography.labelSm, color: colors.onSurfaceVariant }}>
              {line.label}: {line.value}
            </div>
          )}
          {line.type === 'badge' && (
            <span style={{
              ...typography.labelSm, fontSize: '0.5625rem',
              color: colors.secondary,
              background: alpha(colors.secondary, 10),
              padding: '1px 5px', borderRadius: radius.sm,
            }}>
              {line.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function getProgressColor(value: number, max: number): string {
  const pct = value / max;
  if (pct >= 0.9) return colors.red;
  if (pct >= 0.7) return colors.yellow;
  return colors.green;
}

function formatDuration(mins: number): string {
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatResetDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return 'today';
    if (diffDays === 1) return 'tomorrow';
    return `in ${diffDays}d`;
  } catch {
    return '';
  }
}
