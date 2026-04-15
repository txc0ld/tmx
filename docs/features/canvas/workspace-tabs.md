# Workspace Tabs

> Multiple canvases inside one project.

## What it is

A project can hold several independent canvases, each with its own tiles/wires/transform. Tabs live at the top-center of the canvas; click to switch, right-click to rename/delete.

## How to use

- Add a tab via the `+` button in the workspace-tab row.
- Click a tab to switch — tiles from the other workspace are hidden (not destroyed).
- Right-click → Rename or Delete.
- Only one workspace is "active" per project at a time; others remain persisted but invisible.

## Power moves

- **Workflow separation.** `Backend` workspace (terminals, git, tests), `Frontend` workspace (editor, browser, dev server), `Docs` workspace (notes, browser on your docs site).
- **Agent-focused workspaces.** One workspace per long-running agent session — agent stays running when you switch away.
- **Scratch vs real.** Use one workspace for production work and a second "scratch" workspace for exploratory agents or prototypes.
- **Demo setup.** A tab per slide — tiles arranged for each demo beat, switch via tabs on cue.

## Tech notes

- Stored in `canvasStore`: `workspaceNames: Record<projectId, string[]>` + `activeWorkspace: Record<projectId, string>`.
- Each workspace's tiles/wires are scoped by composite key `${projectId}:${workspaceName}` internally; the `canvasStore` selectors scope to the active one.
- Persisted with the workspace save format — tabs survive restarts.
- Default workspace is called `"default"` and is implicit for new projects.

**Key files:** `src/components/canvas/WorkspaceTabs.tsx`, `src/stores/canvasStore.ts`.

## Related

- [Infinite canvas](./infinite-canvas.md) · [Layout slots](./layouts.md) · [Workspace persistence](../persistence/workspace.md)
