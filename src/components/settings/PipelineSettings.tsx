import { useMemo } from 'react';
import {
  expandBranchPattern,
  MAX_RETENTION_DAYS,
  PIPELINE_TEMPLATE_IDS,
  useSettingsStore,
  type PipelineDefaultTemplateId,
} from '@/stores/settingsStore';

/**
 * Pipeline preferences sub-panel — Phase 3a.7.
 *
 * Three rows:
 *   1. Default template (select)
 *   2. Default branch pattern (text input + tokens help + live preview)
 *   3. Auto-approve trivial plans (checkbox)
 *
 * Auto-persisted on every change via `setPipelinePrefs`. No Save button —
 * matches the existing prefs pattern (PipelineSkillsSettings) and keeps the
 * surface area small.
 */

const TEMPLATE_LABELS: Record<PipelineDefaultTemplateId, string> = {
  'tx.pipeline.anthropic-trio': 'Anthropic Trio (Plan / Build / Review)',
  'tx.pipeline.hello-world': 'Hello World (smoke test)',
};

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxWidth: 640,
  marginBottom: 24,
};

const headerStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--tx-text-muted)',
  lineHeight: 1.4,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--tx-text)',
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

const previewStyle = (valid: boolean): React.CSSProperties => ({
  fontFamily: 'var(--tx-font-mono)',
  fontSize: 11,
  color: valid ? 'var(--tx-text-muted)' : 'var(--tx-error, #ff6b6b)',
  minHeight: 14,
});

const checkboxRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--tx-text)',
};

export function PipelineSettings() {
  const prefs = useSettingsStore(s => s.pipelinePrefs);

  const preview = useMemo(
    // Use a fixed shortId for the preview so it doesn't churn while the user
    // edits the pattern. The actual run uses a fresh id at launch time.
    () => expandBranchPattern(prefs.branchPattern, { shortIdSource: () => 'a1b2' }),
    [prefs.branchPattern],
  );

  return (
    <div data-testid="settings-panel-pipeline-prefs" style={sectionStyle}>
      <div>
        <div style={headerStyle}>Pipeline preferences</div>
        <div style={subtitleStyle}>
          Defaults applied when starting a new run. Per-run overrides happen in
          the Start dialog.
        </div>
      </div>

      <label style={rowStyle}>
        <span style={labelStyle}>Default template</span>
        <select
          data-testid="pipeline-prefs-template"
          value={prefs.defaultTemplate}
          onChange={(e) =>
            useSettingsStore.getState().setPipelinePrefs({
              defaultTemplate: e.target.value as PipelineDefaultTemplateId,
            })
          }
          style={inputStyle}
        >
          {PIPELINE_TEMPLATE_IDS.map((id) => (
            <option key={id} value={id}>
              {TEMPLATE_LABELS[id]}
            </option>
          ))}
        </select>
      </label>

      <label style={rowStyle}>
        <span style={labelStyle}>Default branch pattern</span>
        <span style={subtitleStyle}>
          Tokens: <code>{'{date}'}</code> (YYYY-MM-DD), <code>{'{shortId}'}</code> (4-char).
          Letters, digits, dots, underscores, slashes, hyphens, plus the literal
          tokens.
        </span>
        <input
          type="text"
          data-testid="pipeline-prefs-branch-pattern"
          value={prefs.branchPattern}
          onChange={(e) =>
            useSettingsStore.getState().setPipelinePrefs({
              branchPattern: e.target.value,
            })
          }
          style={inputStyle}
          spellCheck={false}
          autoComplete="off"
        />
        <div data-testid="pipeline-prefs-branch-preview" style={previewStyle(preview.valid)}>
          {preview.valid
            ? `→ ${preview.branch}`
            : `Pattern must produce a valid branch name (letters/digits/dots/underscores/slashes/hyphens). Currently: "${preview.branch}"`}
        </div>
      </label>

      <label style={checkboxRow}>
        <input
          type="checkbox"
          data-testid="pipeline-prefs-auto-approve"
          checked={prefs.autoApproveTrivial}
          onChange={(e) =>
            useSettingsStore.getState().setPipelinePrefs({
              autoApproveTrivial: e.target.checked,
            })
          }
        />
        <span>
          Auto-approve trivial plans
          <div style={subtitleStyle}>
            When the planner classifies a plan as trivial, skip the human
            approve gate and go straight to building. Off by default — leave
            off if you want to review every plan.
          </div>
        </span>
      </label>

      <label style={rowStyle}>
        <span style={labelStyle}>
          Auto-delete completed runs older than (days)
        </span>
        <span style={subtitleStyle}>
          Sweeps run records, telemetry JSONL, and orphaned worktrees for
          runs in <code>done</code>, <code>failed</code>, or <code>escalated</code> states.
          Active and <code>awaiting_*</code> runs are never touched.
          Set to <code>0</code> to disable.
        </span>
        <input
          type="number"
          min={0}
          max={MAX_RETENTION_DAYS}
          step={1}
          data-testid="pipeline-prefs-retention-days"
          value={prefs.retentionDays}
          onChange={(e) => {
            // Empty / NaN inputs bottom out at 0 (disabled) rather than
            // pushing the store into an invalid state. The clamp in the
            // store re-validates regardless.
            const parsed = parseInt(e.target.value, 10);
            useSettingsStore.getState().setPipelinePrefs({
              retentionDays: Number.isFinite(parsed) ? parsed : 0,
            });
          }}
          style={inputStyle}
        />
      </label>
    </div>
  );
}
