//! 工作区检索：文件列表（Ctrl+P 快速打开）、内容搜索与批量替换。
//!
//! 遍历统一用 `ignore` crate：尊重 .gitignore，并按配置跳过 ignoreDirs。
//! 安全边界：搜索只读扫描；替换逐文件原子写入，并受 PathGuard 作用域约束。
//! 兜底方式：替换前把原文快照写入应用配置目录的 `replace-history/`，
//! 支持一键撤销（参考 VS Code / JetBrains 的本地历史，不在源目录生成 `.bak`）。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use tauri::Manager;

use crate::commands::encoding;
use crate::commands::file::atomic_write;
use crate::commands::paths::PathGuard;

/// 单文件读取上限：超过视为不适合全文搜索（与前端提示一致）
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 二进制嗅探字节数：前 8KB 出现 NUL 即跳过
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// 结果行预览长度（字符）
const PREVIEW_CHARS: usize = 240;

#[derive(Serialize)]
pub struct WorkspaceFile {
    pub path: String,
    pub relative: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct SearchMatch {
    pub line: u32,
    pub col: u32,
    /// 命中前的行内文本（长行会以省略号开头）
    pub before: String,
    /// 命中的原文（前端渲染为红色删除线）
    pub hit: String,
    /// 命中后的行内文本（长行会以省略号结尾）
    pub after: String,
}

#[derive(Serialize)]
pub struct FileMatches {
    pub path: String,
    pub relative: String,
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct SearchReport {
    pub files: Vec<FileMatches>,
    pub total_matches: usize,
    pub truncated: bool,
}

/// 构造尊重 .gitignore 且跳过 ignoreDirs 的遍历器。
fn walker(root: &Path, ignore_dirs: &[String]) -> ignore::Walk {
    let ignores: Arc<Vec<String>> = Arc::new(
        ignore_dirs
            .iter()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect(),
    );
    WalkBuilder::new(root)
        // 允许点文件（.env / .gitignore 等也是常见编辑对象）
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                return true;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            !ignores.iter().any(|d| d == &name)
        })
        .build()
}

/// 去掉 Windows canonicalize 产生的 `\\?\` / `//?/` 前缀（仅用于显示）
fn strip_verbatim(s: &str) -> &str {
    s.strip_prefix("\\\\?\\")
        .or_else(|| s.strip_prefix("//?/"))
        .unwrap_or(s)
}

fn relative_of(root: &Path, path: &Path) -> String {
    // root 来自前端（普通路径），path 来自 PathGuard::normalize（可能带 `\\?\`）
    let root_owned = root.to_string_lossy();
    let path_owned = path.to_string_lossy();
    let root_str = strip_verbatim(root_owned.as_ref());
    let path_str = strip_verbatim(path_owned.as_ref());
    Path::new(path_str)
        .strip_prefix(Path::new(root_str))
        .unwrap_or(Path::new(path_str))
        .to_string_lossy()
        .replace('\\', "/")
}

