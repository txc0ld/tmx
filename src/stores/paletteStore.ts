import { create } from 'zustand';

interface PaletteState {
  open: boolean;
  query: string;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  toggle: () => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  query: '',
  setOpen: (open) => set({ open, query: '' }),
  setQuery: (query) => set({ query }),
  toggle: () => set(s => ({ open: !s.open, query: '' })),
}));
