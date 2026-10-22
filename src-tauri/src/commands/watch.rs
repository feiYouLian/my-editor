//! 外部修改检测。
//! 监听已打开文件所在目录，内容变化时推送 `file://changed` 事件；
//! 前端仅在状态栏提示，不自动重载（由用户触发重载）。
//!
//! 自身保存引起的写入被抑制：前端保存后会重新登记文件指纹，
//! 登记时给该文件一段静默窗口，窗口内的写入事件只刷新指纹、不推送。

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// 登记后抑制自身写入事件的窗口（毫秒）
const SUPPRESS_MS: u64 = 1500;
/// 事件名（前端 listen）
pub const CHANGED_EVENT: &str = "file://changed";

/// 单个被监听文件
#[derive(Clone)]
struct Entry {
    /// 前端登记的原始路径（回传用）
    original: String,
    /// 修改时间（毫秒）
    mtime: u64,
    /// 字节数
    size: u64,
    /// 该时刻之前的写入视为自身保存，不推送
    suppress_until_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChanged {
    pub path: String,
}

#[derive(Default, Clone)]
pub struct WatchState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    watcher: Option<RecommendedWatcher>,
    /// 规范化路径 → 条目（Arc 与事件回调共享）
    known: Arc<Mutex<HashMap<String, Entry>>>,
    /// 当前监听的目录集合（未变化时不重建 watcher）
    dirs: HashSet<PathBuf>,
}

/// 规范化路径：统一分隔符与大小写，去 Windows 扩展前缀，便于跨来源比较
fn norm(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\").to_lowercase();
    s.trim_start_matches("\\\\?\\").to_string()
}

/// 文件指纹：修改时间（毫秒）+ 字节数；不可读时返回 None
fn fingerprint(path: &Path) -> Option<(u64, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some((mtime, md.len()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 登记需要监听的文件（打开 / 保存 / 关闭标签后调用）。
/// 每次都重建指纹表；目录集合未变时不重建 watcher。
/// 同时把监听路径登记进路径守卫（应用已知路径）。
#[tauri::command]
pub fn watch_files(
    app: AppHandle,
    state: tauri::State<WatchState>,
    guard: tauri::State<crate::commands::paths::PathGuard>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());

    let mut known: HashMap<String, Entry> = HashMap::new();
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    let suppress_until_ms = now_ms() + SUPPRESS_MS;
    for raw in paths {
        let path = PathBuf::from(&raw);
        let Some((mtime, size)) = fingerprint(&path) else {
            continue;
        };
        guard.add_path(&raw);
        if let Some(parent) = path.parent() {
            dirs.insert(parent.to_path_buf());
        }
        known.insert(
            norm(&path),
            Entry {
                original: raw,
                mtime,
                size,
                suppress_until_ms,
            },
        );
    }

    // 指纹表始终替换（回调持有同一个 Arc）
    *inner.known.lock().unwrap_or_else(|e| e.into_inner()) = known;

    if inner.dirs == dirs && inner.watcher.is_some() {
        return Ok(());
    }
    inner.watcher = None;
    inner.dirs = dirs.clone();
    if dirs.is_empty() {
        return Ok(());
    }

    let known_shared = Arc::clone(&inner.known);
    let app_handle = app.clone();
    let watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else {
                return;
            };
            handle_event(&app_handle, &known_shared, event);
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("创建文件监听失败: {e}"))?;

    let mut watcher = watcher;
    for dir in &dirs {
        // 单个目录监听失败不阻断其余目录
        if let Err(e) = watcher.watch(dir, RecursiveMode::NonRecursive) {
            eprintln!("[watch] 监听目录失败 {}: {e}", dir.display());
        }
    }
    inner.watcher = Some(watcher);
    Ok(())
}

/// 事件处理：命中已登记文件且指纹变化时推送（自身保存窗口内只刷新指纹）
fn handle_event(
    app: &AppHandle,
    known: &Arc<Mutex<HashMap<String, Entry>>>,
    event: Event,
) {
    let mut map = known.lock().unwrap_or_else(|e| e.into_inner());
    for path in &event.paths {
        let key = norm(path);
        let Some(entry) = map.get_mut(&key) else {
            continue;
        };
        let Some((mtime, size)) = fingerprint(path) else {
            continue;
        };
        // 指纹未变（如仅元数据事件）→ 忽略
        if entry.mtime == mtime && entry.size == size {
            continue;
        }
        entry.mtime = mtime;
        entry.size = size;
        if now_ms() < entry.suppress_until_ms {
            continue; // 自身保存引起的写入
        }
        let payload = FileChanged {
            path: entry.original.clone(),
        };
        if let Err(e) = app.emit(CHANGED_EVENT, payload) {
            eprintln!("[watch] 事件推送失败: {e}");
        }
    }
}

/// 在已登记文件表上执行一次操作（锁顺序：状态锁 → 表锁，与 watch_files 一致）
fn with_known<R>(state: &WatchState, f: impl FnOnce(&mut HashMap<String, Entry>) -> R) -> R {
    let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = inner.known.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut map)
}