// ---------------------------------------------------------------------------
// 替换历史（集中存于应用配置目录，替代源目录 .bak）
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
struct HistoryEntry {
    path: String,
    relative: String,
    /// 原文快照文件名（0000.bin…，保持原编码字节）
    backup: String,
    /// 替换后的指纹：撤销前校验文件是否又被改过
    after_mtime_ms: u64,
    after_size: u64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
struct HistoryManifest {
    id: String,
    created_at_ms: u64,
    root: String,
    files: Vec<HistoryEntry>,
}

static HISTORY_SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_history_id() -> String {
    format!(
        "{}-{:03}",
        now_ms(),
        HISTORY_SEQ.fetch_add(1, Ordering::Relaxed) % 1000
    )
}

fn history_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?
        .join("replace-history");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建替换历史目录失败: {e}"))?;
    Ok(dir)
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 把命中行切成「前 / 命中 / 后」三段（字符边界安全）。
///
/// 长行不直接截断：以命中为中心开窗（前 60 / 后 120 字符），
/// 否则命中在行尾时预览里根本看不到。窗口外补省略号。
fn split_match_preview(line: &str, start_byte: usize, end_byte: usize) -> (String, String, String) {
    let chars: Vec<char> = line.chars().collect();
    let total = chars.len();
    let start = line[..start_byte.min(line.len())]
        .chars()
        .count()
        .min(total);
    let end = line[..end_byte.min(line.len())]
        .chars()
        .count()
        .min(total)
        .max(start);

    let mut win_start = 0usize;
    let mut win_end = total;
    if total > PREVIEW_CHARS {
        win_start = start.saturating_sub(60);
        win_end = (end + 120).min(total);
        if win_end - win_start > PREVIEW_CHARS {
            win_end = (win_start + PREVIEW_CHARS).min(total);
        }
        // 命中本身极长时不能把它截没：窗口至少覆盖完整命中
        if win_end < end {
            win_end = end.min(total);
        }
    }

    let mut before: String = chars[win_start..start].iter().collect();
    if win_start > 0 {
        before.insert(0, '…');
    }
    let hit: String = chars[start..end].iter().collect();
    let mut after: String = if end < win_end {
        chars[end..win_end].iter().collect()
    } else {
        String::new()
    };
    if win_end < total {
        after.push('…');
    }
    (before, hit, after)
}

/// 备份 / 临时文件：不参与批量替换。
/// 否则“搜索 → 全选 → 替换”会把上一次的备份也改掉，
/// 形成 `a.txt.bak.bak.bak` 链并丢失回退能力。
fn is_backup_or_temp(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name.ends_with(".bak") || name.ends_with(".tmp") || name.ends_with('~')
}

/// 列出工作区文件（快速打开的数据源）。只返回文件，按相对路径排序后截断。
#[tauri::command]
pub async fn list_workspace_files(
    root: String,
    ignore_dirs: Vec<String>,
    limit: usize,
) -> Result<Vec<WorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || list_files_blocking(&root, &ignore_dirs, limit))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

/// 文件列表的实际实现（同步；命令只负责 spawn_blocking 包装）。
fn list_files_blocking(
    root: &str,
    ignore_dirs: &[String],
    limit: usize,
) -> Result<Vec<WorkspaceFile>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err("工作区目录不存在".to_string());
    }
    let limit = limit.max(1);
    let mut files: Vec<WorkspaceFile> = Vec::new();
    for result in walker(&root_path, ignore_dirs) {
        let entry = match result {
            Ok(e) => e,
            // 单个条目不可读（权限 / 占用）不应中断整体扫描
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        files.push(WorkspaceFile {
            path: path.to_string_lossy().to_string(),
            relative: relative_of(&root_path, path),
            name: entry.file_name().to_string_lossy().to_string(),
        });
        if files.len() >= limit {
            break;
        }
    }
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(files)
}

/// 工作区内容搜索：按行返回命中（每行一条，取首个命中列）。
///
/// 统一走 regex 引擎：字面量模式对 query 做 escape，
/// 大小写敏感的字面量额外用 memchr 预筛整文件（无命中直接跳过）。
#[tauri::command]
pub async fn search_workspace(
    root: String,
    query: String,
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
    ignore_dirs: Vec<String>,
    max_files: usize,
    max_matches: usize,
) -> Result<SearchReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_blocking(
            &root,
            &query,
            case_sensitive,
            regex,
            &ignore_dirs,
            max_files.max(1),
            max_matches.max(1),
            whole_word,
        )
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// \b 只对 ASCII 单词边界有意义：中文没有词边界概念（regex crate 也不支持 lookaround），
/// 因此非 ASCII 查询直接忽略 whole_word，避免出现"勾了却什么也没变"的困惑。
fn apply_whole_word(pattern: String, query: &str, whole_word: bool) -> String {
    if !whole_word {
        return pattern;
    }
    let ascii_word = query.is_ascii() && query.chars().any(|c| c.is_alphanumeric());
    if !ascii_word {
        return pattern;
    }
    format!(r"\b(?:{pattern})\b")
}

