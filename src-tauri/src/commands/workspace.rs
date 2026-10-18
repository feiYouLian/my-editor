//! 工作区持久化（设计文档 3.10 / 3.11）
//! 轻量版：workspace.json 存于 Tauri 应用配置目录，
//! 记录根目录、展开状态、打开的文件列表与当前文件。
//! 草稿 drafts/ 与 session.json 在阶段 9 落地，此处先建目录结构。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct WorkspaceState {
    /// 工作区根目录
    pub root: Option<String>,
    /// 展开的目录路径列表
    #[serde(default)]
    pub expanded: Vec<String>,
    /// 打开的文件列表（路径）
    #[serde(default)]
    pub open_files: Vec<String>,
    /// 当前激活文件
    #[serde(default)]
    pub active_file: Option<String>,
}

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir)
}

fn workspace_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("workspace.json"))
}

/// 读取工作区状态（不存在则返回默认值）
#[tauri::command]
pub fn load_workspace(app: tauri::AppHandle) -> WorkspaceState {
    let Ok(path) = workspace_file(&app) else {
        return WorkspaceState::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => WorkspaceState::default(),
    }
}

/// 保存工作区状态（临时文件 + 原子替换，同 4.2）
#[tauri::command]
pub fn save_workspace(app: tauri::AppHandle, state: WorkspaceState) -> Result<(), String> {
    let path = workspace_file(&app)?;
    let json = serde_json::to_string_pretty(&state).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换失败: {e}"))?;
    Ok(())
}

/// 应用配置目录路径（前端展示/调试用）
#[tauri::command]
pub fn app_config_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(config_dir(&app)?.to_string_lossy().to_string())
}
