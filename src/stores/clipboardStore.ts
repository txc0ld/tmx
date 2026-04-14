import { create } from 'zustand';

export interface ClipboardEntry {
  id: string;
  content: string;
  source: string;
  timestamp: number;
}

interface ClipboardState {
  entries: ClipboardEntry[];
  addEntry: (content: string, source: string) => void;
  clear: () => void;
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  entries: [],

  addEntry: (content, source) =>
    set(s => {
      const entry: ClipboardEntry = {
        id: crypto.randomUUID(),
        content: content.slice(0, 2000),
        source,
        timestamp: Date.now(),
      };
      return { entries: [entry, ...s.entries].slice(0, 50) };
    }),

  clear: () => set({ entries: [] }),
}));

// Listen for copy events globally
if (typeof document !== 'undefined') {
  document.addEventListener('copy', () => {
    setTimeout(() => {
      const selection = window.getSelection()?.toString();
      if (selection && selection.trim()) {
        useClipboardStore.getState().addEntry(selection.trim(), 'selection');
      }
    }, 0);
  });
}
