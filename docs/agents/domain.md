# Domain Docs

TerminalX is a single-context repo. The engineering skills should read repo-level context before making architectural, testing, or debugging decisions.

## Before exploring, read these if present

- `CONTEXT.md` at the repo root for domain language.
- `docs/adr/` for architecture decisions relevant to the touched area.
- Feature-specific docs under `docs/features/` when working on a named app capability.
- `CLAUDE.md` and `AGENTS.md` for current agent-facing project rules.

If `CONTEXT.md` or `docs/adr/` do not exist yet, proceed silently. The `grill-with-docs` skill can create them later when terminology or decisions need to be made durable.

## Layout

```text
/
|-- CLAUDE.md
|-- AGENTS.md
|-- docs/
|   |-- agents/
|   |-- features/
|   `-- adr/        # optional, created when ADRs exist
|-- src/
`-- src-tauri/
```

## Vocabulary

Use the project's existing terms: tile, canvas, wire, project, PTY, agent, pipeline run, and MCP connection. Avoid inventing alternate names unless the work explicitly introduces a new domain concept.

## ADR conflicts

If a recommendation contradicts an existing ADR, surface the conflict explicitly and explain why reopening the decision is worth considering.
