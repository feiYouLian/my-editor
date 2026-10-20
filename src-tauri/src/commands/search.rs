//! 全局搜索与替换：多线程并行遍历（尊重 .gitignore）+ 替换前备份与还原

use ignore::{WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Emitter;

use crate::commands::file::atomic_write;
use crate::commands::watch::{mark_writing, note_written, WatchState};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub use_regex: bool,
    /// 命中上限，达到即提前结束遍历
    pub max_results: usize,
    /// 单文件体积上限，超过则跳过
    pub max_file_bytes: u64,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            case_sensitive: false,
            use_regex: false,
            max_results: 2000,
            max_file_bytes: 5 * 1024 * 1024,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchHit {
    pub path: String,
    pub name: String,
    pub line: usize,
    pub column: usize,
    /// 命中前的上下文（左侧超长时截断）
    pub before: String,
    /// 命中的原文
    pub matched: String,
    /// 命中后的上下文（右侧超长时截断）
    pub after: String,
    /// 替换预览文案（未提供替换时为空串）
    pub replacement: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub hits: Vec<MatchHit>,
    pub truncated: bool,
    pub files_scanned: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub scanned: u64,
    pub hits: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub name: String,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    pub files_changed: usize,
    pub total_replacements: usize,
    pub backups: Vec<String>,
    pub failures: Vec<ReplaceFailure>,
}

/// 当前搜索任务的取消句柄（同一时刻只允许一个搜索）
#[derive(Default)]
pub struct SearchState {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

fn build_regex(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let pattern = if options.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| format!("正则表达式无效: {e}"))
}

/// 左侧上下文：超长时保留尾部并加省略号
fn clamp_head(s: &str) -> String {
    let total = s.chars().count();
    if total <= 80 {
        return s.to_string();
    }
    let head: String = s.chars().skip(total - 80).collect();
    format!("…{head}")
}

/// 右侧上下文：超长时保留头部并加省略号
fn clamp_tail(s: &str) -> String {
    if s.chars().count() <= 120 {
        return s.to_string();
    }
    let head: String = s.chars().take(120).collect();
    format!("{head}…")
}

/// 多线程并行遍历文本文件，对每个文件回调其文本内容
/// 跳过二进制（NUL 启发式）与超过 max_file_bytes 的文件
fn walk_text_files<F>(root: &str, max_file_bytes: u64, cancel: Arc<AtomicBool>, on_text: F)
where
    F: Fn(&Path, &str) + Send + Sync + 'static,
{
    let cb = Arc::new(on_text);
    WalkBuilder::new(Path::new(root)).build_parallel().run(move || {
        let cb = cb.clone();
        let cancel = cancel.clone();
        Box::new(move |entry| {
            if cancel.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let Ok(meta) = entry.metadata() else {
                return WalkState::Continue;
            };
            if meta.len() > max_file_bytes {
                return WalkState::Continue;
            }
            let path = entry.path();
            let Ok(bytes) = fs::read(path) else {
                return WalkState::Continue;
            };
            if bytes[..bytes.len().min(8192)].contains(&0) {
                return WalkState::Continue;
            }
            cb(path, &String::from_utf8_lossy(&bytes));
            WalkState::Continue
        })
    });
}

/// 全局搜索：并行遍历 + 命中上限提前结束 + 进度事件（200ms 节流）
#[tauri::command]
pub fn search_in_files(
    app: tauri::AppHandle,
    state: tauri::State<SearchState>,
    root: String,
    query: String,
    options: SearchOptions,
    replacement: Option<String>,
) -> Result<SearchOutcome, String> {
    if query.is_empty() {
        return Err("请输入查找内容".to_string());
    }
    let re = build_regex(&query, &options)?;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = state.cancel.lock() {
        *guard = Some(cancel.clone());
    }

    let hits: Arc<Mutex<Vec<MatchHit>>> = Arc::new(Mutex::new(Vec::new()));
    let scanned = Arc::new(AtomicU64::new(0));
    let last_emit = Arc::new(AtomicU64::new(0));
    let start = Instant::now();

    let cap = options.max_results;
    let use_regex = options.use_regex;
    let tpl = replacement.filter(|r| !r.is_empty());
    let hits_cb = hits.clone();
    let cancel_cb = cancel.clone();
    let scanned_cb = scanned.clone();
    let last_emit_cb = last_emit.clone();
    let app_cb = app.clone();

    walk_text_files(&root, options.max_file_bytes, cancel.clone(), move |path, text| {
        scanned_cb.fetch_add(1, Ordering::Relaxed);
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let path_str = path.to_string_lossy().to_string();

        let mut local: Vec<MatchHit> = Vec::new();
        'outer: for (i, line) in text.lines().enumerate() {
            for caps in re.captures_iter(line) {
                let Some(m) = caps.get(0) else { continue };
                let replacement_text = match tpl.as_deref() {
                    Some(template) if use_regex => {
                        let mut dst = String::new();
                        caps.expand(template, &mut dst);
                        dst
                    }
                    Some(template) => template.to_string(),
                    None => String::new(),
                };
                local.push(MatchHit {
                    path: path_str.clone(),
                    name: name.clone(),
                    line: i + 1,
                    column: line[..m.start()].chars().count() + 1,
                    before: clamp_head(&line[..m.start()]),
                    matched: line[m.start()..m.end()].to_string(),
                    after: clamp_tail(&line[m.end()..]),
                    replacement: replacement_text,
                });
                if local.len() >= cap {
                    break 'outer;
                }
            }
        }
        if !local.is_empty() {
            if let Ok(mut h) = hits_cb.lock() {
                h.extend(local);
                if h.len() >= cap {
                    cancel_cb.store(true, Ordering::Relaxed);
                }
            }
        }

        // 进度事件：节流 200ms
        let now = start.elapsed().as_millis() as u64;
        if now.saturating_sub(last_emit_cb.load(Ordering::Relaxed)) >= 200 {
            last_emit_cb.store(now, Ordering::Relaxed);
            let _ = app_cb.emit(
                "search://progress",
                ProgressPayload {
                    scanned: scanned_cb.load(Ordering::Relaxed),
                    hits: hits_cb.lock().map(|h| h.len()).unwrap_or(0),
                },
            );
        }
    });

    let cancelled = cancel.load(Ordering::Relaxed);
    let mut all = hits.lock().map(|h| h.clone()).unwrap_or_default();
    let truncated = all.len() > cap;
    if truncated {
        all.truncate(cap);
    }
    Ok(SearchOutcome {
        hits: all,
        truncated,
        files_scanned: scanned.load(Ordering::Relaxed),
        elapsed_ms: start.elapsed().as_millis() as u64,
        cancelled,
    })
}

