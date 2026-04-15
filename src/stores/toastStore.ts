import { create } from 'zustand';

export type ToastType = 'info' | 'success' | 'error' | 'warning';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  /** Increments every time a duplicate `(message, type)` is suppressed while
   *  the original is still visible. Rendered as "× N" in the toast body. */
  count: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, type?: ToastType) => void;
  removeToast: (id: string) => void;
  /** Dev/test hook — clears everything. */
  clearToasts: () => void;
}

/** Cap to protect the UI from pathological error storms. */
const MAX_VISIBLE = 6;
/** Lifetime per toast. */
const TTL_MS = 4000;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (message, type = 'info') => {
    let wasMerged = false;
    set(s => {
      // Dedupe: if an identical toast is already on screen, bump its count
      // instead of stacking another. Protects against 50x "Save failed" loops.
      const existingIdx = s.toasts.findIndex(t => t.message === message && t.type === type);
      if (existingIdx >= 0) {
        wasMerged = true;
        return {
          toasts: s.toasts.map((t, i) => i === existingIdx ? { ...t, count: t.count + 1 } : t),
        };
      }

      // Cap the on-screen count. Oldest drops off when we hit the ceiling.
      const id = crypto.randomUUID();
      const trimmed = s.toasts.length >= MAX_VISIBLE ? s.toasts.slice(1) : s.toasts;
      return { toasts: [...trimmed, { id, message, type, count: 1 }] };
    });

    // Only schedule a TTL for a fresh toast — merged ones ride the existing
    // timer. Keeps the dismissal logic simple and prevents a long-running
    // error storm from keeping the same toast visible indefinitely.
    if (!wasMerged) {
      setTimeout(() => {
        set(s => ({ toasts: s.toasts.filter(t => !(t.message === message && t.type === type)) }));
      }, TTL_MS);
    }

    // Record timeline event once per unique occurrence (not per merge) so
    // the audit log isn't flooded by coalesced duplicates.
    if (!wasMerged) {
      import('@/stores/timelineStore').then(({ useTimelineStore }) => {
        useTimelineStore.getState().recordEvent(
          'command-executed',
          message,
          `Toast: ${type}`,
        );
      }).catch(() => {});
    }
  },

  removeToast: (id) =>
    set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  clearToasts: () => set({ toasts: [] }),
}));
