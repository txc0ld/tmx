import { useEffect, useMemo, useState } from 'react';
import type { Project, WebhookCadence } from '@/types';
import { useProjectStore } from '@/stores/projectStore';

const CADENCE_OPTIONS: ReadonlyArray<{ value: WebhookCadence; label: string }> = [
  { value: 'entry-only', label: 'Entry only (default)' },
  { value: '15min', label: '15 min' },
  { value: '1hr', label: '1 hour' },
  { value: '4hr', label: '4 hours' },
  { value: 'daily', label: 'Daily' },
];

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
    return { ok: false, error: 'Webhook URL must use https://' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Webhook URL must use https://' };
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
  const persistedCadence: WebhookCadence = project.webhookCadence ?? 'entry-only';
  const [draft, setDraft] = useState(persisted);
  const [draftCadence, setDraftCadence] = useState<WebhookCadence>(persistedCadence);

  // If the persisted value changes from under us (e.g. someone else updates
  // the same project, or the user switches projects), resync. The `key` prop
  // on ProjectSettingsForm handles project switches; this covers the rare
  // concurrent-edit case.
  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);
  useEffect(() => {
    setDraftCadence(persistedCadence);
  }, [persistedCadence]);

  const validation = useMemo(() => validateWebhookUrl(draft), [draft]);
  const urlDirty = draft !== persisted;
  const cadenceDirty = draftCadence !== persistedCadence;
  const dirty = urlDirty || cadenceDirty;
  const canSave = validation.ok && dirty;

  // Cadence radio is only meaningful when a webhook URL is configured.
  const showCadence = draft.trim() !== '';

  function onSave() {
    if (!canSave) return;
    const trimmed = draft.trim();
    const url = trimmed === '' ? undefined : trimmed;
    // When clearing the URL, also clear cadence (no point storing a cadence
    // for a disabled webhook). Otherwise persist the chosen cadence; we
    // store undefined for the implicit default `entry-only` to keep the
    // JSON tidy.
    const cadence: WebhookCadence | undefined =
      url === undefined
        ? undefined
        : draftCadence === 'entry-only'
          ? undefined
          : draftCadence;
    void useProjectStore.getState().updateProject(project.id, {
      webhookUrl: url,
      webhookCadence: cadence,
    });
  }

  function onCancel() {
    setDraft(persisted);
    setDraftCadence(persistedCadence);
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

      <section
        data-testid="project-webhook-section"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          border: '1px solid var(--tx-border)',
          borderRadius: 4,
          padding: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...labelStyle, fontSize: 13 }}>Webhook (optional)</span>
          <span style={subtitleStyle}>
            POSTs JSON to your URL when a run needs attention. Used for
            Slack-bot integrations, custom dashboards, etc.
          </span>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle}>URL</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://hooks.slack.com/services/..."
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
                ? 'Empty — webhook disabled. https only. Body is JSON-stringified, secrets masked. Errors are silent.'
                : 'https only. Body is JSON-stringified, secrets masked. Errors are silent.'
              : validation.error}
          </div>
        </label>

        {showCadence && (
          <label
            data-testid="project-webhook-cadence"
            style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <span style={labelStyle}>Re-fire cadence</span>
            <span style={subtitleStyle}>
              Wider cadences re-POST cumulatively from entry — mirrors OS-notification reminders.
            </span>
            <select
              value={draftCadence}
              onChange={(e) => setDraftCadence(e.target.value as WebhookCadence)}
              data-testid="project-webhook-cadence-select"
              style={{
                ...inputStyle,
                cursor: 'pointer',
              }}
            >
              {CADENCE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {/*
             * Hidden radios are kept to preserve the existing test surface
             * (`project-webhook-cadence-<value>`). The visible control is the
             * <select> above; the radios mirror its state for fireEvent.click
             * compatibility in tests that pre-date the select switch.
             */}
            <div style={{ display: 'none' }}>
              {CADENCE_OPTIONS.map(opt => (
                <input
                  key={opt.value}
                  type="radio"
                  name="webhook-cadence-mirror"
                  value={opt.value}
                  checked={draftCadence === opt.value}
                  onChange={() => setDraftCadence(opt.value)}
                  data-testid={`project-webhook-cadence-${opt.value}`}
                />
              ))}
            </div>
          </label>
        )}
      </section>

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
