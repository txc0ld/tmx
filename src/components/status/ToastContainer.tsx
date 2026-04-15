import { useToastStore } from '@/stores/toastStore';
import { colors, radius, spacing, typography, glass, alpha } from '@/design/tokens';
import type { ToastType } from '@/stores/toastStore';

const EMPTY_TOASTS: never[] = [];

function toastColor(type: ToastType): string {
  switch (type) {
    case 'success': return colors.green;
    case 'error': return colors.red;
    case 'warning': return colors.yellow;
    case 'info':
    default: return colors.secondary;
  }
}

function toastBorderColor(type: ToastType): string {
  switch (type) {
    case 'success': return `1px solid ${alpha(colors.green, 30)}`;
    case 'error': return `1px solid ${alpha(colors.red, 30)}`;
    case 'warning': return `1px solid ${alpha(colors.yellow, 30)}`;
    case 'info':
    default: return `1px solid ${colors.outlineGhost}`;
  }
}

export function ToastContainer() {
  const toasts = useToastStore(s => s.toasts) ?? EMPTY_TOASTS;
  const removeToast = useToastStore(s => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: 'fixed',
        bottom: 40,
        right: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: spacing.sm,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      {toasts.map(toast => (
        <div
          key={toast.id}
          onClick={() => removeToast(toast.id)}
          style={{
            ...glass,
            padding: `${spacing.sm} ${spacing.md}`,
            borderRadius: radius.md,
            color: toastColor(toast.type),
            border: toastBorderColor(toast.type),
            background: alpha(toastColor(toast.type), 8),
            ...typography.labelMd,
            pointerEvents: 'auto',
            cursor: 'pointer',
            animation: 'toastIn 300ms cubic-bezier(0.16, 1, 0.3, 1)',
            maxWidth: 320,
          }}
        >
          {toast.message}
        </div>
      ))}
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(8px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
