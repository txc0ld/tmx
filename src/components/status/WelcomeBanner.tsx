import { useEffect, useState } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { useHealthCheck } from '@/hooks/useHealthCheck';

const DISMISSED_KEY = 'tx-welcome-dismissed';

const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/quickstart';

/**
 * Test-only DI seam for the link's `open` action. Production callers go
 * through `@tauri-apps/plugin-shell::open` (lazy-imported in the click
 * handler so jsdom tests don't need to mock the Tauri runtime).
 */
let openLinkOverride: ((url: string) => Promise<void>) | null = null;
export function _setOpenLinkForTest(fn: ((url: string) => Promise<void>) | null): void {
  openLinkOverride = fn;
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // localStorage quota / disabled — banner just shows again next boot.
  }
}

/**
 * First-run welcome + boot-time health banner. Renders above the canvas
 * (below TopBar) ONLY when:
 *   - the user has zero projects, OR
 *   - the health check shows `claude` or `git` missing on PATH.
 *
 * Dismissable via the close button; the dismissed flag is persisted in
 * localStorage so subsequent boots stay quiet. Non-blocking — the banner
 * is informational, not a modal gate, and never blocks app boot.
 */
export function WelcomeBanner() {
  const projects = useProjectStore((s) => s.projects);
  const health = useHealthCheck();
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());

  // Re-read once on mount in case another tab toggled the flag (rare but
  // cheap; keeps local state in sync after a session-storage clear).
  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  if (dismissed) return null;

  const noProjects = projects.length === 0;
  // While the health check is in flight (`null`), assume nothing is missing —
  // we don't want a flash of warning text and then have it disappear when
  // the IPC resolves.
  const missing = health?.missing ?? [];
  const claudeMissing = missing.includes('claude');
  const gitMissing = missing.includes('git');

  if (!noProjects && !claudeMissing && !gitMissing) return null;

  function handleDismiss(): void {
    persistDismissed();
    setDismissed(true);
  }

  async function handleOpenInstall(): Promise<void> {
    try {
      const open = openLinkOverride
        ?? (await import('@tauri-apps/plugin-shell')).open;
      await open(CLAUDE_INSTALL_URL);
    } catch (err) {
      // External link failure is not user-facing — the URL also appears in
      // the banner copy so the user can copy/paste manually.
      console.warn('[welcome-banner] open install URL failed:', err);
    }
  }

  // Compose the message. Both conditions can fire simultaneously (a brand-new
  // user with no projects AND no claude installed); we render the no-projects
  // line first because it's the more immediate next step.
  const lines: { key: string; text: string; cta?: { label: string; onClick: () => void } }[] = [];
  if (noProjects) {
    lines.push({
      key: 'no-projects',
      text: 'Welcome — add a project in the sidebar to get started, then click Pipeline (⌘⇧P) to launch your first agentic run.',
    });
  }
  if (claudeMissing) {
    lines.push({
      key: 'claude-missing',
      text: 'Heads up — Claude Code CLI not on PATH. Pipeline runs need it.',
      cta: { label: 'Install instructions →', onClick: () => void handleOpenInstall() },
    });
  }
  if (gitMissing) {
    lines.push({
      key: 'git-missing',
      text: 'Heads up — git not on PATH. Pipeline runs and the Git tile both require it.',
    });
  }

  return (
    <div
      role="status"
      data-testid="welcome-banner"
      style={{
        background: 'var(--tx-tile-bg, #1a1a1a)',
        borderBottom: '1px solid var(--tx-accent, #4a9eff)',
        borderTop: '1px solid var(--tx-accent, #4a9eff)',
        color: 'var(--tx-fg, #e6e6e6)',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 13,
        lineHeight: 1.4,
        minHeight: 40,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
        {lines.map((line) => (
          <div key={line.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{line.text}</span>
            {line.cta && (
              <button
                type="button"
                onClick={line.cta.onClick}
                data-testid={`welcome-banner-cta-${line.key}`}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--tx-accent, #4a9eff)',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 13,
                  textDecoration: 'underline',
                }}
              >
                {line.cta.label}
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss welcome banner"
        data-testid="welcome-banner-dismiss"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--tx-fg, #e6e6e6)',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          padding: '4px 8px',
          opacity: 0.7,
        }}
      >
        ×
      </button>
    </div>
  );
}
