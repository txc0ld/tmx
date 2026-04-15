import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Count of render attempts — after a few fails we stop offering Retry. */
  retries: number;
}

/**
 * Root error boundary. Fires when a render throws inside the tree
 * (runtime async errors bubble to `window.onerror` / `unhandledrejection`
 * in `main.tsx`).
 *
 * Offers Retry (re-render from current state) for up to 3 attempts,
 * then falls back to Reload. Repeated retry usually means state is
 * corrupt and a full reload is the only path forward.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retries: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // eslint-disable-next-line no-console
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState(s => ({ error: null, retries: s.retries + 1 }));
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const { error, retries } = this.state;
    const retryExhausted = retries >= 3;

    return (
      <div
        role="alert"
        style={{
          padding: 48,
          color: '#F87171',
          fontFamily: "'JetBrains Mono', monospace",
          background: '#000',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 16,
        }}
      >
        <h2 style={{ color: '#fff', margin: 0, fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1.5rem' }}>
          TerminalX hit an error
        </h2>

        <p style={{ color: 'rgba(255,255,255,0.6)', margin: 0, fontSize: 14, fontFamily: 'inherit' }}>
          {retryExhausted
            ? 'Retry keeps failing — a full reload is the safest path. Your workspace auto-saved; tiles will return on restart.'
            : 'A tile or store threw during render. Try again below. If it keeps failing, reload the app.'}
        </p>

        <pre style={{
          whiteSpace: 'pre-wrap',
          fontSize: 13,
          margin: 0,
          padding: 16,
          background: 'rgba(248,113,113,0.08)',
          borderRadius: 6,
          border: '1px solid rgba(248,113,113,0.2)',
          maxWidth: '90vw',
          overflowX: 'auto',
        }}>
          {error.message}
        </pre>

        {error.stack && (
          <pre style={{
            whiteSpace: 'pre-wrap',
            fontSize: 11,
            opacity: 0.5,
            margin: 0,
            maxWidth: '90vw',
            overflowX: 'auto',
            maxHeight: '40vh',
          }}>
            {error.stack}
          </pre>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {!retryExhausted && (
            <button
              onClick={this.handleRetry}
              style={{
                padding: '10px 20px',
                cursor: 'pointer',
                background: '#CCFF00',
                color: '#000',
                border: 'none',
                borderRadius: 6,
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              Retry ({3 - retries} left)
            </button>
          )}
          <button
            onClick={this.handleReload}
            style={{
              padding: '10px 20px',
              cursor: 'pointer',
              background: 'transparent',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 6,
              fontFamily: 'inherit',
              fontSize: 14,
            }}
          >
            Reload app
          </button>
        </div>

        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 16, fontFamily: 'inherit' }}>
          If this keeps happening, file an issue at{' '}
          <a
            href="https://github.com/txc0ld/tmx/issues"
            style={{ color: '#CCFF00' }}
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/txc0ld/tmx/issues
          </a>
          {' '}with the message above.
        </p>
      </div>
    );
  }
}
