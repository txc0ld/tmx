# Git Tile

> Git UI with status, log, branches, stage, commit.

## What it is

A three-tab git panel: **Status** (working tree + dirty files + commit), **Log** (last 30 commits), **Branches** (list + checkout). Runs `git` on the Rust side via `tokio::process::Command`.

## How to use

- Add a Git tile. `repoPath` defaults to the project cwd.
- **Status tab:** Lists modified/added/deleted/untracked files with colored icons. Click to stage/unstage. Type a message + **Commit** when ready.
- **Log tab:** Shows last 30 commits with short hash, author, date, message.
- **Branches tab:** Lists branches. Click one to `git checkout`.
- Auto-refreshes every 30 seconds.

## Use cases

**Commit without leaving the canvas.** Stage + commit from the tile — keyboard-free for small changes.

**Branch switcher.** Jump between branches while a Terminal tile runs tests; the Git tile's branch list is a 2-click `checkout`.

**Quick diff.** Pair with a [Diff tile](./diff.md) in git mode — Git tile drives the working-tree state, Diff shows per-file changes.

## Tech notes

- 11 git commands in `commands/git.rs`: `git_available`, `git_clone`, `git_status`, `git_log`, `git_branches`, `git_checkout`, `git_diff_summary`, `git_files_status`, `git_show_head_file`, `git_stage`, `git_unstage`, `git_commit`.
- `validate_git_url` rejects `ext::` / `transport::` remote helpers, loopback hosts, and malformed URLs. Clone additionally passes `-c protocol.ext.allow=never -c protocol.file.allow=never` and `--` to block remote-helper RCE.
- Branch names validated against git refname rules: no `..`, no `@{`, no control chars / spaces / `~^:?*[`.
- Repo path accepts `~` (tilde-expanded); no scheme validation needed because all operations shell out to `git` with the path as cwd.

**Key files:** `src/components/tiles/GitTile.tsx`, `src-tauri/src/commands/git.rs`.

## Related

- [Diff tile](./diff.md) · [File Tree tile](./filetree.md) · [Terminal tile](./terminal.md)
