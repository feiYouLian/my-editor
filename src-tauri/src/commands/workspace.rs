//! 工作区持久化
//! 轻量版：workspace.json 存于 Tauri 应用配置目录，
//! 仅记录根目录与展开状态；打开的文件列表与光标见 session.rs。
//!
//! 另含 per-workspace 设置覆盖（缩进 / 忽略目录）：
//! 存 `<配置目录>/workspaces/<hash>.json`，**不写进用户仓库**。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use super::paths::PathGuard;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct WorkspaceState {
    /// 工作区根目录
    pub root: Option<String>,
    /// 展开的目录路径列表
    #[serde(default)]
    pub expanded: Vec<String>,
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

/// 读取工作区状态（不存在则返回默认值）。
/// 同时把根目录登记进路径守卫（文件树的新建/删除等操作由此获得作用域）。
#[tauri::command]
pub fn load_workspace(
    app: tauri::AppHandle,
    guard: tauri::State<'_, PathGuard>,
) -> WorkspaceState {
    let Ok(path) = workspace_file(&app) else {
        return WorkspaceState::default();
    };
    let state = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => WorkspaceState::default(),
    };
    if let Some(root) = &state.root {
        guard.add_root(root);
    }
    state
}

/// 保存工作区状态（临时文件 + 原子替换，同 4.2）
#[tauri::command]
pub fn save_workspace(
    app: tauri::AppHandle,
    guard: tauri::State<'_, PathGuard>,
    state: WorkspaceState,
) -> Result<(), String> {
    if let Some(root) = &state.root {
        guard.add_root(root);
    }
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

// ---------------------------------------------------------------------------
// per-workspace 设置覆盖
// ---------------------------------------------------------------------------

/// 工作区级配置覆盖：`None` = 不覆盖，沿用全局 config.json。
///
/// 存放于 `<配置目录>/workspaces/<hash>.json`：
/// - 不写进用户仓库（工作区根目录下不放任何本应用的文件）；
/// - 目录不可写时也只是"设置不生效"，不影响打开工作区。
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceOverrides {
    /// 来源根目录（仅便于人工排查，不参与匹配）
    pub root: String,
    /// 缩进宽度；None = 用全局
    pub tab_size: Option<u32>,
    /// 忽略目录；None 或空 = 用全局
    pub ignore_dirs: Option<Vec<String>>,
}

/// 缩进允许范围（与设置页滑杆一致）
const TAB_SIZE_MIN: u32 = 1;
const TAB_SIZE_MAX: u32 = 16;
/// 忽略目录条数上限：搜索/快速打开会把整份列表传给后端，防止异常配置拖慢遍历
const MAX_IGNORE_DIRS: usize = 200;

impl WorkspaceOverrides {
    /// 是否没有任何覆盖项（此时文件应被删除，回到"跟随全局"）
    fn is_empty(&self) -> bool {
        self.tab_size.is_none() && self.ignore_dirs.is_none()
    }
}

/// 归一化根目录用于计算文件名：分隔符与大小写不敏感（Windows 同一目录只应有一份配置）
fn normalize_root(root: &str) -> String {
    root.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// FNV-1a 64：稳定、无依赖，只用来生成文件名（同 session.rs 草稿命名的思路）
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn workspaces_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?.join("workspaces");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(dir)
}

fn overrides_file(app: &tauri::AppHandle, root: &str) -> Result<PathBuf, String> {
    let key = normalize_root(root);
    if key.is_empty() {
        return Err("工作区路径为空".to_string());
    }
    Ok(workspaces_dir(app)?.join(format!("{:016x}.json", fnv1a64(key.as_bytes()))))
}

/// 读取工作区覆盖：缺失 / 损坏一律返回空覆盖。
/// 配置问题不该阻塞打开工作区，这里不报错（与 load_config 的容错一致）。
#[tauri::command]
pub fn load_workspace_overrides(app: tauri::AppHandle, root: String) -> WorkspaceOverrides {
    let Ok(path) = overrides_file(&app, &root) else {
        return WorkspaceOverrides::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => WorkspaceOverrides::default(),
    }
}

/// 保存工作区覆盖；全部为"不覆盖"时删除文件。
#[tauri::command]
pub fn save_workspace_overrides(
    app: tauri::AppHandle,
    root: String,
    overrides: WorkspaceOverrides,
) -> Result<(), String> {
    let path = overrides_file(&app, &root)?;
    let mut clean = overrides;
    clean.root = root;

    if let Some(size) = clean.tab_size {
        if !(TAB_SIZE_MIN..=TAB_SIZE_MAX).contains(&size) {
            return Err(format!("缩进宽度需在 {TAB_SIZE_MIN}–{TAB_SIZE_MAX} 之间"));
        }
    }
    if let Some(dirs) = &clean.ignore_dirs {
        if dirs.len() > MAX_IGNORE_DIRS {
            return Err(format!("忽略目录最多 {MAX_IGNORE_DIRS} 项"));
        }
        if dirs.iter().any(|d| d.trim().is_empty()) {
            return Err("忽略目录不能包含空白项".to_string());
        }
    }

    if clean.is_empty() {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
        }
        return Ok(());
    }

    let json = serde_json::to_string_pretty(&clean).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_root_is_case_and_separator_insensitive() {
        assert_eq!(normalize_root("D:\\Repo\\"), "d:/repo");
        assert_eq!(normalize_root("d:/repo"), "d:/repo");
        assert_eq!(normalize_root("  /home/me/proj/ "), "/home/me/proj");
    }

    #[test]
    fn fnv_hash_is_stable() {
        // 固定值：换实现会让已有工作区配置"消失"，这里锁住
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"d:/repo"), fnv1a64(b"d:/repo"));
        assert_ne!(fnv1a64(b"d:/repo"), fnv1a64(b"d:/repo2"));
    }

    #[test]
    fn overrides_roundtrip_uses_camel_case() {
        let value = WorkspaceOverrides {
            root: "D:\\repo".into(),
            tab_size: Some(4),
            ignore_dirs: Some(vec!["build".into()]),
        };
        let json = serde_json::to_string(&value).unwrap();
        assert!(json.contains("\"tabSize\":4"));
        assert!(json.contains("\"ignoreDirs\""));
        let back: WorkspaceOverrides = serde_json::from_str(&json).unwrap();
        assert_eq!(back, value);
    }

    #[test]
    fn missing_fields_fall_back_to_none() {
        let parsed: WorkspaceOverrides = serde_json::from_str("{}").unwrap();
        assert!(parsed.is_empty());
        assert!(parsed.tab_size.is_none());
        assert!(parsed.ignore_dirs.is_none());
    }

    #[test]
    fn empty_means_delete() {
        let mut value = WorkspaceOverrides::default();
        assert!(value.is_empty());
        value.tab_size = Some(2);
        assert!(!value.is_empty());
    }
}
