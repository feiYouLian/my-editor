//! 命令行待打开内容：文件关联、把文件 / 目录拖到 exe 上、第二实例转发。
//!
//! Windows 资源管理器「打开方式 ▸ my-editor」会把文件路径作为 argv 传给进程：
//! - 应用未运行：路径落在本进程的参数里（冷启动）；
//! - 应用已运行：路径落在单实例插件的回调参数里（热启动）。
//!
//! 两条路径都进同一个队列，前端就绪后一次取走，避免其中一种漏掉。
//! 参数是目录时按工作区打开（`my-editor.exe D:\project`），文件则逐个打开。

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use super::paths::PathGuard;

/// 待前端取走的文件（绝对路径，已去重）
static PENDING: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// 待前端打开的工作区目录（命令行传目录时设置；只取第一个）
static PENDING_WORKSPACE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// 从命令行参数里挑出真实存在的文件。
///
/// 过滤规则：跳过空串、`-`/`--` 开头的开关（Tauri / WebView2 内部参数）、不存在的路径。
/// 相对路径按当前工作目录转绝对路径——「打开方式」启动时 cwd 常是 System32，
/// 直接把相对路径交给前端会指向错误位置。
pub fn files_from_args(args: &[String]) -> Vec<String> {
    let cwd = std::env::current_dir().ok();
    let mut out: Vec<String> = Vec::new();
    for raw in args {
        let arg = raw.trim().trim_matches('"');
        if arg.is_empty() || arg.starts_with('-') {
            continue;
        }
        let path = Path::new(arg);
        if !path.is_file() {
            continue;
        }
        let abs: PathBuf = if path.is_absolute() {
            path.to_path_buf()
        } else if let Some(dir) = &cwd {
            dir.join(path)
        } else {
            path.to_path_buf()
        };
        let text = abs.to_string_lossy().to_string();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

/// 从命令行参数里挑出工作区目录。
///
/// 与文件参数共用一套过滤规则：跳过空项、`-`/`--` 开头的开关、不存在的路径；
/// 相对路径按当前工作目录转绝对路径。只取第一个目录，多个目录时以最靠前的为准。
pub fn dirs_from_args(args: &[String]) -> Option<String> {
    let cwd = std::env::current_dir().ok();
    for raw in args {
        let arg = raw.trim().trim_matches('"');
        if arg.is_empty() || arg.starts_with('-') {
            continue;
        }
        let path = Path::new(arg);
        if !path.is_dir() {
            continue;
        }
        let abs: PathBuf = if path.is_absolute() {
            path.to_path_buf()
        } else if let Some(dir) = &cwd {
            dir.join(path)
        } else {
            path.to_path_buf()
        };
        return Some(abs.to_string_lossy().to_string());
    }
    None
}

/// 入队工作区目录（覆盖式：一次启动只认最后一个显式目录）
pub fn push_pending_workspace(dir: Option<String>) {
    let Some(dir) = dir else { return };
    if let Ok(mut guard) = PENDING_WORKSPACE.lock() {
        *guard = Some(dir);
    }
}

/// 取走待打开的工作区（不登记路径；供测试与内部调用）
fn take_pending_workspace_raw() -> Option<String> {
    PENDING_WORKSPACE
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

/// 前端取走待打开的工作区（取完即清空）。
/// 同时把目录登记进路径守卫：命令行 / 拖到 exe 打开的目录要立刻能列目录、新建、删除。
#[tauri::command]
pub fn take_pending_workspace(guard: tauri::State<'_, PathGuard>) -> Option<String> {
    let dir = take_pending_workspace_raw();
    if let Some(root) = &dir {
        guard.add_root(root);
    }
    dir
}

/// 入队（冷启动解析结果与单实例转发共用）
pub fn push_pending(files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    if let Ok(mut guard) = PENDING.lock() {
        for file in files {
            if !guard.contains(&file) {
                guard.push(file);
            }
        }
    }
}

/// 前端取走全部待打开文件（取完即清空，重复调用不会重复打开）
#[tauri::command]
pub fn take_pending_files() -> Vec<String> {
    PENDING
        .lock()
        .map(|mut guard| std::mem::take(&mut *guard))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_path(tag: &str) -> PathBuf {
        crate::commands::test_support::temp_file("cli", tag, b"x")
    }

    /// 开关参数 / 不存在的路径被丢弃；同一路径只留一份
    #[test]
    fn filters_flags_and_missing_files_and_dedupes() {
        let file = temp_path("filter");
        let text = file.to_string_lossy().to_string();
        let args = vec![
            "--webview2-flag".to_string(),
            String::new(),
            "C:/definitely/not/exists/nope.txt".to_string(),
            text.clone(),
            text.clone(),
        ];
        assert_eq!(files_from_args(&args), vec![text.clone()]);
        let _ = fs::remove_file(&file);
    }

    /// 入队后可被取走，且取完即清空（第二个实例重复打开同一文件不会叠加）
    #[test]
    fn pending_queue_is_taken_once() {
        let file = temp_path("queue");
        let text = file.to_string_lossy().to_string();
        push_pending(vec![text.clone()]);
        push_pending(vec![text.clone()]);
        assert_eq!(take_pending_files(), vec![text.clone()]);
        assert!(take_pending_files().is_empty());
        let _ = fs::remove_file(&file);
    }

    /// 目录参数识别为工作区；文件参数不会被当成目录
    #[test]
    fn picks_directory_argument_as_workspace() {
        let dir = std::env::temp_dir().join("my_editor_cli_test_ws");
        fs::create_dir_all(&dir).expect("建临时目录");
        let file = temp_path("not_dir");
        let args = vec![
            "--webview2-flag".to_string(),
            file.to_string_lossy().to_string(),
            dir.to_string_lossy().to_string(),
        ];
        assert_eq!(
            dirs_from_args(&args),
            Some(dir.to_string_lossy().to_string())
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&file);
    }

    /// 工作区队列取完即清空（重启后不会重复打开上次的目录）
    #[test]
    fn pending_workspace_is_taken_once() {
        push_pending_workspace(Some("D:/tmp/ws-a".to_string()));
        assert_eq!(take_pending_workspace_raw(), Some("D:/tmp/ws-a".to_string()));
        assert_eq!(take_pending_workspace_raw(), None);
    }
}
