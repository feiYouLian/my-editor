//! 文件系统命令：文件树与工作区
//! 目录列举 / 新建 / 重命名 / 删除 / 在文件管理器中定位。
//! 权限最小化：仅响应用户在文件树上的显式操作，不扫描工作区之外的内容。

use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;

use super::paths::PathGuard;

#[derive(Serialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 列举目录直接子项（目录在前、名称不区分大小写排序）
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let meta = entry
            .metadata()
            .map_err(|e| format!("读取元信息失败: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// 路径类型探测（窗口拖放：判定文件 / 目录）。
/// 只读 metadata，不触碰作用域状态：拖入路径在打开/设为工作区时才登记。
#[tauri::command]
pub async fn path_kind(path: String) -> Result<&'static str, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| format!("读取路径失败: {e}"))?;
        Ok(if meta.is_dir() { "dir" } else { "file" })
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 新建文件或目录（已存在则报错）。
/// 安全：仅允许已登记工作区根目录之内（文件树 UI 的可见范围）。
#[tauri::command]
pub fn create_entry(
    state: tauri::State<'_, PathGuard>,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let p = state.ensure_root_scope(&path)?;
    if p.exists() {
        return Err("目标已存在".to_string());
    }
    if is_dir {
        fs::create_dir_all(&p).map_err(|e| format!("创建目录失败: {e}"))
    } else {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
        }
        fs::write(&p, "").map_err(|e| format!("创建文件失败: {e}"))
    }
}

/// 重命名 / 移动。安全：源与目标都必须在已登记工作区根目录之内。
#[tauri::command]
pub fn rename_path(
    state: tauri::State<'_, PathGuard>,
    from: String,
    to: String,
) -> Result<(), String> {
    let src = state.ensure_root_scope(&from)?;
    let target = state.ensure_root_scope(&to)?;
    if target.exists() {
        return Err("目标已存在".to_string());
    }
    fs::rename(&src, &target).map_err(|e| format!("重命名失败: {e}"))
}

/// 删除文件或目录（移入系统回收站；调用方必须已弹确认）。
/// 安全：仅允许已登记工作区根目录之内。
///
/// 走 `trash` 而不是 `remove_file/remove_dir_all`：确认框是唯一防线时，
/// 误点就是永久丢失；回收站给了第二道网，且用户能按系统习惯自行还原。
/// 大目录（node_modules 等）移入回收站也可能很慢：放 spawn_blocking。
#[tauri::command]
pub async fn delete_path(
    state: tauri::State<'_, PathGuard>,
    path: String,
) -> Result<(), String> {
    let p = state.ensure_root_scope(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !p.exists() {
            return Err("路径不存在（可能已被其它程序删除）".to_string());
        }
        trash::delete(&p).map_err(|e| format!("移入回收站失败: {e}"))
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

/// 在系统文件管理器中打开 / 定位某个路径（跨平台，**不做路径校验**，调用方负责）。
///
/// `select = true` 表示在父目录中选中该项（文件定位），`false` 表示直接打开该目录。
pub(crate) fn reveal_path(p: &Path, select: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = {
        use std::os::windows::process::CommandExt;
        // /select 与路径必须拼成同一个参数；raw_arg 跳过标准参数转义，
        // 否则含空格的路径会被改写成 \"...\"，explorer 解析失败后落到默认目录
        let target = p.to_string_lossy().replace('/', "\\");
        let mut cmd = Command::new("explorer");
        if select {
            cmd.raw_arg(format!("/select,\"{target}\""));
        } else {
            cmd.raw_arg(format!("\"{target}\""));
        }
        cmd.spawn().map(|_| ())
    };

    #[cfg(target_os = "macos")]
    let result = {
        let mut cmd = Command::new("open");
        if select {
            cmd.arg("-R");
        }
        cmd.arg(p).spawn().map(|_| ())
    };

    #[cfg(target_os = "linux")]
    let result = {
        let target = if select {
            p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| p.to_path_buf())
        } else {
            p.to_path_buf()
        };
        Command::new("xdg-open").arg(target).spawn().map(|_| ())
    };

    result.map_err(|e| format!("打开文件管理器失败: {e}"))
}

/// 在系统文件管理器中定位（跨平台）。
/// 安全：仅允许已登记工作区根目录之内。
#[tauri::command]
pub fn reveal_in_file_manager(
    state: tauri::State<'_, PathGuard>,
    path: String,
) -> Result<(), String> {
    let p = state.ensure_root_scope(&path)?;
    reveal_path(&p, true)
}
