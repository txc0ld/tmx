# SSH Tile

> Remote shell over SSH, tile-native.

## What it is

An SSH client wrapped in a tile. Connects to any host you can reach, with the terminal rendered by the same xterm stack as the [Terminal tile](./terminal.md).

## How to use

- Add an SSH tile. Enter host, port (default 22), user.
- Click **Connect**. The tile validates input, spawns `ssh -p <port> -- <user>@<host>`, and switches to terminal view.
- Interact as with any SSH session — key exchange, auth prompt, shell.
- Click **Disconnect** to kill the PTY.

## Use cases

**Remote server workflow.** Keep production SSH sessions on the canvas next to local dev terminals. No alt-tabbing between iTerm and the app.

**Multi-host monitoring.** One SSH tile per staging box, all visible at once.

**Pair with agents.** An Agent tile can't SSH on its own, but you can manually copy commands between tiles or pipe output.

## Tech notes

- User is validated against `^[A-Za-z0-9._-]{1,64}$` and host against `^[A-Za-z0-9.:-]{1,253}$` before spawn. Leading `-` is rejected to prevent flag injection.
- Destination is always passed after `--` in the `ssh` argv to stop SSH from parsing subsequent tokens as options.
- SSH is explicitly in the shell allowlist (`SHELL_ALLOWLIST` in `terminal.rs`) — the renderer can spawn it directly without needing the internal agent bypass.
- Port clamped to `[1, 65535]` at the frontend and again at the workspace-import validator.

**Key files:** `src/components/tiles/SshTile.tsx`, `src-tauri/src/commands/terminal.rs`.

## Related

- [Terminal tile](./terminal.md) · [PTY management](../platform/pty-management.md) · [Security posture](../platform/security.md)
