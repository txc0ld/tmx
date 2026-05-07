import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@/types';
import { useProjectStore } from '@/stores/projectStore';

/**
 * Project sub-panel — Phase 3a.2.
 *
 * Currently edits the active project's `webhookUrl` only. Name / cwd / icon
 * remain owned by the project-add flow in the sidebar (rename + delete UI is
 * tracked in 3a.4 along with the agents panel).
 *
 * Validation is intentionally narrow — `https://` only — because the Rust
 * `http_fetch` proxy enforces the deeper SSRF guards (loopback, RFC 1918,
 * link-local, etc.) at delivery time. Catching scheme errors here is purely
 * UX so users notice the mistake before the first webhook fires.
 */

interface Validation {
  ok: boolean;
  error?: string;
}

export function validateWebhookUrl(input: string): Validation {
  if (input.trim() === '') return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'not a valid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'must start with https://' };
  }
  return { ok: true };
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxWidth: 560,
};

const headerCardStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--tx-border)',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.02)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--tx-text)',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--tx-text-muted)',
  lineHeight: 1.4,
};

const inputStyle: React.CSSProperties = {
  appearance: 'none',
  background: 'rgba(0,0,0,0.25)',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  color: 'var(--tx-text)',
  padding: '8px 10px',
  fontFamily: 'var(--tx-font-mono)',
  fontSize: 12,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const inlineStatusStyle = (color: string): React.CSSProperties => ({
  fontSize: 11,
  color,
  minHeight: 14,
});

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
};

function buttonStyle(primary: boolean, disabled: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    background: primary ? 'var(--tx-accent)' : 'transparent',
    border: primary ? 'none' : '1px solid var(--tx-border)',
    borderRadius: 3,
    color: primary ? '#000' : 'var(--tx-text)',
    padding: '6px 14px',
    fontFamily: 'var(--tx-font-mono)',
    fontSize: 12,
    fontWeight: primary ? 600 : 400,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

export function ProjectSettings() {
  const project = useProjectStore(s =>
    s.projects.find(p => p.id === s.active),
  );

  if (!project) {
    return (
      <div data-testid="settings-panel-project-empty" style={{ color: 'var(--tx-text-muted)' }}>
        No project selected — use the project picker first.
      </div>
    );
  }

  return <ProjectSettingsForm key={project.id} project={project} />;
}

function ProjectSettingsForm({ project }: { project: Project }) {
  const persisted = project.webhookUrl ?? '';
  const [draft, setDraft] = useState(persisted);

  // If the persisted value changes from under us (e.g. someone else updates
  // the same project, or the user switches projects), resync. The `key` prop
  // on ProjectSettingsForm handles project switches; this covers the rare
  // concurrent-edit case.
  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const validation = useMemo(() => validateWebhookUrl(draft), [draft]);
  const dirty = draft !== persisted;
  const canSave = validation.ok && dirty;

  function onSave() {
    if (!canSave) return;
    const trimmed = draft.trim();
    void useProjectStore.getState().updateProject(project.id, {
      webhookUrl: trimmed === '' ? undefined : trimmed,
    });
  }

  function onCancel() {
    setDraft(persisted);
  }

  return (
    <div data-testid="settings-panel-project-form" style={sectionStyle}>
      <div style={headerCardStyle} data-testid="project-settings-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: 3,
              background: project.color,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              color: '#000',
            }}
          >
            {project.icon}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{project.name}</span>
        </div>
        <div style={subtitleStyle}>{project.cwd}</div>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={labelStyle}>Pipeline webhook (POST on awaiting_*)</span>
        <span style={subtitleStyle}>
          Fired when a pipeline run pauses for human input. https only.
        </span>
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://hooks.slack.com/..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="project-webhook-input"
          style={inputStyle}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--tx-accent)'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--tx-border)'; }}
        />
        <div
          data-testid="project-webhook-status"
          style={inlineStatusStyle(
            validation.ok
              ? 'var(--tx-text-muted)'
              : 'var(--tx-error, #ff6b6b)',
          )}
        >
          {validation.ok
            ? draft.trim() === ''
              ? '(empty — webhook disabled for this project)'
              : '✓ ready'
            : validation.error}
        </div>
      </label>

      <div style={buttonRowStyle}>
        <button
          type="button"
          data-testid="project-settings-cancel"
          onClick={onCancel}
          disabled={!dirty}
          style={buttonStyle(false, !dirty)}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="project-settings-save"
          onClick={onSave}
          disabled={!canSave}
          style={buttonStyle(true, !canSave)}
        >
          Save
        </button>
      </div>
    </div>
  );
}
