import { colors, radius, motion, alpha } from '@/design/tokens';

interface WiringPortProps {
  tileId: string;
  port: string;
  side: 'left' | 'right';
  isActive: boolean;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
}

export function WiringPort({ isActive, onPointerDown, onPointerUp }: WiringPortProps) {
  return (
    <div
      onPointerDown={e => { e.stopPropagation(); onPointerDown?.(); }}
      onPointerUp={e => { e.stopPropagation(); onPointerUp?.(); }}
      style={{
        width: 12,
        height: 12,
        borderRadius: radius.full,
        border: `2px solid ${isActive ? colors.primary : colors.outlineVariant}`,
        background: isActive ? colors.primary : colors.surface,
        cursor: 'crosshair',
        transition: `all ${motion.hover}`,
        boxShadow: isActive ? `0 0 6px ${alpha(colors.primary, 27)}` : 'none',
      }}
    />
  );
}
