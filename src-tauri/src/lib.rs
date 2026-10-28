mod commands;

use tauri::Manager;

/// 应用入口：注册插件与命令
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 计时必须在 Builder 之前：窗口出现到前端就绪都算这一次采样
    commands::startup::mark_start();
    tauri::Builder::default()
        // 单实例必须第一个注册（官方要求）。第二个实例把已有窗口拉到前台后自行退出，
        // 避免两个进程并发写 session.json / drafts 互相覆盖。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::large::LargeState::default())
        .manage(commands::watch::WatchState::default())
        .manage(commands::run::RunState::default())
        .manage(commands::terminal::TerminalState::default())
        .manage(commands::paths::PathGuard::new())
        .invoke_handler(tauri::generate_handler![
            commands::file::open_text_file,
            commands::file::probe_file,
            commands::file::reopen_with_encoding,
            commands::file::read_image_file,
            commands::file::save_file,
            commands::file::write_binary_file,
            commands::encoding::detect_mojibake,
            commands::run::run_code,
            commands::run::run_curl,
            commands::run::stop_run,
            commands::terminal::terminal_open,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_run_code,
            commands::terminal::terminal_run_curl,
            commands::fetch::fetch_url,
            commands::fetch::suggest_fetch_filename,
            commands::fs::list_dir,
            commands::fs::path_kind,
            commands::fs::create_entry,
            commands::fs::rename_path,
            commands::fs::delete_path,
            commands::fs::reveal_in_file_manager,
            commands::search::list_workspace_files,
            commands::search::search_workspace,
            commands::search::replace_in_files,
            commands::search::undo_replace,
            commands::search::cleanup_replace_history,
            commands::git::git_status,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_pull,
            commands::git::git_discard,
            commands::git::git_push,
            commands::paths::register_paths,
            commands::workspace::load_workspace,
            commands::workspace::save_workspace,
            commands::workspace::app_config_dir,
            commands::session::load_session,
            commands::session::save_session,
            commands::session::write_draft,
            commands::session::list_drafts,
            commands::session::read_draft,
            commands::session::delete_draft,
            commands::session::cleanup_drafts,
            commands::batch::batch_save_encoding,
            commands::watch::watch_files,
            commands::config::load_config,
            commands::config::save_config,
            commands::config::config_path,
            commands::config::reveal_config_dir,
            commands::startup::frontend_ready,
            commands::format::run_cli_formatter,
            commands::diff::diff_texts,
            commands::diff::diff_files,
            commands::diff::git_available,
            commands::diff::git_diff,
            commands::diff::export_patch,
            commands::large::open_large_file,
            commands::large::large_file_info,
            commands::large::read_large_lines,
            commands::large::filter_large_file,
            commands::large::cancel_large_task,
            commands::large::large_minimap,
            commands::large::set_large_encoding,
            commands::large::close_large_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
