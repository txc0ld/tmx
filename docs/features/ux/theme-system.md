# Theme System

> 6 themes (5 dark + 1 light), with a light-theme surface inversion rule.

## What it is

The app supports 6 themes: **Electric**, **Phantom**, **Ember**, **Ice**, **Snow** (dark), and **Slate** (light). Each has a distinct accent color that drives wires, focus rings, active states, and selection.

| ID | Name | Accent | BG | FG |
|---|---|---|---|---|
| `electric` | Electric | `#CCFF00` | `#000000` | `#FFFFFF` |
| `phantom` | Phantom | `#6600FF` | `#000000` | `#FFFFFF` |
| `ember` | Ember | `#F53F3F` | `#000000` | `#FFFFFF` |
| `ice` | Ice | `#22D3EE` | `#000000` | `#FFFFFF` |
| `snow` | Snow | `#FFFFFF` | `#000000` | `#FFFFFF` |
| `slate` | Slate (light) | `#2c3525` | `#CCD2BA` | `#000000` |

## How to switch

- Command Palette → "Set Theme" → pick one.
- Or click the theme dot in the status bar to cycle.
- Theme preference persisted to `localStorage['tx-theme']`.

## Power moves

- **Screenshot theme.** Use Snow (pure white on black) for high-contrast screenshots that readright on any background.
- **Demo palette.** Phantom's purple accent looks clean in presentations.
- **Low-light dev.** Ember's red accent reduces blue-light eye strain late at night.
- **Light mode on projectors.** Slate is the go-to when you're presenting on a projector and dark themes wash out.

## Light-theme surface inversion

When the theme's background is light (`isLightBg(theme.bg) === true`), `applyThemeToDOM` sets **dark surface CSS vars** for tile bodies and chrome. So: canvas is light, tiles stay dark with white text. This is intentional — code in terminals and Monaco is unreadable on light tile surfaces.

Each xterm instance also flips its own theme to a dark variant when the outer theme is light. Monaco switches to a custom dark editor theme regardless of the outer theme.

## Tech notes

- Colors set as CSS custom properties on `document.documentElement`: `--tx-accent`, `--tx-fg`, `--tx-bg`, `--tx-surface`, `--tx-surface-low`, `--tx-surface-high`, `--tx-on-surface`, `--tx-secondary`, `--tx-outline-*`, `--tx-glow*`.
- All design tokens in `src/design/tokens.ts` reference `var(--tx-*)` — so themes Just Work for any component using tokens.
- Alpha helper: `alpha(color, percent)` uses `color-mix(in srgb, ${c} ${p}%, transparent)` — works with CSS custom properties, unlike appending hex alpha digits.
- Custom theme? `addTheme` in `themeStore` accepts any `{ id, name, accent, fg, bg }` — user themes persist to localStorage.

**Key files:** `src/stores/themeStore.ts`, `src/design/tokens.ts`, [DESIGN.md](../../../DESIGN.md).

## Related

- [Design system](../../../DESIGN.md) · [Tile dock](../canvas/tile-dock.md)
