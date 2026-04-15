# TerminalX Design System

This document is the source of truth for the TerminalX visual language. The implementation lives in `src/design/tokens.ts` and `src/stores/themeStore.ts`; this file explains the intent, the conventions, and the rules that aren't obvious from reading the code.

## Design language

The system is called **Kinetic Topology**. Three ideas run through every decision:

1. **Energy** — a single high-saturation accent drives every active element (wires, selection, focus, primary buttons). Status distinctions go to dedicated semantic colors (green/red/yellow/orange), never to the accent.
2. **Flat depth** — there are no shadows, no 3D. Depth is communicated by surface tinting (surface-lowest → surface → surface-high) and by an accent outline when focused.
3. **Monospace-forward** — tiles are tools, not documents. JetBrains Mono is used aggressively for terminal-adjacent UI (paths, commands, file names in the file tree, status lines).

## Tokens

All tokens live in `src/design/tokens.ts` as readonly const objects. Components import `colors`, `spacing`, `radius`, `typography`, `fonts`, `glass`, `motion`, and `alpha` — nothing else. Hardcoded color strings, px values, or fonts in components are a smell; refactor to tokens.

### Colors

Every color token is a `var(--tx-*)` CSS custom property. The actual values are injected at runtime by `applyThemeToDOM()` in `themeStore.ts` when the user picks a theme, which means a single component automatically adapts to all 6 themes.

Surface hierarchy (dim → bright):

| Token | Use |
|---|---|
| `colors.bg` | Canvas background, window chrome backdrop |
| `colors.surfaceLowest` | Tile body on dark themes |
| `colors.surfaceLow` | Glass-panel background (topbar, dock, modals) |
| `colors.surface` | Tile header, elevated chrome |
| `colors.surfaceHigh` | Hover / selected backgrounds on interactive items |

Text hierarchy (strongest → weakest):

| Token | Use |
|---|---|
| `colors.onSurface` | Primary text |
| `colors.onSurfaceVariant` | Secondary text (at ~77% opacity of primary) |
| `colors.secondary` | Labels, metadata, placeholders |

Borders:

| Token | Use |
|---|---|
| `colors.outlineVariant` | Tile borders, dividers |
| `colors.outlineGhost` | Subtle separators inside tiles |

Semantic (never the accent):

| Token | Use |
|---|---|
| `colors.green` (`#34D399`) | Success, passing tests, connected state |
| `colors.red` (`#F87171`) | Error, failing tests, destructive confirm |
| `colors.yellow` (`#FBBF24`) | Warning, modified file indicator |
| `colors.orange` (`#FB923C`) | In-progress, running |

**Alpha values** — never concatenate `"var(--tx-accent)18"`; that produces invalid CSS. Use the `alpha(color, percent)` helper, which builds a `color-mix(in srgb, ...)` expression that works with CSS custom properties.

### Spacing

4px scale: `xs: 4, sm: 8, md: 16, lg: 24, xl: 32, 2xl: 48, 3xl: 64` (expressed in rem). Use these for padding, gap, margin — do not introduce arbitrary values like `12px`.

### Radius

`sm: 6, md: 8, lg: 10, xl: 12, full: 9999` (rem-expressed). Tile corners use `xl`. Pills/chips use `full`. Small buttons and inputs use `md`.

### Typography

All type is defined in `typography.*`. Reach for:

- `titleLg` / `titleMd` for tile titles, modal headings.
- `bodyMd` for body copy.
- `labelMd` / `labelSm` for chrome text, buttons, status lines.
- `displayMd` only for hero headings (welcome, onboarding).

Fonts are loaded in `index.html` with `font-display: swap`.

### Glass

The `glass` token is the recipe for the app's signature translucent panels (topbar, dock, command palette, modals). It composes surface-low + 20px backdrop-filter + ghost outline + rounded corner. `glassActive` adds an accent outline for the focused state.

On surfaces where the backdrop-filter is expensive (e.g. xterm viewport), don't use glass — use `surfaceLow` directly.

### Motion

`motion.*` defines standard durations for hover (150ms), focus (200ms), enter (300ms cubic-bezier), and two infinite loops (`pulseGlow`, `dataFlow`). Keep animations brief and physics-based. Avoid new timings unless nothing in the scale fits.

## Theming

Six built-in themes (5 dark + 1 light):

| ID | Name | Accent | BG | FG |
|---|---|---|---|---|
| `electric` | Electric | `#CCFF00` | `#000000` | `#FFFFFF` |
| `phantom` | Phantom | `#6600FF` | `#000000` | `#FFFFFF` |
| `ember` | Ember | `#F53F3F` | `#000000` | `#FFFFFF` |
| `ice` | Ice | `#22D3EE` | `#000000` | `#FFFFFF` |
| `snow` | Snow | `#FFFFFF` | `#000000` | `#FFFFFF` |
| `slate` | Slate (light) | `#2c3525` | `#CCD2BA` | `#000000` |

