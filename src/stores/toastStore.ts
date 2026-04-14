import { create } from 'zustand';

export type ToastType = 'info' | 'success' | 'error' | 'warning';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastState {
  toasts: Toast[];
  addToast: (message: string, type?: ToastType) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (message, type = 'info') => {
    const id = crypto.randomUUID();
    set(s => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
      set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));
    }, 4000);

    // Record timeline event for toasts (lazy import to avoid circular deps)
    import('@/stores/timelineStore').then(({ useTimelineStore }) => {
      useTimelineStore.getState().recordEvent(
        type === 'error' ? 'command-executed' : 'command-executed',
        message,
        `Toast: ${type}`,
      );
    }).catch(() => {});
  },

  removeToast: (id) =>
    set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));
