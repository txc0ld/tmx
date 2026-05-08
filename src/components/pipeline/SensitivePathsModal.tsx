import { useEffect } from 'react';

/**
 * Modal gate shown by the run-factory when `pipelinePreflight` reports
 * `sensitive_paths_found.length > 0`.
 *
 * Despite the plan task being labelled "toast", the surface is a modal:
 * the user MUST decide before run creation can proceed (async gate, not
 * a passive notification). Naming/ergonomics mirror MergerConfirmModal
 * and ClarificationModal — same destructive-op patterns (no
 * click-outside dismiss, Escape acts as Cancel).
 *
 * The factory wires this in via `RunFactoryDeps.confirmSensitivePaths`
 * (see run-factory.ts). The component itself is UI-only and takes plain
 * callbacks so it stays trivially testable.
 */

interface Props {
  paths: string[];
  onAcknowledge: () => void;
  onCancel: () => void;
}

const VISIBLE_MAX = 20;

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
  width: 'min(640px, 92vw)',
  maxHeight: '90vh',
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

const bodyStyle: React.CSSProperties = {
  padding: '14px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  overflowY: 'auto',
};

const footerStyle: React.CSSProperties = {
  padding: '12px 18px',
  borderTop: '1px solid var(--tx-border)',
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
};

const sectionLabelStyle: React.CSSProperties = {
  textTransform: 'uppercase',
  fontSize: 10,
  letterSpacing: 1,
  color: 'var(--tx-text-muted)',
  marginBottom: 4,
};

const buttonBase: React.CSSProperties = {
  padding: '6px 14px',
  color: 'var(--tx-text)',
  cursor: 'pointer',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  fontFamily: 'inherit',
  fontSize: 12,
};

const PATH_LIST_MAX_HEIGHT = 220;

export function SensitivePathsModal({ paths, onAcknowledge, onCancel }: Props) {
  const visible = paths.slice(0, VISIBLE_MAX);
  const overflow = Math.max(0, paths.length - VISIBLE_MAX);

  // Escape → Cancel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      data-canvas-overlay
      data-testid="sensitive-paths-modal"
      style={overlayStyle}
      // Click outside the inner card does NOT close — destructive op.
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sensitive files detected"
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Sensitive files detected</div>
          <div style={{ color: 'var(--tx-text-muted)' }}>
            The pipeline will refuse to read these files. Confirm to proceed.
          </div>
        </div>

        <div style={bodyStyle}>
          <div>
            <div style={sectionLabelStyle}>
              Files matched ({paths.length})
            </div>
            <ul
              data-testid="sensitive-paths-list"
              style={{
                margin: 0,
                paddingLeft: 18,
                maxHeight: PATH_LIST_MAX_HEIGHT,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {visible.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
              {overflow > 0 && (
                <li
                  data-testid="sensitive-paths-overflow"
                  style={{ color: 'var(--tx-text-muted)', listStyle: 'none', marginLeft: -18 }}
                >
                  +{overflow} more
                </li>
              )}
            </ul>
          </div>

          <div style={{ color: 'var(--tx-text-muted)', lineHeight: 1.5 }}>
            These files match patterns for secrets / credentials (
            <code>.env</code>, <code>*.key</code>, <code>id_rsa*</code>, etc.).
            Pipeline agents are denied access by their role capabilities — but if
            you've configured custom role capabilities or templates that override
            this, double-check.
          </div>
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            data-testid="sensitive-paths-cancel"
            onClick={onCancel}
            style={{
              ...buttonBase,
              background: 'var(--tx-surface-2)',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="sensitive-paths-acknowledge"
            onClick={onAcknowledge}
            style={{
              ...buttonBase,
              background: 'var(--tx-accent)',
              borderColor: 'var(--tx-accent)',
              color: 'var(--tx-accent-fg)',
              fontWeight: 600,
            }}
          >
            Acknowledge & proceed
          </button>
        </div>
      </div>
    </div>
  );
}
