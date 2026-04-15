# Filesystem Access

> Broad-scope IPC for power-user FS use.

## What it is

TerminalX is a terminal/workspace power tool, not a sandboxed web app. File access is deliberately broad: read, write, and watch anything reachable under `$HOME`, any mounted drive on Windows, and common roots on macOS/Linux.

## Commands

| Command | Purpose |
|---|---|
| `read_file_tree(path, maxDepth?)` | Recursive directory listing (max depth 4 default, 8 max) |
| `read_file_text(path)` | Read any allowed file as UTF-8 (10 MB cap) |
| `write_file_text(path, contents)` | Write UTF-8 text (10 MB cap, refuses symlinks) |
| `get_file_size(path)` | Returns file size — used by EditorTile before loading |
| `watch_directory(path)` | Register a filesystem watcher (events emitted as `fs-change`) |
| `unwatch_directory(path)` | Remove a watcher |

## Allowed paths

Checked by `is_path_allowed(canonical)`:

**Windows:**
- Anywhere under `$HOME` (`dirs::home_dir()`).
- Any drive letter at root (`A:\` through `Z:\`) including mapped + network drives.
- UNC network paths (`\\server\share\...`).

**macOS / Linux:**
- `$HOME`.
- `/tmp`, `/var/folders`, `/var/tmp`.
- `/private/tmp`, `/private/var` (macOS symlink resolution — `/tmp` canonicalizes here).
- `/Users`, `/Volumes`, `/Library`, `/Applications` (macOS).
- `/home`, `/mnt`, `/media`, `/workspace`, `/workspaces`, `/srv`, `/opt`, `/usr/local`, `/usr/share`, `/etc`, `/data`.

**Blocked:** `/proc`, `/sys`, `/dev`, `/root` (correctness, not power-user).

## Why not the `tauri-plugin-fs` plugin?

Because its default capability scope (`$APPDATA/**`, `$HOME/Projects/**`, etc.) fails for common project paths like `~/.claude/projects/...` and `~/code/...`. For user project files, always use `readFileText` / `writeFileText` from `src/utils/ipc.ts` — they use the broader `is_path_allowed` validator.

## Tech notes

- All paths canonicalized via `Path::canonicalize()` before the allowlist check — resolves `..`, symlinks, and relative paths.
- Windows: `strip_verbatim_prefix` strips `\\?\` from canonical output so comparisons against `dirs::home_dir()` work.
- Null-byte rejection on every input path (defense against classic shell injection).
- `write_file_text` refuses to follow or overwrite symlinks (prevents write-escape through an allowed parent → blocked target).
- Directory watchers deduplicated by canonical key; reject non-directories.
- Test coverage in `filesystem.rs::tests` covers home allowance, drive-letter allowance (Windows), `/private/tmp` allowance (macOS), virtual-FS rejection (`/proc`, `/sys`, etc.).

**Key files:** `src-tauri/src/commands/filesystem.rs`.

## Related

- [Editor tile](../tiles/editor.md) · [File Tree tile](../tiles/filetree.md) · [Security](./security.md)
