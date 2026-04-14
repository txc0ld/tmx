import { create } from 'zustand';

const MAX_HISTORY = 100;

interface CommandHistoryState {
  // ptyId -> list of commands (most recent last)
  history: Record<string, string[]>;
  // Current partial line buffer per ptyId (accumulates until Enter)
  buffer: Record<string, string>;
  appendBuffer: (ptyId: string, data: string) => void;
  commitCommand: (ptyId: string) => void;
  getHistory: (ptyId: string) => string[];
  clearHistory: (ptyId: string) => void;
}

export const useCommandHistoryStore = create<CommandHistoryState>((set, get) => ({
  history: {},
  buffer: {},

  appendBuffer: (ptyId, data) => {
    // Filter out control sequences but keep printable chars
    // This captures what the user types, not terminal output
    const printable = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0e-\x1f]/g, '');
    if (!printable) return;

    set(s => ({
      buffer: { ...s.buffer, [ptyId]: (s.buffer[ptyId] || '') + printable },
    }));
  },

  commitCommand: (ptyId) => {
    const s = get();
    const cmd = (s.buffer[ptyId] || '').trim();
    if (!cmd) {
      set(ss => ({ buffer: { ...ss.buffer, [ptyId]: '' } }));
      return;
    }
    set(ss => {
      const prev = ss.history[ptyId] || [];
      // Deduplicate consecutive identical commands
      const last = prev[prev.length - 1];
      if (last === cmd) {
        return { buffer: { ...ss.buffer, [ptyId]: '' } };
      }
      const next = [...prev, cmd].slice(-MAX_HISTORY);
      return {
        history: { ...ss.history, [ptyId]: next },
        buffer: { ...ss.buffer, [ptyId]: '' },
      };
    });
  },

  getHistory: (ptyId) => get().history[ptyId] || [],

  clearHistory: (ptyId) =>
    set(s => {
      const next = { ...s.history };
      delete next[ptyId];
      return { history: next };
    }),
}));
