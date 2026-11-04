mod commands;

use tauri::{Emitter, Manager};

/// 应用入口：注册插件与命令
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 计时必须在 Builder 之前：窗口出现到前端就绪都算这一次采样
    commands::startup::mark_start();

    // 冷启动参数：文件关联 / 把文件拖到 exe 上时，路径在 argv 里（第 0 项是 exe 自身）
    let args: Vec<String> = std::env::args().collect();
    commands::cli::push_pending(commands::cli::files_from_args(
        args.get(1..).unwrap_or(&[]),
    ));
    commands::cli::push_pending_workspace(commands::cli::dirs_from_args(
        args.get(1..).unwrap_or(&[]),
    ));

    let result = tauri::Builder::default()
        // 单实例必须第一个注册（官方要求）。第二个实例把已有窗口拉到前台后自行退出，
        // 避免两个进程并发写 session.json / drafts 互相覆盖。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // 应用已运行时「打开方式」送来的文件：入队并通知前端取走。
            // 前端取不到（事件早于就绪）时，启动阶段也会从同一队列兜底。
            let files = commands::cli::files_from_args(argv.get(1..).unwrap_or(&[]));
            let dir = commands::cli::dirs_from_args(argv.get(1..).unwrap_or(&[]));
            if files.is_empty() && dir.is_none() {
                return;
            }
            commands::cli::push_pending(files);
            commands::cli::push_pending_workspace(dir);
            // 事件名沿用 open-files：前端收到后同时取文件与工作区两个队列
            let _ = app.emit("open-files", ());
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(commands::large::LargeState::default())
        .manage(commands::watch::WatchState::default())
        .manage(commands::tree_watch::TreeWatchState::default())
        .manage(commands::run::RunState::default())
        .manage(commands::terminal::TerminalState::default())
        .manage(commands::paths::PathGuard::new())
        .setup(|app| {
            commands::logging::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::association::file_association_status,
            commands::association::set_file_association,
            commands::association::scan_legacy_associations,
            commands::association::clear_legacy_associations,
            commands::cli::take_pending_files,
            commands::cli::take_pending_workspace,
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
            commands::fs::copy_path,
            commands::fs::paste_files,
            commands::clipboard::clipboard_get_files,
            commands::clipboard::clipboard_set_files,
            commands::fs::reveal_in_file_manager,
            commands::search::list_workspace_files,
            commands::search::search_workspace,
            commands::search::find_symbols,
            commands::search::replace_in_files,
            commands::search::undo_replace,
            commands::search::cleanup_replace_history,
            commands::regex::regex_test,
            commands::regex::regex_replace_preview,
            commands::git::git_status,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_stage_hunk,
            commands::git::git_commit,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_log,
            commands::git::git_show_commit,
            commands::git::git_blame,
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_pull,
            commands::git::git_discard,
            commands::git::git_push,
            commands::paths::register_paths,
            commands::workspace::load_workspace,
            commands::workspace::save_workspace,
            commands::workspace::app_config_dir,
            commands::workspace::load_workspace_overrides,
            commands::workspace::save_workspace_overrides,
            commands::session::load_session,
            commands::session::save_session,
            commands::session::write_draft,
            commands::session::list_drafts,
            commands::session::read_draft,
            commands::session::delete_draft,
            commands::session::cleanup_drafts,
            commands::batch::batch_save_encoding,
            commands::watch::watch_files,
            commands::tree_watch::watch_dirs,
            commands::logging::log_event,
            commands::logging::open_logs_dir,
            commands::logging::export_diagnostics,
            commands::config::load_config,
            commands::config::save_config,
            commands::config::config_path,
            commands::config::reveal_config_dir,
            commands::config::list_user_themes,
            commands::config::open_user_themes_dir,
            commands::config::list_user_languages,
            commands::config::open_user_languages_dir,
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
            commands::large::refresh_large_file,
            commands::large::close_large_file,
        ])
        .run(tauri::generate_context!());

    // 启动失败（端口被占、WebView 初始化失败等）不 panic：打印原因后以非零码退出，
    // 让用户看到可复制的信息，而不是静默崩溃。
    if let Err(err) = result {
        eprintln!("应用启动失败: {err}");
        std::process::exit(1);
    }
}
