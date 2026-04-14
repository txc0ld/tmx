import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[AppErrorBoundary]', error); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#F87171', fontFamily: 'monospace', background: '#000', height: '100vh' }}>
          <h2 style={{ color: '#fff', marginBottom: 16 }}>TerminalX crashed</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, opacity: 0.6, marginTop: 8 }}>{this.state.error.stack}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer' }}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
