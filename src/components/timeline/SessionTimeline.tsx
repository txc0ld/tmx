import { useEffect, useRef } from 'react';
import { useTimelineStore } from '@/stores/timelineStore';
import { colors, radius, spacing, typography, fonts, glass } from '@/design/tokens';
import type { TimelineEvent } from '@/types';

interface SessionTimelineProps {
  onClose: () => void;
}

const BADGE_LABELS: Record<string, string> = {
  'command-executed': 'CMD',
  'file-modified': 'FILE',
  'agent-prompt': 'AGENT',
  'agent-complete': 'DONE',
  'build-result': 'BUILD',
  'git-operation': 'GIT',
  'wire-triggered': 'WIRE',
  'snapshot-saved': 'SNAP',
};

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

function EventCard({ event }: { event: TimelineEvent }) {
  const badge = BADGE_LABELS[event.eventType] || event.eventType.toUpperCase();
  return (
    <div style={{
      minWidth: 140,
      maxWidth: 200,
      padding: spacing.sm,
      background: colors.surfaceHigh,
      border: `1px solid ${colors.outlineGhost}`,
      borderRadius: radius.md,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          ...typography.labelSm,
          color: colors.bg,
          background: colors.primary,
          padding: '1px 5px',
          borderRadius: radius.sm,
          fontSize: '0.5625rem',
          fontWeight: 600,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}>
          {badge}
        </span>
        <span style={{
          ...typography.labelSm,
          color: colors.secondary,
          fontFamily: fonts.mono,
          fontSize: '0.5625rem',
        }}>
          {formatTime(event.timestamp)}
        </span>
      </div>
      <div style={{
        ...typography.labelSm,
        color: colors.onSurfaceVariant,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        lineHeight: '1.3',
      }}>
        {event.summary}
      </div>
    </div>
  );
}

export function SessionTimeline({ onClose }: SessionTimelineProps) {
  const open = useTimelineStore((s) => s.open);
  const events = useTimelineStore((s) => s.events);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load events on mount
  useEffect(() => {
    useTimelineStore.getState().loadEvents();
  }, []);

  // Auto-scroll to right (newest) when events change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [events]);

  return (
    <div style={{
      height: open ? 160 : 0,
      overflow: 'hidden',
      transition: 'height 300ms cubic-bezier(0.16, 1, 0.3, 1)',
      flexShrink: 0,
      borderTop: open ? `1px solid ${colors.outlineGhost}` : 'none',
    }}>
      <div style={{
        height: 160,
        ...glass,
        borderRadius: 0,
        border: 'none',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: `4px ${spacing.sm}`,
          borderBottom: `1px solid ${colors.outlineGhost}`,
          flexShrink: 0,
        }}>
          <span style={{ ...typography.labelMd, color: colors.onSurface, flex: 1 }}>
            Session Timeline
          </span>
          <span style={{ ...typography.labelSm, color: colors.secondary, marginRight: spacing.sm }}>
            {events.length} events
          </span>
          <button
            onClick={() => useTimelineStore.getState().clear()}
            style={{
              background: 'none',
              border: `1px solid ${colors.outlineGhost}`,
              borderRadius: radius.sm,
              color: colors.secondary,
              fontFamily: fonts.body,
              fontSize: '0.625rem',
              padding: '1px 6px',
              cursor: 'pointer',
              marginRight: spacing.xs,
            }}
          >
            Clear
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: colors.onSurfaceVariant,
              cursor: 'pointer',
              fontFamily: fonts.mono,
              fontSize: 14,
              padding: '0 4px',
            }}
          >
            x
          </button>
        </div>

        {/* Scrollable event cards */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowX: 'auto',
            overflowY: 'hidden',
            display: 'flex',
            alignItems: 'center',
            gap: spacing.sm,
            padding: `${spacing.sm} ${spacing.md}`,
          }}
        >
          {events.length === 0 && (
            <span style={{ ...typography.labelSm, color: colors.secondary }}>
              No events yet. Actions will appear here.
            </span>
          )}
          {/* Oldest first (reversed since store prepends newest) */}
          {[...events].reverse().map((event, index) => (
            <EventCard key={event.id ?? `${event.timestamp}-${index}`} event={event} />
          ))}
        </div>
      </div>
    </div>
  );
}
