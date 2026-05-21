// Auto-loaded into the page via Playwright's `addInitScript({ path })` BEFORE
// the Vite SPA bundle executes. Stubs `window.__TAURI_INTERNALS__` so every
// `invoke('foo', …)` call from `@tauri-apps/api/core` resolves with a
// deterministic in-memory fixture. Keep zero-dependency — no imports.
//
// This file is the runtime sibling of `mockTauri.ts`. The `.ts` form
// documents the structure for future maintainers and is type-checked
// against the source IPC types; this `.js` form is what actually runs in
// the browser (Playwright doesn't compile TS init scripts). When you add
// a new IPC fixture, update both files.
(() => {
  if (typeof window === 'undefined') return;
  if (window.__E2E_MOCK_INSTALLED__) return;
  window.__E2E_MOCK_INSTALLED__ = true;

  let nextCallback = 1;
  const callbacks = new Map();
  const warned = new Set();
  const warnOnce = (cmd) => {
    if (warned.has(cmd)) return;
    warned.add(cmd);
    // eslint-disable-next-line no-console
    console.warn("[e2e-mock] no fixture for IPC '" + cmd + "' — returning null");
  };

  const fixtures = {
    pty_spawn: () => 'mock-pty-' + nextCallback++,
    pty_write: () => undefined,
    pty_resize: () => undefined,
    pty_kill: () => undefined,

    agent_spawn: () => 'mock-agent-' + nextCallback++,
    agent_kill: () => undefined,
    agent_list: () => [],
    agent_run_oneshot: () => ({ stdout: '', stderr: '', exit_code: 0, timed_out: false }),

    read_file_tree: () => ({ name: 'mock', path: '/mock', children: [] }),
    read_file_text: () => '',
    write_file_text: () => undefined,
    get_file_size: () => 0,
    delete_file: () => undefined,
    read_file_mtime: () => Date.now() / 1000,

    secret_set: () => undefined,
    secret_get: () => null,
    secret_delete: () => undefined,
    watch_directory: () => undefined,
    unwatch_directory: () => undefined,

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

    docker_available: () => false,
    docker_list_containers: () => [],

    http_fetch: () => ({ status: 200, headers: {}, body: '{}' }),

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
    pipeline_worktree_create: (args) => ({
      path: String(args.worktreePath || '/mock/worktree'),
      branch: String(args.branch || 'feat/mock'),
    }),
    pipeline_worktree_destroy: () => undefined,
    pipeline_install_skills: () => ({
      skills_dir: '/mock/.claude/skills',
      installed: [],
      already_present: ['tx-pipeline-stage-handoff', 'tx-pipeline-reviewer'],
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

    secrets_mask: (args) => String(args.input || ''),

    'plugin:event|listen': () => nextCallback++,
    'plugin:event|unlisten': () => undefined,
    'plugin:event|emit': () => undefined,
    'plugin:event|emit_to': () => undefined,

    'plugin:webview|create': () => undefined,
    'plugin:window|theme': () => 'dark',

    // Path plugin — `homeDir()` / `appDataDir()` etc. all funnel through
    // `plugin:path|resolve_directory`. Run factory + worktree paths join
    // the result, so it MUST be a string (not null).
    'plugin:path|resolve_directory': () => '/mock/home',
    'plugin:path|resolve': (args) => {
      const parts = (args && args.paths) || [];
      return Array.isArray(parts) ? parts.join('/') : '/mock/path';
    },
    'plugin:path|join': (args) => {
      const parts = (args && args.paths) || [];
      return Array.isArray(parts) ? parts.join('/') : '/mock/path';
    },
    'plugin:path|home_dir': () => '/mock/home',
    'plugin:path|app_data_dir': () => '/mock/home/appdata',
    'plugin:path|app_config_dir': () => '/mock/home/config',
  };

  // Allow individual tests to override fixtures via a queue set on window
  // BEFORE this script runs (Playwright init-script ordering). Empty by
  // default; tests assign window.__E2E_IPC_OVERRIDES__ via addInitScript.
  const overrides = window.__E2E_IPC_OVERRIDES__ || {};
  Object.assign(fixtures, overrides);

  window.__TAURI_INTERNALS__ = {
    // `@tauri-apps/api/window` reads metadata.currentWindow.label at module
    // load time when components call `getCurrentWindow()`. Without it, every
    // component that imports the Window plugin crashes its render.
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    invoke(cmd, args) {
      const fixture = fixtures[cmd];
      let result;
      if (typeof fixture === 'function') {
        try {
          result = fixture(args || {});
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
})();