/// 取消当前搜索
#[tauri::command]
pub fn cancel_search(state: tauri::State<SearchState>) -> bool {
    if let Ok(guard) = state.cancel.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
            return true;
        }
    }
    false
}

/// 替换预览：列出受影响文件与命中数（供确认清单）
#[tauri::command]
pub fn preview_replace(
    root: String,
    query: String,
    options: SearchOptions,
) -> Result<Vec<FileChange>, String> {
    if query.is_empty() {
        return Err("请输入查找内容".to_string());
    }
    let re = build_regex(&query, &options)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let out: Arc<Mutex<Vec<FileChange>>> = Arc::new(Mutex::new(Vec::new()));
    let out_cb = out.clone();

    walk_text_files(&root, options.max_file_bytes, cancel, move |path, text| {
        let count = re.find_iter(text).count();
        if count > 0 {
            if let Ok(mut v) = out_cb.lock() {
                v.push(FileChange {
                    path: path.to_string_lossy().to_string(),
                    name: path
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    count,
                });
            }
        }
    });

    let mut v = out.lock().map(|v| v.clone()).unwrap_or_default();
    v.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(v)
}

/// 单文件替换：可选备份为 <file>.bak，原子写回
fn replace_one(
    path: &Path,
    re: &Regex,
    replacement: &str,
    use_regex: bool,
    backup: bool,
    watch: &WatchState,
) -> Result<(usize, Option<String>), String> {
    let bytes = fs::read(path).map_err(|e| format!("读取失败: {e}"))?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err("二进制文件，已跳过".to_string());
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "非 UTF-8 编码，已跳过（避免转码风险）".to_string())?;
    let count = re.find_iter(text).count();
    if count == 0 {
        return Ok((0, None));
    }
    // 非正则模式按字面量替换（$ 不解释为捕获组）
    let new_text = if use_regex {
        re.replace_all(text, replacement).into_owned()
    } else {
        re.replace_all(text, regex::NoExpand(replacement)).into_owned()
    };

    let backup_path = if backup {
        let bak = PathBuf::from(format!("{}.bak", path.to_string_lossy()));
        fs::copy(path, &bak).map_err(|e| format!("备份失败: {e}"))?;
        Some(bak.to_string_lossy().to_string())
    } else {
        None
    };

    // 自身写盘：写前开静默窗口、写后刷新指纹（替换也可能命中已打开的文件）
    mark_writing(watch, path);
    atomic_write(path, new_text.as_bytes())?;
    note_written(watch, path);
    Ok((count, backup_path))
}

