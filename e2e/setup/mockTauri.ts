/**
 * Browser-side Tauri IPC mock for Playwright.
 *
 * The real `@tauri-apps/api/core` `invoke()` does:
 *
 *     return window.__TAURI_INTERNALS__.invoke(cmd, args, options);
 *
 * In a Tauri runtime the host injects `__TAURI_INTERNALS__` automatically.
 * Inside a plain Chromium running against `pnpm dev` (5173) it's missing,
 * so any IPC call rejects with "window.__TAURI_INTERNALS__ is undefined".
 * That trips React error boundaries on first paint and the app never
 * settles enough for an E2E test to run.
 *
 * This module installs a deterministic in-memory stub that:
 *
 *   - Resolves every IPC the launch flow + boot path touches with a
 *     fixture-shaped value (full struct shapes — partial mocks crash
 *     the destructuring callsites).
 *   - No-ops `pty_*`, `agent_kill`, telemetry writes (these have no
 *     observable effect on the launch UI).
 *   - Returns sensible defaults for unknown IPCs (`null`/`undefined`/`[]`)
 *     and logs once via `console.warn` so a future test surfaces missing
 *     mocks without crashing the page.
 *   - Stubs the event subsystem (`plugin:event|listen` / `unlisten`) so
 *     `listen('pty-output', …)` resolves to a no-op unlisten function.
 *   - Mirrors `convertFileSrc` and `transformCallback` so any addon code
 *     that pokes those (Monaco, plugin-shell) doesn't faceplant.
 *
 * Injected via `page.addInitScript({ path: ... })` BEFORE the SPA bundle
 * runs, so React mount sees a fully-populated `__TAURI_INTERNALS__`.
 *
 * The exported `installMockTauri` is the in-page bootstrapper. Compiled
 * to a self-executing form by Playwright's `addInitScript`. Keep this
 * file zero-dependency (no imports from `src/`) so Playwright doesn't
 * need to resolve our Vite alias graph at injection time.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
      transformCallback: (callback: (...args: unknown[]) => void, once: boolean) => number;
      unregisterCallback: (id: number) => void;
      convertFileSrc: (filePath: string, protocol?: string) => string;
    };
    __E2E_MOCK_INSTALLED__?: boolean;
  }
}

export interface InstallOpts {
  /**
   * Override / extend the default IPC fixture map. Keys are command names
   * (e.g. `'pipeline_preflight'`); values are either a static return value
   * or a function `(args) => returnValue | Promise<returnValue>`.
   */
  overrides?: Record<
    string,
    unknown | ((args: Record<string, unknown>) => unknown)
  >;
}

