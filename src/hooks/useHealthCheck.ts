import { useEffect, useState } from 'react';
import { pipelineHealthCheck, type HealthReport } from '@/utils/ipc';

/**
 * Hook return shape — `ok` is the user-facing "everything pipeline-runs
 * needs is in place" boolean. `claude` is the pipeline's required CLI;
 * `codex` / `gemini` are nice-to-haves (used for dual-reviewer / tiebreaker
 * on complex runs) so they don't gate `ok`.
 */
export interface HealthState {
  ok: boolean;
  missing: string[];
  gitOk: boolean;
}

/**
 * Module-level cache. The probe is cheap (PATH walk, no process spawn) but
 * we still memoize it for the session — health doesn't change between when
 * the app boots and when it's closed. Promise so concurrent callers share
 * the same in-flight invocation.
 */
let cached: Promise<HealthReport> | null = null;

/** Test-only escape hatch — clears the module cache between assertions. */
export function _resetHealthCheckCacheForTest(): void {
  cached = null;
}

/**
 * Test-only: inject a stubbed IPC. Production callers always go through
 * `pipelineHealthCheck` from `utils/ipc`; tests pass a deterministic
 * resolver so we don't need a real Tauri runtime.
 */
let probeFn: () => Promise<HealthReport> = pipelineHealthCheck;
export function _setHealthProbeForTest(fn: (() => Promise<HealthReport>) | null): void {
  probeFn = fn ?? pipelineHealthCheck;
}

function reportToState(report: HealthReport): HealthState {
  const missing: string[] = [];
  if (!report.claude) missing.push('claude');
  if (!report.gitInstalled) missing.push('git');
  return {
    // `ok` requires both claude and git — codex/gemini are optional.
    ok: report.claude && report.gitInstalled,
    missing,
    gitOk: report.gitInstalled,
  };
}

/**
 * Subscribe to the boot-time health check. Returns `null` until the IPC
 * resolves; consumers render nothing in the loading state. The check is
 * memoized for the session so multiple components reading it don't fan
 * out into multiple IPC calls.
 */
export function useHealthCheck(): HealthState | null {
  const [state, setState] = useState<HealthState | null>(null);

  useEffect(() => {
    let mounted = true;
    if (!cached) {
      cached = probeFn().catch((err) => {
        // IPC failure shouldn't crash the banner — fall back to "everything's
        // fine" so we don't show a misleading warning when the only problem
        // is that the IPC call itself errored. Reset cache so a future
        // remount can retry.
        cached = null;
        console.warn('[health-check] probe failed:', err);
        return { claude: true, codex: true, gemini: true, gitInstalled: true };
      });
    }
    cached.then((report) => {
      if (mounted) setState(reportToState(report));
    });
    return () => {
      mounted = false;
    };
  }, []);

  return state;
}
