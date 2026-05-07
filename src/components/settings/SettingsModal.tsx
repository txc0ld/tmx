import { useEffect } from 'react';
import {
  SETTINGS_CATEGORIES,
  useSettingsStore,
  type SettingsCategory,
} from '@/stores/settingsStore';
import { ProjectSettings } from './ProjectSettings';
import { PipelineSkillsSettings } from './PipelineSkillsSettings';

const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  project: 'Project',
  agents: 'Agents',
  pipeline: 'Pipeline',
  plugins: 'Plugins',
  about: 'About',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10_000,
  background: 'rgba(0, 0, 0, 0.6)',
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
  width: 'min(820px, 94vw)',
  height: 'min(560px, 86vh)',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--tx-border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexShrink: 0,
};

const contentStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
};

const sidebarStyle: React.CSSProperties = {
  width: 180,
  flexShrink: 0,
  borderRight: '1px solid var(--tx-border)',
  padding: '8px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  overflowY: 'auto',
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  padding: '16px 20px',
  overflowY: 'auto',
  minWidth: 0,
};

const closeButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--tx-text-muted)',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  padding: '4px 8px',
  borderRadius: 3,
  fontFamily: 'inherit',
};

function categoryButtonStyle(active: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    background: active ? 'rgba(255,255,255,0.05)' : 'transparent',
    border: 'none',
    borderLeft: `2px solid ${active ? 'var(--tx-accent)' : 'transparent'}`,
    color: active ? 'var(--tx-text)' : 'var(--tx-text-muted)',
    textAlign: 'left',
    padding: '8px 16px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
    width: '100%',
  };
}

export function SettingsModal() {
  const open = useSettingsStore(s => s.open);
  const category = useSettingsStore(s => s.category);

  // Escape closes. Read close() lazily so identity changes don't re-bind.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useSettingsStore.getState().close();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-canvas-overlay
      data-testid="settings-modal-overlay"
      style={overlayStyle}
      // Click outside the inner card does NOT close — accidental dismissal
      // would lose in-progress edits in sub-panels (3a.2+).
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-modal"
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Settings</div>
          <button
            type="button"
            aria-label="Close settings"
            data-testid="settings-modal-close"
            onClick={() => useSettingsStore.getState().close()}
            style={closeButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--tx-text)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--tx-text-muted)'; }}
          >
            ×
          </button>
        </div>

        <div style={contentStyle}>
          <div style={sidebarStyle} role="tablist" aria-label="Settings categories">
            {SETTINGS_CATEGORIES.map((cat) => {
              const active = cat === category;
              return (
                <button
                  key={cat}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`settings-category-${cat}`}
                  onClick={() => useSettingsStore.getState().setCategory(cat)}
                  style={categoryButtonStyle(active)}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              );
            })}
          </div>

          <div style={bodyStyle} data-testid="settings-body">
            <SettingsCategoryBody category={category} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the body for a given category. Phase 3a.2 wires the `project` panel;
 * remaining categories (`agents`, `pipeline`, `plugins`, `about`) ship in
 * 3a.4 / 3a.5 and land here as additional `case` branches.
 */
function SettingsCategoryBody({ category }: { category: SettingsCategory }) {
  return (
    <div data-testid={`settings-panel-${category}`}>
      {category === 'project' ? (
        <ProjectSettings />
      ) : category === 'pipeline' ? (
        <PipelineSkillsSettings />
      ) : (
        <>
          Category: <strong>{CATEGORY_LABELS[category]}</strong>
          <div style={{ marginTop: 12, color: 'var(--tx-text-muted)' }}>
            This panel is under construction. Sub-panels for plugins, agents,
            and about land in subsequent Phase-3a tasks.
          </div>
        </>
      )}
    </div>
  );
}
