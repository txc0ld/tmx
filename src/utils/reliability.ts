/**
 * Small reliability helpers used across stores and components.
 *
 * Kept in one file so the patterns are easy to spot and apply consistently.
 */

/**
 * Parse JSON with a typed fallback. Never throws.
 *
 * Use this for untrusted input (localStorage that may have been corrupted
 * by a power-loss mid-write, HTTP response bodies, user-pasted text).
 * Store loaders usually wrap in try/catch already — prefer this at
 * component / boundary sites where a throw would crash the tree.
 *
 * @example
 *   const cache = safeJsonParse<CacheShape>(raw, { tiles: [], wires: [] });
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/**
 * Wrap a promise with a timeout. Rejects with a clear error if the inner
 * promise hasn't settled by `ms`.
 *
 * Tauri `invoke()` doesn't time out by default — a hung Rust command can
 * wedge a UI flow forever. Use this for critical interactive paths
 * (saves, spawns) where stalling is worse than surfacing an error.
 *
 * @example
 *   await withTimeout(ptySpawn({ ... }), 10_000, 'pty spawn');
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * Run an async operation with a per-project-id safety guard. If the
 * active project changes while the operation is in flight, the result
 * is discarded (caller's `onResult` is not invoked).
 *
 * Prevents a common bug where a slow fetch for project A lands after
 * the user has switched to project B, writing A's data into B's state.
 *
 * @example
 *   scopedToProject(pid, loadWorkspace(pid), (data) => applyToStore(data));
 */
export async function scopedToProject<T>(
  pidAtStart: string,
  getActivePid: () => string,
  work: Promise<T>,
  onResult: (value: T) => void,
  onError?: (err: unknown) => void,
): Promise<void> {
  try {
    const value = await work;
    if (getActivePid() === pidAtStart) {
      onResult(value);
    }
    // If pid changed, result is silently discarded — not an error.
  } catch (err) {
    if (getActivePid() === pidAtStart && onError) {
      onError(err);
    }
  }
}
