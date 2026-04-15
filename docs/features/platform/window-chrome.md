# Window Chrome

> Platform-aware title bar and window controls.

## What it is

TerminalX draws its own title bar so the app's top row can host the Layout menu, Clear Canvas button, project switcher, and theme toggle. Window controls (minimize / maximize / close) need to match each OS's expectations.

## Per-platform behavior

| Platform | Title bar | Window controls |
|---|---|---|
| **macOS** | `titleBarStyle: "Overlay"` with `hiddenTitle: true`. Native traffic lights show in their usual place. | Custom buttons in `TopBar.tsx` **hidden** — macOS users use the native ones. Traffic light position set via `trafficLightPosition: { x: 16, y: 14 }` in `tauri.conf.json`. |
| **Windows** | Native decorations off; custom chrome owns the full top row. | Three accent-colored buttons (─ □ ✕) in `TopBar.tsx`. |
| **Linux** | Same as Windows: custom chrome + accent buttons. | Same. |

## Power moves

- **Focus mode hides chrome.** When focus mode is active, the top bar dims to reduce distraction.
- **Theme-aware buttons.** Window controls use the current theme's accent for the button background, black for the symbol. High-contrast at any theme.
- **Click-to-switch project.** Project name in the top bar is a palette shortcut — click to open "Switch Project".

## Tech notes

- Platform detection via `utils/platform.ts`: `isMac()` / `isWindows()` / `modShortcut(k)`. Used to hide custom controls on macOS and to render `⌘K` vs `Ctrl+K` in hints.
- `TopBar.tsx` uses `isMac()` to conditionally render the control buttons. Everything else renders unconditionally.
- `tauri.conf.json`:
  - `titleBarStyle: "Overlay"` — macOS draws traffic lights on top of the window's top row.
  - `hiddenTitle: true` — hides the default title text (we draw our own).
  - `trafficLightPosition` — nudges the macOS controls slightly to align with the topbar's vertical midline.

**Key files:** `src/components/topbar/TopBar.tsx`, `src/utils/platform.ts`, `src-tauri/tauri.conf.json`.

## Related

- [Layout slots](../canvas/layouts.md) · [Theme system](../ux/theme-system.md)
