/**
 * Shared timing constants. Keeping these in one place lets tests stub
 * them and makes intent obvious at the call site.
 */

/** Git / MCP tile polling cadence. */
export const POLL_INTERVAL_MS = 30_000;

/** MCP inbox sync cadence (separate from UI poll). */
export const MCP_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Auto-snapshot cadence — see Time Travel feature docs. */
export const AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/** Canvas disk save debounce. */
export const WORKSPACE_SAVE_DEBOUNCE_MS = 2_000;

/** localStorage crash-recovery cache debounce. */
export const WORKSPACE_CACHE_DEBOUNCE_MS = 500;

/**
 * Map a Rust / OS error message into something a human can act on.
 * Keep this conservative — an unmapped error falls through unchanged so
 * we never accidentally hide a real diagnostic.
 */
export function friendlyFsError(err: unknown): string {
  const msg = String(err);
  if (/os error 13|Permission denied/i.test(msg)) {
    return "Permission denied — you don't have access to this file or folder.";
  }
  if (/os error 2|No such file/i.test(msg)) {
    return "That file or folder doesn't exist (or was moved).";
  }
  if (/os error 20|Not a directory/i.test(msg)) {
    return 'Path exists but is not a directory.';
  }
  if (/outside the allowed roots/i.test(msg)) {
    return 'Path is outside TerminalX\'s allowed roots (home / drives / mount points).';
  }
  if (/too large/i.test(msg)) {
    return msg; // "File too large (12345 bytes — 10 MB cap)" is already friendly.
  }
  if (/Invalid path|null byte/i.test(msg)) {
    return 'Invalid path.';
  }
  return msg;
}
