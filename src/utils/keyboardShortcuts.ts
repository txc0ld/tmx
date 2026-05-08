/**
 * Pure keyboard-shortcut detectors.
 *
 * Kept in its own module (rather than inline in App.tsx) so unit tests can
 * exercise the matching logic without dragging in the canvas / IPC / Tauri
 * world that App.tsx pulls transitively.
 */

/**
 * Cmd+Shift+P (mac) / Ctrl+Shift+P (Win/Linux) — open the pipeline launch
 * modal.
 *
 * Because Shift is held, browsers normally deliver `e.key` as uppercase
 * `'P'`, but we accept lowercase too as a defensive cross-browser hedge
 * (some IMEs / RDP clients have been seen to lowercase it).
 *
 * Input-focus guard: skips when focus is in a textarea or input — without
 * this the launch modal's own goal textarea would self-fire on the first
 * keystroke after open. The handler is also intended to skip held-key
 * repeats, but the caller owns that (use a state guard).
 */
export function isPipelineLaunchShortcut(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (!e.shiftKey) return false;
  if (e.key !== 'P' && e.key !== 'p') return false;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return false;
  return true;
}
