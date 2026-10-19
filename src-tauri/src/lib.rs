mod commands;

/// 应用入口：注册插件与命令
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::search::SearchState::default())
        .manage(commands::large::LargeState::default())
        .invoke_handler(tauri::generate_handler![
            commands::file::open_text_file,
            commands::file::probe_file,
            commands::file::reopen_with_encoding,
            commands::file::read_image_file,
            commands::file::save_file,
            commands::fs::list_dir,
            commands::fs::create_entry,
            commands::fs::rename_path,
            commands::fs::delete_path,
            commands::fs::reveal_in_file_manager,
            commands::workspace::load_workspace,
            commands::workspace::save_workspace,
            commands::workspace::app_config_dir,
            commands::config::load_config,
            commands::config::save_config,
            commands::config::config_path,
            commands::search::search_in_files,
            commands::search::cancel_search,
            commands::search::preview_replace,
            commands::search::replace_in_files,
            commands::search::restore_backups,
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
