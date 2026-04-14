import { colors, typography, radius, spacing, fonts, alpha } from '@/design/tokens';

export function FocusMode() {
  return (
    <div style={{
      position: 'absolute',
      top: 12,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: spacing.sm,
      padding: '4px 12px',
      background: alpha(colors.primary, 9),
      border: `1px solid ${alpha(colors.primary, 27)}`,
      borderRadius: radius.full,
      zIndex: 9000,
      pointerEvents: 'none',
    }}>
      <div style={{
        width: 6, height: 6,
        borderRadius: radius.full,
        background: colors.primary,
      }} />
      <span style={{
        ...typography.labelSm,
        color: colors.primary,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        Focus Mode
      </span>
      <span style={{
        ...typography.labelSm,
        color: colors.secondary,
        fontFamily: fonts.mono,
      }}>
        Esc to exit
      </span>
    </div>
  );
}