/// 批量替换：逐文件替换并做错误隔离（单文件失败不影响其余）
#[tauri::command]
pub fn replace_in_files(
    state: tauri::State<WatchState>,
    files: Vec<String>,
    query: String,
    replacement: String,
    options: SearchOptions,
    backup: bool,
) -> Result<ReplaceReport, String> {
    if query.is_empty() {
        return Err("请输入查找内容".to_string());
    }
    let re = build_regex(&query, &options)?;
    let mut report = ReplaceReport::default();

    for file in files {
        match replace_one(
            Path::new(&file),
            &re,
            &replacement,
            options.use_regex,
            backup,
            &state,
        ) {
            Ok((count, bak)) => {
                if let Some(b) = bak {
                    report.backups.push(b);
                }
                if count > 0 {
                    report.files_changed += 1;
                    report.total_replacements += count;
                }
            }
            Err(error) => report.failures.push(ReplaceFailure { path: file, error }),
        }
    }
    Ok(report)
}

/// 从 .bak 还原文件（还原成功后删除备份）
#[tauri::command]
pub fn restore_backups(
    state: tauri::State<WatchState>,
    files: Vec<String>,
) -> Result<usize, String> {
    let mut restored = 0usize;
    for file in files {
        let bak = PathBuf::from(format!("{file}.bak"));
        if !bak.exists() {
            continue;
        }
        let content = fs::read(&bak).map_err(|e| format!("读取备份失败: {e}"))?;
        // 自身写盘：写前开静默窗口、写后刷新指纹
        mark_writing(&state, Path::new(&file));
        atomic_write(Path::new(&file), &content)?;
        note_written(&state, Path::new(&file));
        let _ = fs::remove_file(&bak);
        restored += 1;
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_query_is_literal() {
        // '.' 与 '*' 在非正则模式下不应作为通配符
        let re = build_regex("a.b*c", &SearchOptions::default()).unwrap();
        assert!(re.is_match("xa.b*cy"));
        assert!(!re.is_match("aXb/c"));
    }

    #[test]
    fn case_insensitive_by_default() {
        let re = build_regex("Hello", &SearchOptions::default()).unwrap();
        assert!(re.is_match("say hello world"));
    }

    #[test]
    fn case_sensitive_when_requested() {
        let opts = SearchOptions {
            case_sensitive: true,
            ..SearchOptions::default()
        };
        let re = build_regex("Hello", &opts).unwrap();
        assert!(!re.is_match("say hello world"));
        assert!(re.is_match("say Hello world"));
    }

    #[test]
    fn regex_mode_uses_raw_pattern() {
        let opts = SearchOptions {
            use_regex: true,
            ..SearchOptions::default()
        };
        let re = build_regex(r"\d{3}", &opts).unwrap();
        assert!(re.is_match("abc123"));
        assert!(!re.is_match("ab12"));
    }

    #[test]
    fn invalid_regex_reports_error() {
        let opts = SearchOptions {
            use_regex: true,
            ..SearchOptions::default()
        };
        assert!(build_regex("(", &opts).is_err());
    }

    #[test]
    fn clamp_head_keeps_tail_with_ellipsis() {
        let long = "a".repeat(100);
        let out = clamp_head(&long);
        assert!(out.starts_with('…'));
        assert_eq!(out.chars().count(), 81);
        assert_eq!(clamp_head("short"), "short");
    }

    #[test]
    fn clamp_tail_keeps_head_with_ellipsis() {
        let long = "b".repeat(200);
        let out = clamp_tail(&long);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 121);
        assert_eq!(clamp_tail("short"), "short");
    }
}