fn search_blocking(
    root: &str,
    query: &str,
    case_sensitive: bool,
    regex: bool,
    ignore_dirs: &[String],
    max_files: usize,
    max_matches: usize,
    whole_word: bool,
) -> Result<SearchReport, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err("工作区目录不存在".to_string());
    }
    if query.trim().is_empty() {
        return Ok(SearchReport {
            files: Vec::new(),
            total_matches: 0,
            truncated: false,
        });
    }

    let pattern = if regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = apply_whole_word(pattern, query, whole_word);
    let matcher = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(4 * 1024 * 1024)
        .build()
        .map_err(|e| format!("正则表达式无效: {e}"))?;

    // 字面量 + 大小写敏感：整文件预筛（memmem 比逐行正则快一个量级）
    let prefilter: Option<Vec<u8>> = if !regex && case_sensitive {
        Some(query.as_bytes().to_vec())
    } else {
        None
    };

    let mut files: Vec<FileMatches> = Vec::new();
    let mut total_matches = 0usize;
    let mut truncated = false;

    'files: for result in walker(&root_path, ignore_dirs) {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // 二进制嗅探：前 8KB 含 NUL 即跳过（避免把图片/压缩包当文本扫描）
        if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
            continue;
        }
        if let Some(needle) = &prefilter {
            if memchr::memmem::find(&bytes, needle).is_none() {
                continue;
            }
        }
        let text = String::from_utf8_lossy(&bytes);

        let mut matches: Vec<SearchMatch> = Vec::new();
        let mut file_truncated = false;
        for (idx, line) in text.lines().enumerate() {
            let Some(m) = matcher.find(line) else {
                continue;
            };
            let col = line[..m.start()].chars().count() + 1;
            let (before, hit, after) = split_match_preview(line, m.start(), m.end());
            matches.push(SearchMatch {
                line: idx as u32 + 1,
                col: col as u32,
                before,
                hit,
                after,
            });
            total_matches += 1;
            if total_matches >= max_matches {
                truncated = true;
                files.push(FileMatches {
                    path: path.to_string_lossy().to_string(),
                    relative: relative_of(&root_path, path),
                    matches,
                    truncated: file_truncated,
                });
                break 'files;
            }
            if matches.len() >= max_matches {
                file_truncated = true;
                break;
            }
        }
        if !matches.is_empty() {
            files.push(FileMatches {
                path: path.to_string_lossy().to_string(),
                relative: relative_of(&root_path, path),
                matches,
                truncated: file_truncated,
            });
            if files.len() >= max_files {
                truncated = true;
                break;
            }
        }
    }

    Ok(SearchReport {
        files,
        total_matches,
        truncated,
    })
}

#[derive(Serialize)]
pub struct FileReplaceResult {
    pub path: String,
    pub relative: String,
    pub replaced: usize,
    /// 空串 = 成功；非空 = 跳过原因
    pub skipped_reason: String,
}

#[derive(Serialize)]
pub struct ReplaceReport {
    pub files: Vec<FileReplaceResult>,
    pub replaced_files: usize,
    pub replaced_matches: usize,
    /// 替换历史 id（空串 = 未保留历史 / 历史写入失败，无法撤销）
    pub history_id: String,
}

