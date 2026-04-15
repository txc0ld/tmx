# PTY Management

> How native shells actually run inside the app.

## What it is

The machinery that spawns, reads from, writes to, and kills PTYs on all three platforms. Uses the `portable-pty` Rust crate with custom backpressure, size bounds, and a hard cap on concurrent sessions.

## How PTYs work here

- Any tile that shows a shell (Terminal, Agent, Runner, SSH, Docker) spawns a PTY via `pty_spawn` IPC.
- Rust opens a master/slave pair, spawns the child process attached to the slave, and stores master + writer + child in `PtyManager`.
- Two threads per PTY:
  - **Reader** reads 8 KB chunks from the master, sends them over a bounded channel.
  - **Emitter** pulls from the channel and emits `pty-output` events to the webview.
- Frontend listens for `pty-output` events and writes to the tile's xterm instance.

## Hard limits

| Limit | Value | Why |
|---|---|---|
| Max concurrent PTYs | **64** | macOS default fd limit is 256/process. 64 leaves room for Tauri + webview fds. Breach → clean "Too many active PTYs" error (not crash). |
| Reader buffer | 8 KB | Half as many wake-ups on busy shells as 4 KB. |
| Channel capacity | 256 slots × 8 KB ≈ 2 MB | Bounded backpressure — reader blocks on send when channel is full. |
| Cols bounds | [20, 512] | Below 20 is unusable, above 512 is unsupported by portable-pty. |
| Rows bounds | [3, 512] | Same rationale. |
| Write chunk | 256 bytes | Windows PTY pipes drop bytes above this under heavy write. |
| Write retries | 5 × 10 ms | Handles `WouldBlock` / `Interrupted` transient errors. |
| Emitter retry backoff | 50 ms → 2 s × 30 attempts | Brief webview hiccups don't kill the stream. |

## Power moves

- **Backpressure visibility.** If a shell floods output, the reader thread blocks on `send()` — the child process's next write blocks at the OS pipe level. Natural backpressure, no OOM.
- **Graceful PTY exit.** Killed PTYs emit `pty-exit`; the frontend cleans up xterm listeners. Shutdown on window close kills all remaining children.
- **Cross-platform parity.** `portable-pty` abstracts Windows ConPTY vs Unix PTY — the same code path works on all three OSes.

## Tech notes

- `PtyManager.insert` enforces the 64-session cap before touching the map. Returns a user-friendly error the UI toasts.
- `PtyManager.write` chunks at 256 B, retries 5 × 10 ms on `WouldBlock` / `Interrupted`, then returns the error.
- `PtyManager::Drop` kills all active children if the manager is dropped (app exit path).
- The reader-emitter decoupling via `std::sync::mpsc::sync_channel` is what gives backpressure — a prior design read + emitted in the same thread and bloated memory under load.

**Key files:** `src-tauri/src/commands/terminal.rs`, `src-tauri/src/state/pty_manager.rs`.

## Related

- [Terminal tile](../tiles/terminal.md) · [Agent spawn](../agents/agent-spawn.md) · [Security](./security.md)
