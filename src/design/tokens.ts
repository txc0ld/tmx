// Kinetic Topology Design System — Theme-aware via CSS custom properties
// All color values reference --tx-* CSS vars set by themeStore.ts

export const colors = {
  // Surfaces
  bg: 'var(--tx-bg)',
  bgVoid: 'var(--tx-bg)',
  surfaceDim: 'var(--tx-bg)',
  surfaceLowest: 'var(--tx-surface-lowest)',
  surfaceLow: 'var(--tx-surface-low)',
  surface: 'var(--tx-surface)',
  surfaceHigh: 'var(--tx-surface-high)',
  surfaceTint: 'var(--tx-glow)',

  // Primary — energy, active states, kinetic connections
  primary: 'var(--tx-accent)',
  primaryFixed: 'var(--tx-accent)',
  onPrimaryFixed: 'var(--tx-bg)',

  // Text hierarchy
  onSurface: 'var(--tx-on-surface)',
  onSurfaceVariant: 'var(--tx-on-surface-variant)',
  secondary: 'var(--tx-secondary)',

  // Borders
  outlineVariant: 'var(--tx-outline-variant)',
  outlineGhost: 'var(--tx-outline-ghost)',

  // Shadows
  glow: 'var(--tx-glow)',
  glowStrong: 'var(--tx-glow-strong)',

  // Semantic status colors — NOT mapped to accent so toasts/alerts are distinct
// NOTE: Never concatenate hex alpha digits onto CSS var() strings — it produces
// invalid CSS like "var(--tx-accent)18". Use the alpha() helper below instead.
  green: '#34D399',
  red: '#F87171',
  yellow: '#FBBF24',
  blue: 'var(--tx-accent)',
  orange: '#FB923C',
  cyan: 'var(--tx-accent)',
  purple: 'var(--tx-accent)',
  pink: 'var(--tx-accent)',
} as const;

export const radius = {
  sm: '0.375rem',
  md: '0.5rem',
  lg: '0.625rem',
  xl: '0.75rem',
  full: '9999px',
} as const;

export const spacing = {
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  '2xl': '3rem',
  '3xl': '4rem',
} as const;

export const fonts = {
  title: "'Plus Jakarta Sans', sans-serif",
  body: "'Public Sans', sans-serif",
  mono: "'JetBrains Mono', monospace",
} as const;

export const typography = {
  displayMd: { fontFamily: fonts.body, fontWeight: 600, fontSize: '2.25rem', letterSpacing: '0.02em' },
  titleLg:   { fontFamily: fonts.title, fontWeight: 700, fontSize: '1.375rem', letterSpacing: '0' },
  titleMd:   { fontFamily: fonts.title, fontWeight: 700, fontSize: '1.125rem', letterSpacing: '0' },
  bodyMd:    { fontFamily: fonts.body, fontWeight: 400, fontSize: '0.9375rem', letterSpacing: '0' },
  labelMd:   { fontFamily: fonts.body, fontWeight: 500, fontSize: '0.8125rem', letterSpacing: '0.01em' },
  labelSm:   { fontFamily: fonts.body, fontWeight: 500, fontSize: '0.6875rem', letterSpacing: '0.02em' },
} as const;

// Glass Recipes
export const glass = {
  background: colors.surfaceLow,
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  border: `1px solid ${colors.outlineGhost}`,
  borderRadius: radius.xl,
  boxShadow: 'none',
} as const;

export const glassActive = {
  ...glass,
  boxShadow: `0 0 0 1px ${colors.primary}`,
} as const;

// Animation Tokens
export const motion = {
  hover: '150ms ease',
  focus: '200ms ease',
  enter: '300ms cubic-bezier(0.16, 1, 0.3, 1)',
  pulseGlow: '2s ease-in-out infinite',
  dataFlow: '1.2s linear infinite',
} as const;

// Tile indicator dots — fixed #CCFF00 for visibility across all themes
export const tileColors: Record<string, string> = {
  agent: '#CCFF00',
  'agent-claude': '#CCFF00',
  'agent-codex': '#CCFF00',
  'agent-gemini': '#CCFF00',
  terminal: '#CCFF00',
  browser: '#CCFF00',
  todo: '#CCFF00',
  diff: '#CCFF00',
  editor: '#CCFF00',
  note: '#CCFF00',
  kanban: '#CCFF00',
  filetree: '#CCFF00',
  group: '#CCFF00',
  runner: '#CCFF00',
  ssh: '#CCFF00',
  docker: '#CCFF00',
  git: '#CCFF00',
  usage: '#CCFF00',
};

export const agentColors: Record<string, string> = {
  claude: colors.primary,
  codex: colors.primary,
  gemini: colors.primary,
};

/**
 * Create a translucent version of a CSS custom-property color.
 * Uses CSS color-mix() so it works with var(--tx-*) values.
 *
 * @param cssColor  A CSS color value, e.g. `colors.primary` or `'var(--tx-accent)'`
 * @param percent   Opacity percentage 0-100
 */
export function alpha(cssColor: string, percent: number): string {
  return `color-mix(in srgb, ${cssColor} ${Math.round(percent)}%, transparent)`;
}
