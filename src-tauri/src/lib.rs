mod commands;

/// 应用入口：注册插件与命令
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::open_text_file,
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
            commands::format::run_cli_formatter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