/// 自身写盘**前**调用：先给该路径开静默窗口，覆盖「写盘完成 → 刷新指纹」之间的空档。
/// 不这样做的话，notify 事件可能在写盘瞬间就被处理，早于前端保存后的重新登记。
pub(crate) fn mark_writing(state: &WatchState, path: &Path) {
    with_known(state, |map| {
        if let Some(entry) = map.get_mut(&norm(path)) {
            entry.suppress_until_ms = now_ms() + SUPPRESS_MS;
        }
    });
}

/// 自身写盘**后**调用：刷新指纹并延长静默窗口。
/// 此后 notify 回调看到指纹一致会直接跳过，即便晚于静默窗口也不会误报。
pub(crate) fn note_written(state: &WatchState, path: &Path) {
    with_known(state, |map| {
        if let Some(entry) = map.get_mut(&norm(path)) {
            if let Some((mtime, size)) = fingerprint(path) {
                entry.mtime = mtime;
                entry.size = size;
            }
            entry.suppress_until_ms = now_ms() + SUPPRESS_MS;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_ignores_separators_case_and_extended_prefix() {
        assert_eq!(norm(Path::new("D:/a/b.txt")), "d:\\a\\b.txt");
        assert_eq!(norm(Path::new("d:\\A\\B.TXT")), "d:\\a\\b.txt");
        assert_eq!(norm(Path::new("\\\\?\\D:\\a\\b.txt")), "d:\\a\\b.txt");
    }

    #[test]
    fn fingerprint_reports_size_and_missing_file_is_none() {
        let mut p = std::env::temp_dir();
        p.push("my_editor_watch_test.txt");
        std::fs::write(&p, b"hello").unwrap();
        let (mtime, size) = fingerprint(&p).expect("可读文件应有指纹");
        assert_eq!(size, 5);
        assert!(mtime > 0);

        assert!(fingerprint(&p.with_extension("missing")).is_none());
    }

    /// 自身写盘：写前开静默窗口、写后刷新指纹（写后指纹一致 → 事件回调直接跳过）
    #[test]
    fn mark_and_note_written_refresh_fingerprint_and_open_window() {
        let mut path = std::env::temp_dir();
        path.push("my_editor_watch_suppress_test.txt");
        std::fs::write(&path, b"v1").unwrap();

        let state = WatchState::default();
        with_known(&state, |map| {
            map.insert(
                norm(&path),
                Entry {
                    original: path.to_string_lossy().to_string(),
                    mtime: 1,
                    size: 2,
                    suppress_until_ms: 0,
                },
            );
        });

        mark_writing(&state, &path);
        with_known(&state, |map| {
            assert!(map.get(&norm(&path)).unwrap().suppress_until_ms > now_ms());
        });

        std::fs::write(&path, b"v2-longer").unwrap();
        note_written(&state, &path);
        with_known(&state, |map| {
            let entry = map.get(&norm(&path)).unwrap();
            let (mtime, size) = fingerprint(&path).unwrap();
            assert_eq!((entry.mtime, entry.size), (mtime, size));
            assert!(entry.suppress_until_ms > now_ms());
        });
    }

    /// 未登记的文件：标记为空操作，不影响其它条目
    #[test]
    fn mark_written_on_unregistered_path_is_noop() {
        let state = WatchState::default();
        mark_writing(&state, Path::new("Z:/not/registered.txt"));
        note_written(&state, Path::new("Z:/not/registered.txt"));
        with_known(&state, |map| assert!(map.is_empty()));
    }
}
