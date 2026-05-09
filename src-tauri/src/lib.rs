mod commands;
mod state;
mod util;

use state::app_state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Plugins
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // Managed state
        .setup(|app| {
            let app_state = AppState::new(app.handle().clone());
            app.manage(app_state);
            Ok(())
        })
        // Clean up PTY sessions on window close
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.pty_manager.lock().shutdown_all();
                }
            }
        })
        // IPC commands
        .invoke_handler(tauri::generate_handler![
            // Terminal / PTY
            commands::terminal::pty_spawn,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_kill,
            // Agent processes
            commands::agents::agent_spawn,
            commands::agents::agent_kill,
            commands::agents::agent_list,
            commands::agents::agent_run_oneshot,
            // Filesystem
            commands::filesystem::read_file_tree,
            commands::filesystem::read_file_text,
            commands::filesystem::write_file_text,
            commands::filesystem::get_file_size,
            commands::filesystem::read_file_mtime,
            commands::filesystem::delete_file,
            commands::filesystem::watch_directory,
            commands::filesystem::unwatch_directory,
            // Workspace persistence
            commands::workspace::save_workspace,
            commands::workspace::load_workspace,
            commands::workspace::list_snapshots,
            commands::workspace::save_snapshot,
            commands::workspace::load_snapshot,
            commands::workspace::delete_snapshot,
            // Timeline
            commands::timeline::record_event,
            commands::timeline::get_timeline,
            commands::timeline::clear_timeline,
            // Projects
            commands::projects::load_projects,
            commands::projects::save_projects,
            commands::projects::add_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            // Git
            commands::git::git_available,
            commands::git::git_clone,
            commands::git::git_status,
            commands::git::git_log,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_diff_summary,
            commands::git::git_files_status,
            commands::git::git_show_head_file,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            // HTTP proxy for MCP integrations
            commands::http_proxy::http_fetch,
            // Docker
            commands::docker::docker_available,
            commands::docker::docker_list_containers,
            // OS keychain — MCP tokens + future sensitive values
            commands::secrets::secret_set,
            commands::secrets::secret_get,
            commands::secrets::secret_delete,
            // Secret masking — telemetry / failure-bundle / webhook hygiene
            commands::secrets_mask::secrets_mask,
            // Failure bundle generator (Phase 2c-iii.7)
            commands::failure_bundle::pipeline_failure_bundle_generate,
            commands::failure_bundle::pipeline_failure_bundle_summary,
            // Boot-time CLI health check (welcome banner)
            commands::health::pipeline_health_check,
            // Pipeline (agentic-pipeline Phase 1)
            commands::pipeline::pipeline_capabilities_install,
            commands::pipeline::pipeline_capabilities_uninstall,
            commands::pipeline::pipeline_cleanup_old_runs,
            commands::pipeline::pipeline_guardrails_install,
            commands::pipeline::pipeline_guardrails_uninstall,
            commands::pipeline::pipeline_install_skills,
            commands::pipeline::pipeline_skill_status,
            commands::pipeline::pipeline_force_install_skill,
            commands::pipeline::pipeline_merger_request_token,
            commands::pipeline::pipeline_merger_run,
            commands::pipeline::pipeline_preflight,
            commands::pipeline::pipeline_read_role_prompt,
            commands::pipeline::pipeline_run_verification_step,
            commands::pipeline::pipeline_telemetry_log,
            commands::pipeline::pipeline_worktree_create,
            commands::pipeline::pipeline_worktree_destroy,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("TerminalX failed to start: {}", e);
            std::process::exit(1);
        });
}
