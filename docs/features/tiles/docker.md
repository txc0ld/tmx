# Docker Tile

> List running containers, attach an interactive shell.

## What it is

A thin UI over `docker ps` + `docker exec`. Shows running containers and lets you attach a shell into one without leaving the canvas.

## How to use

- Add a Docker tile. On mount it calls `docker_list_containers` and renders the list.
- Click **Refresh** to re-list.
- Click a container row to attach — spawns `docker exec -it <id> /bin/sh` in a terminal pane inside the tile.
- Click **Detach** to close the exec session without touching the container.

## Use cases

**Container inspection.** Quickly shell into a misbehaving service — no need to remember the container ID or type the full exec command.

**Stack-up workflow.** Run `docker compose up` in a Terminal tile, keep a Docker tile open next to it to attach to any service on demand.

**Remote debugging.** Attach to a container running a process you want to `strace`, `tcpdump`, or inspect logs on.

## Tech notes

- `docker_list_containers` runs `docker ps --format` via `tokio::process::Command` (not a PTY). Response is capped at 500 entries with UTF-8-safe truncation.
- Container id is validated against `^[a-f0-9]{12,64}$` before attach to prevent arg injection.
- The attach itself goes through `pty_spawn` with `docker` in the shell allowlist — standard PTY path.
- Docker is optional: the tile shows a friendly error if `docker` isn't in PATH.

**Key files:** `src/components/tiles/DockerTile.tsx`, `src-tauri/src/commands/docker.rs`.

## Related

- [Terminal tile](./terminal.md) · [SSH tile](./ssh.md) · [PTY management](../platform/pty-management.md)
