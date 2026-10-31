//! 文件树外部变化监听：只监听“已展开目录”（非递归）。
//!
//! 与 watch.rs 的区别：
//! - watch_files 关注“已打开文件”的内容变化，推送 file://changed；
//! - 本模块关注“目录里增删改名”，推送 tree://changed，供文件树刷新对应层。
//! 两者分开，避免把文件内容事件与目录结构事件混在一起。

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const TREE_CHANGED_EVENT: &str = "tree://changed";
/// 监听目录上限：每个目录一个句柄，避免展开超大仓库时耗尽句柄
const MAX_WATCH_DIRS: usize = 200;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeChanged {
    /// 发生变化的直接父目录（前端据此只刷新这一层）
    pub dir: String,
    /// 事件涉及的路径（仅供诊断，前端暂不使用）
    pub paths: Vec<String>,
}

#[derive(Default, Clone)]
pub struct TreeWatchState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    watcher: Option<RecommendedWatcher>,
    dirs: HashSet<PathBuf>,
}

/// 用“已展开目录 + 工作区根”重建监听集合（非递归）。
/// 目录集合未变化时不重建 watcher；返回实际监听数量。
#[tauri::command]
pub fn watch_dirs(
    app: AppHandle,
    state: tauri::State<TreeWatchState>,
    paths: Vec<String>,
) -> Result<usize, String> {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());

    let mut dirs: HashSet<PathBuf> = HashSet::new();
    for raw in paths {
        if dirs.len() >= MAX_WATCH_DIRS {
            break;
        }
        let path = PathBuf::from(raw);
        if path.is_dir() {
            dirs.insert(path);
        }
    }

    if inner.dirs == dirs && inner.watcher.is_some() {
        return Ok(dirs.len());
    }
    inner.watcher = None;
    inner.dirs = dirs.clone();
    if dirs.is_empty() {
        return Ok(0);
    }

    let app_handle = app.clone();
    let watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            // 只关心结构变化（新建 / 删除 / 重命名）；
            // 文件内容写入也走 Modify(Data)，不能触发整层刷新，否则每次保存都多一次目录 IPC
            let structural = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
            );
            if !structural {
                return;
            }
            handle_event(&app_handle, event);
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("创建文件树监听失败: {e}"))?;

    let mut watcher = watcher;
    for dir in &dirs {
        if let Err(e) = watcher.watch(dir, RecursiveMode::NonRecursive) {
            eprintln!("[tree-watch] 监听目录失败 {}: {e}", dir.display());
        }
    }
    inner.watcher = Some(watcher);
    Ok(dirs.len())
}

fn handle_event(app: &AppHandle, event: Event) {
    // 事件可能跨目录（重命名）：按直接父目录分组，前端只刷新对应层
    let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
    for path in event.paths {
        if let Some(parent) = path.parent() {
            grouped
                .entry(parent.to_string_lossy().to_string())
                .or_default()
                .push(path.to_string_lossy().to_string());
        }
    }
    for (dir, paths) in grouped {
        if let Err(e) = app.emit(TREE_CHANGED_EVENT, TreeChanged { dir, paths }) {
            eprintln!("[tree-watch] 事件推送失败: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_dirs_is_reasonable() {
        assert!(MAX_WATCH_DIRS >= 50);
    }
}
