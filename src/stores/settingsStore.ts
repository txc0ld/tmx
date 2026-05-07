import { create } from 'zustand';

/**
 * Settings panel categories. Sub-panels are added in subsequent Phase-3a tasks
 * (3a.2 / 3a.4 / 3a.5); for now the body is a placeholder that surfaces the
 * active category to the user.
 */
export const SETTINGS_CATEGORIES = ['project', 'agents', 'pipeline', 'plugins', 'about'] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

const ACTIVE_CATEGORY_KEY = 'tx-settings-active-category';
const DEFAULT_CATEGORY: SettingsCategory = 'project';

function isValidCategory(value: string | null): value is SettingsCategory {
  return value !== null && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

function loadCategory(): SettingsCategory {
  try {
    const raw = localStorage.getItem(ACTIVE_CATEGORY_KEY);
    if (isValidCategory(raw)) return raw;
  } catch {
    // localStorage may be unavailable (e.g. SSR/test).
  }
  return DEFAULT_CATEGORY;
}

function persistCategory(category: SettingsCategory): void {
  try {
    localStorage.setItem(ACTIVE_CATEGORY_KEY, category);
  } catch {
    // Best-effort. Quota / privacy modes shouldn't crash the app.
  }
}

interface SettingsState {
  open: boolean;
  category: SettingsCategory;
  /** Open the panel. If `category` is supplied, switch to it; otherwise reuse last-viewed. */
  openAt: (category?: SettingsCategory) => void;
  close: () => void;
  setCategory: (category: SettingsCategory) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  open: false,
  category: loadCategory(),
  openAt: (category) => {
    if (category) {
      persistCategory(category);
      set({ open: true, category });
    } else {
      set({ open: true });
    }
  },
  close: () => set({ open: false }),
  setCategory: (category) => {
    persistCategory(category);
    set({ category });
  },
}));
