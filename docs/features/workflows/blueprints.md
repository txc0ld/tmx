# Wire Blueprints

> Save an entire tile + wire composition as a named pattern. Apply it anywhere with one click.

## What it is

A **blueprint** is a multi-tile pattern: N tiles + their wires + relative positions, saved as a single named asset. Where [templates](../ux/templates.md) handle one tile's config, blueprints handle whole workflows — Runner + Agent wired together, or Git + Diff + Editor + FileTree wired into a review layout, or three agents side-by-side for comparison.

Think Figma: templates are **primitives**, blueprints are **components**.

## How to use

- **Apply a built-in**: Command Palette → `🧩 Apply: <name>`. Tiles spawn at the current viewport with their wires recreated.
- **Save the current canvas**: Command Palette → `💾 Save Canvas as Blueprint…` → name + description. Captures every tile and wire on the active workspace.
- **Save a selection**: Shift-drag to select tiles → Command Palette → `💾 Save Selection as Blueprint…`. Only wires whose *both* endpoints are in the selection survive the capture (no dangling refs).
- Built-in blueprints can't be deleted; user ones can (delete action via the palette, coming soon).

## Built-in blueprints

**🔧 Auto-fix test loop**
Runner (`pnpm test`) + Claude agent, context-pipe wired with auto-pipe on. Test output pipes to Claude with a "diagnose + fix" prompt template. Red → agent fires. Green → it says DONE.

**🔍 Review workflow**
Git + Diff + Editor + FileTree. FileTree is file-open-wired into both Diff (git mode) and Editor. Click a file → diff + open content, both visible at once.

**⚔️ Triple-agent debate**
Claude + Codex + Gemini side-by-side. No wires — just positioned. Use when you want to run the same prompt across three models and compare.

## Power moves

- **Ship a team pattern library.** Save your org's "code review blueprint", "deploy dashboard blueprint", "on-call triage blueprint". Commit the localStorage JSON to a dotfile. Whole team applies in one click.
- **Compose with starter layouts.** [Starter layout](./starter-layouts.md) builds the base (Terminal + Runner + Git), then a blueprint layers a specific workflow on top (auto-fix loop wired in).
- **Compose with prompt library.** Apply a blueprint (spawns the agent), then run a [prompt](./prompt-library.md) (hands it a task). Two palette actions = whole workflow running.
- **Use selection capture for surgical patterns.** Experimenting with a new flow? Shift-drag the 4 tiles that matter, save-as-blueprint, drop it into any project later.

## How capture + apply works

**Capture** normalizes everything to a bounding-box origin. A tile at `(1500, 800)` becomes a blueprint tile with `relX: 0, relY: 0` if it's the top-left of the set. Runtime fields (`id`, `ptyId`, `status`, `elapsed`, `connected`, `containers`, `lastOutput`) are stripped — so applying a blueprint won't try to reuse a dead PTY or carry over a stale status.

**Apply** mints fresh IDs for every tile, offsets to an anchor (screen-center by default), then rewires with the new IDs by index. The blueprint's `fromIdx: 0, toIdx: 1` becomes `fromTile: <new-id-0>, toTile: <new-id-1>`. Original blueprint unchanged; you can apply it 100 times.

## Tech notes

- Store: `src/stores/blueprintStore.ts` — Zustand + localStorage. Built-ins in code; user blueprints in `localStorage['tx-blueprints']`.
- `captureBlueprint(name, desc, tiles, wires, icon?)` returns a `Blueprint` with normalized coords. Wires with endpoints outside the tile set are dropped silently.
- `instantiateBlueprint(bp, anchor)` returns `{ tiles: Tile[], wires: Wire[] }`. Caller inserts via `canvasStore.addTile` + `addWire`.
- Blueprints use *indexes* (not IDs) to reference tiles across save/load — makes cross-export portable and immune to ID collisions.
- 4 KB of bundle weight for the store + palette wiring.

**Key files:** `src/stores/blueprintStore.ts`, `src/components/palette/CommandPalette.tsx` (blueprint block).

## Related

- [Templates](../ux/templates.md) · [Starter layouts](./starter-layouts.md) · [Prompt library](./prompt-library.md) · [Command palette](../ux/command-palette.md) · [Wiring overview](../wiring/overview.md)
