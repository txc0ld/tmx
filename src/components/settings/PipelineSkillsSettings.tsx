import { useCallback, useEffect, useState } from 'react';
import {
  pipelineSkillStatus,
  pipelineForceInstallSkill,
  type SkillStatus,
} from '@/utils/ipc';
import { useToastStore } from '@/stores/toastStore';

/**
 * Pipeline sub-panel — Phase 3a.4.
 *
 * Lists the skills bundled with TerminalX and reports per-row:
 *   - installed?  (file exists at ~/.claude/skills/<name>/SKILL.md)
 *   - hash_ok?    (bytes match the build-time SHA-256)
 *
 * Per-row action button is context-aware:
 *   - not installed  → "Install"
 *   - installed + ok → "Update from bundle"  (idempotent re-copy)
 *   - mismatch       → "Restore from bundle" (the dangerous case — the user
 *                       likely edited the file or content drifted)
 *
 * Closes the "Phase 3 ships an explicit upgrade UI" deferred item from the
 * Phase 2c skills installation plumbing (CLAUDE.md "Skills installation"
 * section).
 */

type RowState = 'idle' | 'updating';

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxWidth: 640,
};

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--tx-text-muted)',
  lineHeight: 1.4,
};

const skillCardStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--tx-border)',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.02)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const skillNameStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--tx-text)',
  fontFamily: 'var(--tx-font-mono)',
};

function badgeStyle(kind: 'ok' | 'mismatch' | 'missing'): React.CSSProperties {
  // Tuned to be readable on both dark and light themes — the surface itself
  // is forced dark in light mode (see `applyThemeToDOM`), so a bright
  // foreground is fine across the board.
  const color =
    kind === 'ok'
      ? '#7CCD7C' // green
      : kind === 'mismatch'
      ? '#E8C547' // amber
      : 'var(--tx-text-muted)';
  return {
    fontSize: 10,
    fontFamily: 'var(--tx-font-mono)',
    color,
    border: `1px solid ${color}`,
    padding: '2px 6px',
    borderRadius: 3,
    whiteSpace: 'nowrap',
    background: 'rgba(0,0,0,0.2)',
  };
}

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--tx-border)',
    borderRadius: 3,
    color: 'var(--tx-text)',
    padding: '5px 10px',
    fontFamily: 'var(--tx-font-mono)',
    fontSize: 11,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
  };
}

const refreshButtonStyle: React.CSSProperties = {
  ...buttonStyle(false),
  padding: '4px 10px',
};

interface Badge {
  text: string;
  kind: 'ok' | 'mismatch' | 'missing';
}

export function statusBadge(status: SkillStatus): Badge {
  if (!status.installed) return { text: 'not installed', kind: 'missing' };
  if (status.hash_ok) return { text: 'installed ✓', kind: 'ok' };
  return { text: 'hash mismatch ⚠', kind: 'mismatch' };
}

export function actionLabel(status: SkillStatus): string {
  if (!status.installed) return 'Install';
  if (status.hash_ok) return 'Update from bundle';
  return 'Restore from bundle';
}

export function PipelineSkillsSettings() {
  const [statuses, setStatuses] = useState<SkillStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  const refresh = useCallback(async () => {
    try {
      const next = await pipelineSkillStatus();
      setStatuses(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAction = useCallback(
    async (skill: string) => {
      setRowState(s => ({ ...s, [skill]: 'updating' }));
      try {
        await pipelineForceInstallSkill(skill);
        await refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        useToastStore.getState().addToast(
          `Skill update failed (${skill}): ${msg}`,
          'error',
        );
      } finally {
        setRowState(s => {
          const { [skill]: _drop, ...rest } = s;
          return rest;
        });
      }
    },
    [refresh],
  );

  return (
    <div data-testid="settings-panel-pipeline-skills" style={sectionStyle}>
      <div style={headerRowStyle}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Pipeline skills</div>
          <div style={subtitleStyle}>
            Bundled with TerminalX, installed to <code>~/.claude/skills/</code>.
            Refresh to pull the latest.
          </div>
        </div>
        <button
          type="button"
          data-testid="pipeline-skills-refresh"
          onClick={() => void refresh()}
          style={refreshButtonStyle}
        >
          Refresh status
        </button>
      </div>

      {loadError ? (
        <div
          data-testid="pipeline-skills-load-error"
          style={{
            ...subtitleStyle,
            color: 'var(--tx-error, #ff6b6b)',
          }}
        >
          Failed to load skill status: {loadError}
        </div>
      ) : null}

      {statuses === null && !loadError ? (
        <div data-testid="pipeline-skills-loading" style={subtitleStyle}>
          Loading skill status…
        </div>
      ) : null}

      {statuses?.map(status => {
        const badge = statusBadge(status);
        const updating = rowState[status.name] === 'updating';
        return (
          <div
            key={status.name}
            data-testid={`pipeline-skill-row-${status.name}`}
            style={skillCardStyle}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={skillNameStyle}>{status.name}</span>
              <span
                data-testid={`pipeline-skill-badge-${status.name}`}
                style={badgeStyle(badge.kind)}
              >
                {badge.text}
              </span>
            </div>
            <button
              type="button"
              data-testid={`pipeline-skill-action-${status.name}`}
              onClick={() => void onAction(status.name)}
              disabled={updating}
              style={buttonStyle(updating)}
            >
              {updating ? 'Working…' : actionLabel(status)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
