import { Component, type ReactNode, type ErrorInfo } from 'react';
import { colors, fonts, spacing, radius } from '@/design/tokens';

interface Props {
  tileId: string;
  tileType: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: string | null;
}

export class TileErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[TileErrorBoundary] ${this.props.tileType} tile crashed:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: spacing.md,
          gap: spacing.sm,
          color: colors.onSurfaceVariant,
          fontFamily: fonts.mono,
          fontSize: '0.75rem',
          textAlign: 'center',
        }}>
          <span style={{ fontSize: '1.25rem' }}>!</span>
          <span style={{ opacity: 0.7 }}>
            {this.props.tileType} tile crashed
          </span>
          <span style={{
            fontSize: '0.625rem',
            opacity: 0.4,
            maxWidth: '90%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {this.state.error}
          </span>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: spacing.xs,
              background: 'transparent',
              border: `1px solid ${colors.outlineVariant}`,
              borderRadius: radius.sm,
              color: colors.primary,
              fontFamily: fonts.mono,
              fontSize: '0.625rem',
              padding: '2px 8px',
              cursor: 'pointer',
            }}
          >
            retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
