import { useEffect, useRef, useState, type CSSProperties } from 'react';

export type ConfirmableButtonVariant = 'danger' | 'neutral';

interface Props {
  /** Default-state button label (e.g. "Abort"). */
  label: string;
  /** Confirm-state label (e.g. "Confirm abort?"). */
  confirmLabel: string;
  /** Fired only on the second click within the confirm window. */
  onConfirm: () => void;
  /** ms after entering confirm state before reverting. Default 4000. */
  confirmDelayMs?: number;
  /** Visual tint when confirming. `danger` is brighter red than `neutral`. */
  variant?: ConfirmableButtonVariant;
  /** Optional title attribute for both states. */
  title?: string;
  /** Optional extra style merged onto the base. */
  style?: CSSProperties;
  /** Optional disabled flag. */
  disabled?: boolean;
}

const BASE_STYLE: CSSProperties = {
  padding: '4px 10px',
  color: 'var(--tx-text)',
  cursor: 'pointer',
  border: '1px solid var(--tx-border)',
  borderRadius: 3,
  background: 'var(--tx-surface-2)',
};

/**
 * Two-click confirmation button.
 *
 * Click 1 → enters "confirm" state with countdown next to the label.
 * Click 2 within `confirmDelayMs` → fires `onConfirm`.
 * Otherwise the timer reverts the button to its default state.
 *
 * Hover/focus styling is left to the browser; no extra handlers.
 */
export function ConfirmableButton({
  label,
  confirmLabel,
  onConfirm,
  confirmDelayMs = 4000,
  variant = 'danger',
  title,
  style,
  disabled,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  // Seconds remaining shown next to the label. Recomputed by an interval
  // so the user gets visible feedback while the window is open.
  const [remaining, setRemaining] = useState(0);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Always clean up on unmount so a slow click after the tile closes
  // doesn't fire onConfirm.
  useEffect(() => {
    return () => {
      if (revertTimer.current) clearTimeout(revertTimer.current);
      if (tickTimer.current) clearInterval(tickTimer.current);
    };
  }, []);

  const clearTimers = () => {
    if (revertTimer.current) {
      clearTimeout(revertTimer.current);
      revertTimer.current = null;
    }
    if (tickTimer.current) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
  };

  const handleClick = () => {
    if (disabled) return;
    if (confirming) {
      clearTimers();
      setConfirming(false);
      setRemaining(0);
      onConfirm();
      return;
    }
    // First click: enter confirm state, schedule revert + countdown.
    setConfirming(true);
    const totalSec = Math.max(1, Math.ceil(confirmDelayMs / 1000));
    setRemaining(totalSec);
    revertTimer.current = setTimeout(() => {
      setConfirming(false);
      setRemaining(0);
      revertTimer.current = null;
      if (tickTimer.current) {
        clearInterval(tickTimer.current);
        tickTimer.current = null;
      }
    }, confirmDelayMs);
    tickTimer.current = setInterval(() => {
      setRemaining(r => (r > 1 ? r - 1 : r));
    }, 1000);
  };

  const confirmBg =
    variant === 'danger'
      ? 'var(--tx-error, #f55)'
      : 'var(--tx-warning, #d2a25f)';

  const mergedStyle: CSSProperties = confirming
    ? {
        ...BASE_STYLE,
        background: confirmBg,
        borderColor: confirmBg,
        color: '#fff',
        ...style,
      }
    : { ...BASE_STYLE, ...style };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={title}
      style={mergedStyle}
      data-confirming={confirming ? 'true' : 'false'}
    >
      {confirming ? (
        <>
          {confirmLabel}
          <span style={{ marginLeft: 6, opacity: 0.85 }}>{remaining}s</span>
        </>
      ) : (
        label
      )}
    </button>
  );
}