/// 批量替换：只处理前端勾选的文件，逐文件原子写入。
///
/// 安全与一致性约束：
/// - 作用域：每个目标先经 PathGuard 校验，越界整体拒绝；
/// - 编码：严格解码/编码，遇到无法映射的字节即跳过（不静默改字）；
/// - 兜底：替换前把原文快照写入应用配置目录的替换历史（不生成 `.bak`，
///   因此同一文件可以反复替换，不会因旧备份存在而被拒）；
/// - 并发：写前再校验 len + mtime，外部修改后跳过；
/// - 写入：复用 `file::atomic_write`（临时文件 → fsync → rename）。
#[tauri::command]
pub async fn replace_in_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    watch: tauri::State<'_, crate::commands::watch::WatchState>,
    root: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
    keep_history: bool,
    targets: Vec<String>,
) -> Result<ReplaceReport, String> {
    if targets.is_empty() {
        return Err("没有选择要替换的文件".to_string());
    }
    if query.trim().is_empty() {
        return Err("替换关键词为空".to_string());
    }
    // 作用域校验放外层：闭包内不再借用 State。
    // 同时保留前端传入的原始路径：canonicalize 后的路径带 `\\?\` 前缀，
    // 前端标签的 path 是原始字符串，用规范路径回传会导致“已打开标签”匹配失败。
    let mut scoped: Vec<(String, PathBuf)> = Vec::with_capacity(targets.len());
    for target in &targets {
        scoped.push((target.clone(), state.ensure_file_scope(target)?));
    }
    let root_path = PathBuf::from(&root);
    // 自身写盘：clone 后传入闭包，逐文件标记 writing / 刷新指纹，
    // 否则 notify 会把本次替换误报成“外部修改”
    let watch_state = (*watch).clone();

    let (history_dir, history_id) = if keep_history {
        let id = new_history_id();
        let dir = history_root(&app)?.join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建替换历史失败: {e}"))?;
        (Some(dir), id)
    } else {
        (None, String::new())
    };

    tauri::async_runtime::spawn_blocking(move || {
        replace_blocking(
            &root_path,
            &query,
            &replacement,
            case_sensitive,
            regex,
            whole_word,
            &scoped,
            &watch_state,
            history_dir.as_deref(),
            &history_id,
        )
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

fn replace_blocking(
    root: &Path,
    query: &str,
    replacement: &str,
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
    targets: &[(String, PathBuf)],
    watch: &crate::commands::watch::WatchState,
    history_dir: Option<&Path>,
    history_id: &str,
) -> Result<ReplaceReport, String> {
    let pattern = if regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    // 与搜索保持同一口径：搜索勾了全词，替换也必须只替换全词
    let pattern = apply_whole_word(pattern, query, whole_word);
    let matcher = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(4 * 1024 * 1024)
        .build()
        .map_err(|e| format!("正则表达式无效: {e}"))?;

    let mut files = Vec::with_capacity(targets.len());
    let mut entries: Vec<HistoryEntry> = Vec::new();
    let mut history_ok = history_dir.is_some();
    let mut replaced_files = 0usize;
    let mut replaced_matches = 0usize;
    for (raw_path, path) in targets {
        // 显示与回传都用原始路径（与前端 tab.path 同一口径）
        let relative = relative_of(root, Path::new(raw_path));
        if is_backup_or_temp(path) {
            files.push(FileReplaceResult {
                path: raw_path.clone(),
                relative,
                replaced: 0,
                skipped_reason: "备份/临时文件不参与替换".to_string(),
            });
            continue;
        }
        // 自身写盘：先标记「正在写」→ 替换 → 无论成败都刷新指纹
        crate::commands::watch::mark_writing(watch, path);
        let outcome = replace_one(path, &matcher, replacement, regex);
        crate::commands::watch::note_written(watch, path);
        match outcome {
            Ok(ok) => {
                replaced_files += 1;
                replaced_matches += ok.count;
                if let Some(dir) = history_dir {
                    let backup_name = format!("{:04}.bin", entries.len());
                    if std::fs::write(dir.join(&backup_name), &ok.before).is_ok() {
                        let meta = std::fs::metadata(path).ok();
                        entries.push(HistoryEntry {
                            path: raw_path.clone(),
                            relative: relative.clone(),
                            backup: backup_name,
                            after_mtime_ms: meta.as_ref().map(mtime_ms).unwrap_or(0),
                            after_size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        });
                    } else {
                        // 历史写入失败：整体标记为“无历史”，前端不会展示撤销
                        history_ok = false;
                    }
                }
                files.push(FileReplaceResult {
                    path: raw_path.clone(),
                    relative,
                    replaced: ok.count,
                    skipped_reason: String::new(),
                });
            }
            Err(reason) => files.push(FileReplaceResult {
                path: raw_path.clone(),
                relative,
                replaced: 0,
                skipped_reason: reason,
            }),
        }
    }

    // 写 manifest（仅当历史可用且有成功项）；否则清掉半成品目录
    let mut report_history_id = String::new();
    if let Some(dir) = history_dir {
        if history_ok && !entries.is_empty() {
            let manifest = HistoryManifest {
                id: history_id.to_string(),
                created_at_ms: now_ms(),
                root: root.to_string_lossy().to_string(),
                files: entries,
            };
            let written = serde_json::to_string_pretty(&manifest)
                .map_err(|e| e.to_string())
                .and_then(|json| std::fs::write(dir.join("manifest.json"), json).map_err(|e| e.to_string()));
            if written.is_ok() {
                report_history_id = history_id.to_string();
            } else {
                let _ = std::fs::remove_dir_all(dir);
            }
        } else {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    Ok(ReplaceReport {
        files,
        replaced_files,
        replaced_matches,
        history_id: report_history_id,
    })
}

#[derive(Debug)]
struct ReplaceOneOk {
    count: usize,
    /// 替换前的原始字节（用于写撤销历史）
    before: Vec<u8>,
}

/// 单文件替换：成功返回替换处数 + 原文快照
fn replace_one(
    path: &Path,
    matcher: &regex::Regex,
    replacement: &str,
    regex: bool,
) -> Result<ReplaceOneOk, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取失败: {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("文件超过 2MB".to_string());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读取失败: {e}"))?;
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Err("二进制文件".to_string());
    }

    let has_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let guess = encoding::guess(&bytes);
    let text = encoding::decode_checked(&bytes, &guess.encoding)
        .map_err(|e| format!("解码失败（{}）: {e}", guess.encoding))?;

    let count = matcher.find_iter(&text).count();
    if count == 0 {
        return Err("无命中".to_string());
    }
    let replaced = if regex {
        matcher.replace_all(&text, replacement).into_owned()
    } else {
        // 字面量：替换文本按原样插入，不解释 $1
        matcher
            .replace_all(&text, regex::NoExpand(replacement))
            .into_owned()
    };
    if replaced == text {
        return Err("替换后无变化".to_string());
    }

    let out = encoding::encode_checked(&replaced, &guess.encoding, has_bom)
        .map_err(|e| format!("编码失败（{}）: {e}", guess.encoding))?;

    // 写前校验：读取后被外部修改则跳过（避免覆盖别人的修改）
    let after = std::fs::metadata(path).map_err(|e| format!("读取失败: {e}"))?;
    if after.len() != meta.len() || after.modified().ok() != meta.modified().ok() {
        return Err("文件已被外部修改，已跳过".to_string());
    }
    atomic_write(path, &out)?;
    Ok(ReplaceOneOk {
        count,
        before: bytes,
    })
}

#[derive(Serialize)]
pub struct UndoSkip {
    pub relative: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct UndoReport {
    pub restored_files: usize,
    /// 实际还原成功的路径（前端用于重载标签与文件树）
    pub restored_paths: Vec<String>,
    pub skipped: Vec<UndoSkip>,
}

/// 撤销一次批量替换：把历史快照写回原文件。
/// 若文件在替换后又被修改（mtime/size 变化）则跳过，保护后续编辑。
#[tauri::command]
pub async fn undo_replace(
    app: tauri::AppHandle,
    state: tauri::State<'_, PathGuard>,
    history_id: String,
) -> Result<UndoReport, String> {
    let dir = history_root(&app)?.join(&history_id);
    let manifest_text = std::fs::read_to_string(dir.join("manifest.json"))
        .map_err(|e| format!("读取替换历史失败: {e}"))?;
    let manifest: HistoryManifest = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("解析替换历史失败: {e}"))?;
    // 作用域复核（历史由本应用写入，仍按最小权限再查一次）；
    // 保留原始路径用于回传给前端重载已打开标签。
    let mut scoped: Vec<(String, PathBuf, HistoryEntry)> = Vec::with_capacity(manifest.files.len());
    for entry in &manifest.files {
        scoped.push((
            entry.path.clone(),
            state.ensure_file_scope(&entry.path)?,
            entry.clone(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut restored_paths = Vec::new();
        let mut skipped = Vec::new();
        for (raw_path, path, entry) in scoped {
            let unchanged = std::fs::metadata(&path)
                .ok()
                .as_ref()
                .map(|m| mtime_ms(m) == entry.after_mtime_ms && m.len() == entry.after_size)
                .unwrap_or(false);
            if !unchanged {
                skipped.push(UndoSkip {
                    relative: entry.relative.clone(),
                    reason: "替换后文件又被修改，未还原".to_string(),
                });
                continue;
            }
            match std::fs::read(dir.join(&entry.backup)) {
                Ok(bytes) => match atomic_write(&path, &bytes) {
                    Ok(_) => restored_paths.push(raw_path),
                    Err(e) => skipped.push(UndoSkip {
                        relative: entry.relative.clone(),
                        reason: e,
                    }),
                },
                Err(e) => skipped.push(UndoSkip {
                    relative: entry.relative.clone(),
                    reason: format!("读取快照失败: {e}"),
                }),
            }
        }
        // 全部还原成功才删除历史目录（部分失败保留，便于重试）
        if skipped.is_empty() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        Ok(UndoReport {
            restored_files: restored_paths.len(),
            restored_paths,
            skipped,
        })
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 清理过期替换历史：保留最近 `keep` 批且不超过 `days` 天。
#[tauri::command]
pub async fn cleanup_replace_history(
    app: tauri::AppHandle,
    keep: usize,
    days: u64,
) -> Result<usize, String> {
    let root = history_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let now = now_ms();
        let mut items: Vec<(u64, PathBuf)> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let created = std::fs::read_to_string(path.join("manifest.json"))
                    .ok()
                    .and_then(|t| serde_json::from_str::<HistoryManifest>(&t).ok())
                    .map(|m| m.created_at_ms)
                    .unwrap_or(0);
                items.push((created, path));
            }
        }
        items.sort_by(|a, b| b.0.cmp(&a.0));
        let max_age = days.saturating_mul(24 * 60 * 60 * 1000);
        let mut removed = 0usize;
        for (i, (created, path)) in items.into_iter().enumerate() {
            let expired = max_age > 0 && now.saturating_sub(created) > max_age;
            if i >= keep.max(1) || expired {
                if std::fs::remove_dir_all(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("my_editor_search_test_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn search(
        root: &Path,
        query: &str,
        case_sensitive: bool,
        regex: bool,
        ignores: &[&str],
        max_files: usize,
        max_matches: usize,
    ) -> SearchReport {
        let ignore_dirs: Vec<String> = ignores.iter().map(|s| s.to_string()).collect();
        search_blocking(
            root.to_str().unwrap(),
            query,
            case_sensitive,
            regex,
            &ignore_dirs,
            max_files,
            max_matches,
            false,
        )
        .unwrap()
    }

    fn search_whole_word(root: &Path, query: &str) -> SearchReport {
        search_blocking(
            root.to_str().unwrap(),
            query,
            false,
            false,
            &[],
            10,
            100,
            true,
        )
        .unwrap()
    }

    #[test]
    fn finds_literal_matches_with_line_and_column() {
        let dir = temp_dir("literal");
        std::fs::write(dir.join("a.txt"), "hello\nworld hello\n").unwrap();

        let report = search(&dir, "hello", true, false, &[], 10, 100);

        assert_eq!(report.total_matches, 2);
        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].relative, "a.txt");
        let matches = &report.files[0].matches;
        // 列号是字符列（1 基）：第二行 "world hello" 的 hello 从第 7 列开始
        assert_eq!((matches[0].line, matches[0].col), (1, 1));
        assert_eq!((matches[1].line, matches[1].col), (2, 7));
    }

    #[test]
    fn whole_word_skips_substring_matches() {
        let dir = temp_dir("whole_word");
        std::fs::write(dir.join("a.txt"), "cat\nconcat cats\nCat\n").unwrap();

        // 报告口径是"每行一条命中"：三行都含 cat 子串（忽略大小写）
        assert_eq!(search(&dir, "cat", false, false, &[], 10, 100).total_matches, 3);
        // 全词：只剩第 1 行 cat 与第 3 行 Cat；"concat"/"cats" 不再算命中
        assert_eq!(search_whole_word(&dir, "cat").total_matches, 2);
    }

    #[test]
    fn whole_word_is_ignored_for_non_ascii_query() {
        let dir = temp_dir("whole_word_cjk");
        std::fs::write(dir.join("a.txt"), "中文测试\n测试用例\n").unwrap();

        // 中文没有词边界：勾了全词也应等价于普通搜索，不能变成 0 命中
        assert_eq!(search_whole_word(&dir, "测试").total_matches, 2);
    }

    #[test]
    fn case_sensitivity_controls_results() {
        let dir = temp_dir("case");
        std::fs::write(dir.join("a.txt"), "Hello\nhello\n").unwrap();

        assert_eq!(search(&dir, "hello", true, false, &[], 10, 100).total_matches, 1);
        assert_eq!(
            search(&dir, "hello", false, false, &[], 10, 100).total_matches,
            2
        );
    }

    #[test]
    fn regex_mode_matches_pattern() {
        let dir = temp_dir("regex");
        std::fs::write(dir.join("a.txt"), "foo123\nbar\nfoo9\n").unwrap();

        let report = search(&dir, r"foo\d+", true, true, &[], 10, 100);

        assert_eq!(report.total_matches, 2);
        assert_eq!(report.files[0].matches[0].line, 1);
        assert_eq!(report.files[0].matches[1].line, 3);
    }

    #[test]
    fn ignore_dirs_are_skipped() {
        let dir = temp_dir("ignore");
        std::fs::write(dir.join("a.txt"), "needle\n").unwrap();
        std::fs::create_dir_all(dir.join("skip")).unwrap();
        std::fs::write(dir.join("skip").join("b.txt"), "needle\n").unwrap();

        let report = search(&dir, "needle", true, false, &["skip"], 10, 100);

        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].relative, "a.txt");
    }

    #[test]
    fn binary_files_are_skipped() {
        let dir = temp_dir("binary");
        // 前 8KB 含 NUL → 判定为二进制，即使文本片段命中也不返回
        std::fs::write(dir.join("b.bin"), b"needle\0needle").unwrap();

        let report = search(&dir, "needle", true, false, &[], 10, 100);

        assert_eq!(report.total_matches, 0);
        assert!(report.files.is_empty());
    }

    #[test]
    fn max_matches_truncates_report() {
        let dir = temp_dir("limit");
        std::fs::write(dir.join("a.txt"), "x\nx\nx\n").unwrap();

        let report = search(&dir, "x", true, false, &[], 10, 2);

        assert_eq!(report.total_matches, 2);
        assert!(report.truncated);
    }

    #[test]
    fn empty_query_returns_empty_report() {
        let dir = temp_dir("empty");
        std::fs::write(dir.join("a.txt"), "anything\n").unwrap();

        let report = search(&dir, "   ", true, false, &[], 10, 100);

        assert_eq!(report.total_matches, 0);
        assert!(report.files.is_empty());
        assert!(!report.truncated);
    }

    #[test]
    fn lists_files_respecting_ignore_and_limit() {
        let dir = temp_dir("list");
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        std::fs::write(dir.join("b.md"), "b").unwrap();
        std::fs::create_dir_all(dir.join("skip")).unwrap();
        std::fs::write(dir.join("skip").join("c.txt"), "c").unwrap();
        let ignores = vec!["skip".to_string()];

        let all = list_files_blocking(dir.to_str().unwrap(), &ignores, 10).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|f| !f.relative.contains("skip")));
        assert_eq!(all[0].relative, "a.txt");
        assert_eq!(all[1].relative, "b.md");

        let limited = list_files_blocking(dir.to_str().unwrap(), &ignores, 1).unwrap();
        assert_eq!(limited.len(), 1);
    }

    fn matcher(query: &str, case_sensitive: bool, regex: bool) -> regex::Regex {
        let pattern = if regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .build()
            .unwrap()
    }

    #[test]
    fn replaces_literal_and_reports_count() {
        let dir = temp_dir("replace_literal");
        let path = dir.join("a.txt");
        std::fs::write(&path, "foo foo\n").unwrap();

        let ok =
            replace_one(&path, &matcher("foo", true, false), "bar", false).unwrap();

        assert_eq!(ok.count, 2);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "bar bar\n");
    }

    #[test]
    fn regex_replacement_supports_capture_groups() {
        let dir = temp_dir("replace_regex");
        let path = dir.join("a.txt");
        std::fs::write(&path, "name: alice\n").unwrap();

        let ok = replace_one(
            &path,
            &matcher(r"name: (\w+)", true, true),
            "name: $1 ($1)",
            true,
        )
        .unwrap();

        assert_eq!(ok.count, 1);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "name: alice (alice)\n"
        );
    }

    #[test]
    fn literal_replacement_keeps_dollar_signs() {
        let dir = temp_dir("replace_dollar");
        let path = dir.join("a.txt");
        std::fs::write(&path, "price\n").unwrap();

        replace_one(
            &path,
            &matcher("price", true, false),
            "$1 元",
            false,
        )
        .unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "$1 元\n");
    }

    #[test]
    fn gbk_file_stays_gbk_after_replace() {
        let dir = temp_dir("replace_gbk");
        let path = dir.join("a.txt");
        // 样本足够长，保证 chardetng 稳定判为中文编码（短样本容易误判）
        let original = "这是一段较长的中文测试文本，用于确认编码检测的稳定性。foo 结尾。\n";
        std::fs::write(&path, encoding::encode(original, "GBK", false).unwrap()).unwrap();

        replace_one(&path, &matcher("foo", true, false), "bar", false).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        let decoded = encoding::decode(&bytes, "GBK").unwrap();
        assert!(decoded.contains("中文测试文本"));
        assert!(decoded.contains("bar"));
        // 回写必须仍是原始编码（GBK 字节不是合法 UTF-8）
        assert!(std::str::from_utf8(&bytes).is_err());
    }

    #[test]
    fn repeated_replace_succeeds_without_backup_files() {
        let dir = temp_dir("replace_twice");
        let path = dir.join("a.txt");
        std::fs::write(&path, "foo\n").unwrap();

        replace_one(&path, &matcher("foo", true, false), "bar", false).unwrap();
        replace_one(&path, &matcher("bar", true, false), "baz", false).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "baz\n");
        // 不再生成源目录备份：同一文件可反复替换
        assert!(!dir.join("a.txt.bak").exists());
    }

    #[test]
    fn skips_when_no_match_or_binary() {
        let dir = temp_dir("replace_skip");
        let text = dir.join("a.txt");
        std::fs::write(&text, "abc\n").unwrap();
        assert!(replace_one(&text, &matcher("zzz", true, false), "x", false).is_err());

        let bin = dir.join("b.bin");
        std::fs::write(&bin, b"foo\0bar").unwrap();
        let err = replace_one(&bin, &matcher("foo", true, false), "x", false).unwrap_err();
        assert!(err.contains("二进制"));
    }

    #[test]
    fn backup_files_are_not_replaced() {
        let dir = temp_dir("replace_backup_target");
        let path = dir.join("a.txt.bak");
        std::fs::write(&path, "foo\n").unwrap();

        let raw = path.to_string_lossy().to_string();
        let report = replace_blocking(
            &dir,
            "foo",
            "bar",
            true,
            false,
            false,
            &[(raw, path)],
            &crate::commands::watch::WatchState::default(),
            None,
            "",
        )
        .unwrap();

        assert_eq!(report.replaced_files, 0);
        assert_eq!(
            report.files[0].skipped_reason,
            "备份/临时文件不参与替换"
        );
        // 备份内容必须原样保留
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt.bak")).unwrap(),
            "foo\n"
        );
    }

    #[test]
    fn preview_splits_hit_and_windows_long_lines() {
        // 短行：三段精确切分
        let (b, h, a) = split_match_preview("world hello", 6, 11);
        assert_eq!((b.as_str(), h.as_str(), a.as_str()), ("world ", "hello", ""));

        // 长行（命中在末尾）：窗口向前开，前段以省略号开头，后段为空
        let line = format!("{}NEEDLE", "x".repeat(300));
        let (b, h, a) = split_match_preview(&line, 300, 306);
        assert_eq!(h, "NEEDLE");
        assert!(b.starts_with('…'), "长行前段应有省略号");
        assert!(a.is_empty());

        // 中文：字节偏移必须映射到字符边界（不 panic、命中完整）
        let (b, h, a) = split_match_preview("前缀中文命中后缀", 6, 18);
        assert_eq!(h, "中文命中");
        assert_eq!(b, "前缀");
        assert_eq!(a, "后缀");
    }

    #[test]
    fn replace_report_counts_files_and_matches() {
        let dir = temp_dir("replace_report");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, "x\nx\n").unwrap();
        std::fs::write(&b, "x\n").unwrap();

        let report = replace_blocking(
            &dir,
            "x",
            "y",
            true,
            false,
            false,
            &[
                (a.to_string_lossy().to_string(), a),
                (b.to_string_lossy().to_string(), b),
            ],
            &crate::commands::watch::WatchState::default(),
            None,
            "",
        )
        .unwrap();

        assert_eq!(report.replaced_files, 2);
        assert_eq!(report.replaced_matches, 3);
        assert!(report.history_id.is_empty());
        assert!(report.files.iter().all(|f| f.skipped_reason.is_empty()));
    }

    #[test]
    fn history_snapshot_supports_undo() {
        let dir = temp_dir("history_src");
        let store = temp_dir("history_store");
        let file = dir.join("a.txt");
        std::fs::write(&file, "foo\n").unwrap();

        let report = replace_blocking(
            &dir,
            "foo",
            "bar",
            true,
            false,
            false,
            &[(file.to_string_lossy().to_string(), file.clone())],
            &crate::commands::watch::WatchState::default(),
            Some(&store),
            "h1",
        )
        .unwrap();

        assert_eq!(report.replaced_files, 1);
        assert_eq!(report.history_id, "h1");
        let manifest: HistoryManifest = serde_json::from_str(
            &std::fs::read_to_string(store.join("manifest.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].relative, "a.txt");
        // 快照是替换前内容；原文件已是替换后内容
        let snapshot = std::fs::read(store.join(&manifest.files[0].backup)).unwrap();
        assert_eq!(snapshot, b"foo\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "bar\n");
        // 快照写回即可还原
        std::fs::write(&file, &snapshot).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "foo\n");
    }
}