export function installMockTauri(opts: InstallOpts = {}) {
  if (typeof window === 'undefined') return;
  if (window.__E2E_MOCK_INSTALLED__) return;
  window.__E2E_MOCK_INSTALLED__ = true;

  let nextCallback = 1;
  const callbacks = new Map<number, (...args: unknown[]) => void>();

  const warned = new Set<string>();
  const warnOnce = (cmd: string) => {
    if (warned.has(cmd)) return;
    warned.add(cmd);
    // eslint-disable-next-line no-console
    console.warn(`[e2e-mock] no fixture for IPC '${cmd}' — returning null`);
  };

  // ── Default fixtures ────────────────────────────────────────────────
  // Field shapes mirror the TypeScript interfaces in src/utils/ipc.ts so
  // the destructuring sites (e.g. preflight.is_git_repo) don't blow up.
  const defaults: Record<
    string,
    unknown | ((args: Record<string, unknown>) => unknown)
  > = {
    // ── PTY ─────────────────────────────
    pty_spawn: () => `mock-pty-${nextCallback++}`,
    pty_write: () => undefined,
    pty_resize: () => undefined,
    pty_kill: () => undefined,

    // ── Agents ──────────────────────────
    agent_spawn: () => `mock-agent-${nextCallback++}`,
    agent_kill: () => undefined,
    agent_list: () => [],
    agent_run_oneshot: () => ({
      stdout: '',
      stderr: '',
      exit_code: 0,
      timed_out: false,
    }),

    // ── Filesystem ──────────────────────
    read_file_tree: () => ({ name: 'mock', path: '/mock', children: [] }),
    read_file_text: () => '',
    write_file_text: () => undefined,
    get_file_size: () => 0,
    delete_file: () => undefined,
    read_file_mtime: () => Date.now() / 1000,

    // ── Secrets / watchers ──────────────
    secret_set: () => undefined,
    secret_get: () => null,
    secret_delete: () => undefined,
    watch_directory: () => undefined,
    unwatch_directory: () => undefined,

    // ── Workspace / projects / timeline ─
    save_workspace: () => undefined,
    load_workspace: () => null,
    save_snapshot: () => undefined,
    load_snapshot: () => null,
    delete_snapshot: () => undefined,
    list_snapshots: () => [],
    record_event: () => undefined,
    get_timeline: () => [],
    clear_timeline: () => undefined,
    load_projects: () => [],
    save_projects: () => undefined,
    add_project: () => undefined,
    update_project: () => undefined,
    delete_project: () => undefined,

    // ── Git ────────────────────────────
    git_available: () => true,
    git_status: () => ({ clean: true, branch: 'main', changes: [] }),
    git_log: () => [],
    git_branches: () => [{ name: 'main', is_current: true, is_remote: false }],
    git_files_status: () => [],
    git_diff_summary: () => '',
    git_show_head_file: () => '',
    git_stage: () => undefined,
    git_unstage: () => undefined,
    git_commit: () => undefined,

    // ── Docker ─────────────────────────
    docker_available: () => false,
    docker_list_containers: () => [],

    // ── HTTP proxy ─────────────────────
    http_fetch: () => ({ status: 200, headers: {}, body: '{}' }),

    // ── Pipeline ───────────────────────
    pipeline_preflight: () => ({
      is_git_repo: true,
      working_tree_clean: true,
      main_branch: 'main',
      claude_present: true,
      codex_present: false,
      gh_present: false,
      gh_authenticated: false,
      worktree_dir_writable: true,
      signed_skills_ok: true,
      capability_binaries_ok: true,
      skill_cache_writable: true,
      sensitive_paths_found: [],
      errors: [],
    }),
    pipeline_worktree_create: (args: Record<string, unknown>) => ({
      path: String(args.worktreePath ?? '/mock/worktree'),
      branch: String(args.branch ?? 'feat/mock'),
    }),
    pipeline_worktree_destroy: () => undefined,
    pipeline_install_skills: () => ({
      skills_dir: '/mock/.claude/skills',
      installed: [],
      already_present: [
        'tx-pipeline-stage-handoff',
        'tx-pipeline-reviewer',
      ],
      errors: [],
      stub: false,
    }),
    pipeline_skill_status: () => [],
    pipeline_force_install_skill: () => undefined,
    pipeline_read_role_prompt: () => null,
    pipeline_telemetry_log: () => undefined,
    pipeline_cleanup_old_runs: () => ({
      removed_records: 0,
      removed_telemetry: 0,
      removed_worktrees: 0,
      errors: [],
    }),
    pipeline_health_check: () => ({
      claude: true,
      codex: false,
      gemini: false,
      gitInstalled: true,
    }),
    pipeline_guardrails_install: () => undefined,
    pipeline_guardrails_uninstall: () => undefined,
    pipeline_capabilities_install: () => undefined,
    pipeline_capabilities_uninstall: () => undefined,
    pipeline_failure_bundle_generate: () => ({
      bundle_path: '/mock/bundle.tar.gz',
      size_bytes: 0,
      entries: [],
    }),
    pipeline_run_verification_step: () => ({
      ok: true,
      stdout: '',
      stderr: '',
      duration_ms: 0,
    }),
    pipeline_merger_request_token: () => 'mock-merger-token',
    pipeline_merger_run: () => ({
      status: 'success',
      mode: 'local',
      pr_url: null,
      detail: 'mock',
    }),

    // ── Misc ───────────────────────────
    secrets_mask: (args: Record<string, unknown>) => String(args.input ?? ''),

    // ── Tauri event subsystem ──────────
    'plugin:event|listen': () => nextCallback++,
    'plugin:event|unlisten': () => undefined,
    'plugin:event|emit': () => undefined,
    'plugin:event|emit_to': () => undefined,

    // ── Tauri webview / window plugins ─
    'plugin:webview|create': () => undefined,
    'plugin:window|theme': () => 'dark',
  };

  const fixtures: Record<
    string,
    unknown | ((args: Record<string, unknown>) => unknown)
  > = { ...defaults, ...(opts.overrides ?? {}) };

  window.__TAURI_INTERNALS__ = {
    invoke(cmd: string, args?: unknown) {
      const fixture = fixtures[cmd];
      let result: unknown;
      if (typeof fixture === 'function') {
        try {
          result = (fixture as (a: Record<string, unknown>) => unknown)(
            (args as Record<string, unknown>) ?? {},
          );
        } catch (err) {
          return Promise.reject(err);
        }
      } else if (fixture !== undefined) {
        result = fixture;
      } else {
        warnOnce(cmd);
        result = null;
      }
      return Promise.resolve(result);
    },
    transformCallback(callback, _once) {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(filePath, _protocol) {
      return filePath;
    },
  };
}
