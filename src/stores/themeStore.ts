import { create } from 'zustand';

export interface Theme {
  id: string;
  name: string;
  accent: string;
  fg: string;
  bg: string;
}

const DEFAULT_THEMES: Theme[] = [
  { id: 'electric', name: 'Electric', accent: '#CCFF00', fg: '#FFFFFF', bg: '#000000' },
  { id: 'phantom', name: 'Phantom', accent: '#6600FF', fg: '#FFFFFF', bg: '#000000' },
  { id: 'ember', name: 'Ember', accent: '#F53F3F', fg: '#FFFFFF', bg: '#000000' },
  { id: 'ice', name: 'Ice', accent: '#22D3EE', fg: '#FFFFFF', bg: '#000000' },
  { id: 'snow', name: 'Snow', accent: '#FFFFFF', fg: '#FFFFFF', bg: '#000000' },
  { id: 'slate', name: 'Slate', accent: '#2c3525', fg: '#000000', bg: '#CCD2BA' },
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function mixHex(base: string, blend: string, amount: number): string {
  const b = hexToRgb(base);
  const bl = hexToRgb(blend);
  const r = Math.round(b.r + (bl.r - b.r) * amount);
  const g = Math.round(b.g + (bl.g - b.g) * amount);
  const bv = Math.round(b.b + (bl.b - b.b) * amount);
  return `rgb(${r},${g},${bv})`;
}

function isLightBg(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}

function applyThemeToDOM(theme: Theme) {
  const s = document.documentElement.style;
  const light = isLightBg(theme.bg);

  s.setProperty('--tx-accent', theme.accent);
  s.setProperty('--tx-fg', theme.fg);
  s.setProperty('--tx-bg', theme.bg);

  // Derived surfaces
  s.setProperty('--tx-surface-lowest', light ? '#262b22' : theme.bg);
  s.setProperty('--tx-surface-low', light ? 'rgba(45,50,40,0.85)' : rgba(theme.bg, 0.4));
  s.setProperty('--tx-surface', light ? mixHex(theme.bg, theme.fg, 0.12) : mixHex(theme.bg, theme.fg, 0.08));
  s.setProperty('--tx-surface-high', light ? 'rgba(55,60,50,0.9)' : rgba(theme.fg, 0.12));

  // Text — light themes get white text on dark tile surfaces
  s.setProperty('--tx-on-surface', light ? '#FFFFFF' : theme.fg);
  s.setProperty('--tx-on-surface-variant', light ? 'rgba(255,255,255,0.77)' : rgba(theme.fg, 0.77));
  s.setProperty('--tx-secondary', light ? 'rgba(255,255,255,0.5)' : rgba(theme.accent, 0.7));

  // Borders
  s.setProperty('--tx-outline-ghost', light ? 'rgba(255,255,255,0.08)' : rgba(theme.fg, 0.06));
  s.setProperty('--tx-outline-variant', light ? 'rgba(255,255,255,0.18)' : rgba(theme.fg, 0.15));

  // Glow
  s.setProperty('--tx-glow', rgba(theme.accent, light ? 0.06 : 0.04));
  s.setProperty('--tx-glow-strong', rgba(theme.accent, light ? 0.15 : 0.12));

  // Update body background for light themes
  document.body.style.background = theme.bg;
}

interface ThemeState {
  themes: Theme[];
  activeThemeId: string;
  setTheme: (id: string) => void;
  getActiveTheme: () => Theme;
  applyCurrentTheme: () => void;
}

const storedId = typeof localStorage !== 'undefined' ? localStorage.getItem('tx-theme') : null;

export const useThemeStore = create<ThemeState>((set, get) => ({
  themes: DEFAULT_THEMES,
  activeThemeId: storedId || 'electric',

  setTheme: (id: string) => {
    set({ activeThemeId: id });
    localStorage.setItem('tx-theme', id);
    const theme = DEFAULT_THEMES.find(t => t.id === id) || DEFAULT_THEMES[0];
    applyThemeToDOM(theme);
  },

  getActiveTheme: () => {
    const { activeThemeId, themes } = get();
    return themes.find(t => t.id === activeThemeId) || themes[0];
  },

  applyCurrentTheme: () => {
    const theme = get().getActiveTheme();
    applyThemeToDOM(theme);
  },
}));
