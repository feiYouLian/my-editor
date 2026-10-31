//! 命令行待打开文件：文件关联、把文件拖到 exe 上、第二实例转发。
//!
//! Windows 资源管理器「打开方式 ▸ my-editor」会把文件路径作为 argv 传给进程：
//! - 应用未运行：路径落在本进程的参数里（冷启动）；
//! - 应用已运行：路径落在单实例插件的回调参数里（热启动）。
//!
//! 两条路径都进同一个队列，前端就绪后一次取走，避免其中一种漏掉。

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// 待前端取走的文件（绝对路径，已去重）
static PENDING: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

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
        let mut path = std::env::temp_dir();
        path.push(format!("my_editor_cli_test_{tag}.txt"));
        fs::write(&path, b"x").expect("写临时文件");
        path
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
}