### Light theme surface inversion

**This is the rule that most often catches new contributors.** A light theme (`isLightBg(theme.bg) === true`) inverts the surface palette — tiles stay dark with white text while the canvas background goes light. This preserves readability for monospace content (code, terminal output, file trees) that would look awful on a light tile.

Implementation: `applyThemeToDOM()` sets the dark surface CSS vars (`--tx-surface-*`) to hardcoded dark values when the theme is light. Don't try to work around this — it's intentional.

Terminals also invert via `isLightTheme()` in the xterm wrappers, and Monaco switches to a custom dark variant even on light themes.

## Tile chrome

Every tile is rendered inside `TileShell.tsx` (memo'd). The shell provides:

- A title bar with the tile icon (filled circle, accent-colored), title, and 5 hover-revealed buttons: pin, clone, detach, save-as-template, close.
- The drag + resize handles (8 edges + 4 corners).
- The z-order focus ring (1px accent outline on focused tile).
- Snap-guide rendering during drag.

Custom content goes inside the shell as `children`. Components should never render their own title bar or close button — if you need a per-tile action, add it to the shell or use a tile-level secondary toolbar.

## Wiring colors

Wires are rendered in `WiringLayer.tsx` as SVG curves. Each wire type has a distinct color so users can read the canvas at a glance:

| Wire type | Intent | Color |
|---|---|---|
| `context-pipe` | Terminal output → Agent context | accent |
| `agent-chain` | Agent done → next Agent prompt | accent |
| `refresh-trigger` | Agent done → Browser reload | green |
| `task-assign` | Todo item → Agent prompt | yellow |
| `diff-feed` | Agent done → Diff tile | orange |
| `file-open` | FileTree click → Editor/Diff | cyan-ish (accent) |

Active wires pulse via `motion.dataFlow` for 1.2s after firing.

## Style conventions

### All inline styles

TerminalX does **not** use Tailwind, CSS modules, CSS-in-JS runtime libraries, or a global stylesheet for components. Every component renders with `style={{ ... }}` props, sourcing values from `tokens.ts`. This:

- Keeps token traceability — you can grep for `colors.primary` and find every use.
- Avoids build-time CSS bloat.
- Makes tree-shaking trivial.

Exceptions: `xterm.css` (imported from the library), `index.css` (font face + CSS var bootstrap), and Monaco's own stylesheet (loaded by `@monaco-editor/react`).

### No `className` for layout

Don't mix `className` and `style` on the same element. Pick `style`.

### Icons

Tiny inline SVGs or unicode glyphs. No icon library. Keep them ~12-16px and always colored via `currentColor` so they inherit theme.

### Interactive feedback

- Hover: `colors.surfaceHigh` background.
- Active/selected: `alpha(colors.primary, 7)` background + `colors.primary` text.
- Focus ring: `0 0 0 1px colors.primary` box-shadow (never `outline` — it clips on CSS-transformed canvases).

## Adding a new theme

1. Add the `Theme` object to `DEFAULT_THEMES` in `themeStore.ts`.
2. If the new theme is light (`isLightBg(bg) === true`), no extra work — `applyThemeToDOM` will invert surfaces for you.
3. Test both terminal tiles (xterm should flip) and Monaco tiles (DiffEditor should stay dark).
4. If the accent is very low-saturation (e.g. grey), verify wires are still legible against the canvas background.

## Adding a new tile type

1. Add the literal to the `TileType` union in `types/index.ts`.
2. Add the interface extending `TileBase` in the same file.
3. Add the tile to the `Tile` discriminated union at the bottom of `types/index.ts`.
4. Add an entry to `tileColors` in `tokens.ts`.
5. Create the component under `src/components/tiles/`, wrap with `TileShell`, source all colors from `tokens.ts`.
6. Render the new case in `InfiniteCanvas.tsx`.
7. Add default-config for the dock spawn (`TileDock.tsx → spawnTileFromEntry`).
8. Add a validator in `src/utils/workspaceImport.ts` for the new shape.

## References

- `src/design/tokens.ts` — tokens source.
- `src/stores/themeStore.ts` — theme application + light-theme inversion.
- `src/components/canvas/TileShell.tsx` — tile chrome.
- `src/components/canvas/WiringLayer.tsx` — wire rendering.
- `src/utils/workspaceImport.ts` — workspace import validators (per-tile-type schema).
- `FEATURES.md` — product-facing feature tour.
- `WIRING.md` — wire semantics and routing.
