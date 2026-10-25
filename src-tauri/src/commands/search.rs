//! 工作区检索：文件列表（Ctrl+P 快速打开）与内容搜索。
//!
//! 遍历统一用 `ignore` crate：尊重 .gitignore，并按配置跳过 ignoreDirs。
//! 安全边界：只读扫描（不写盘、不执行），路径来自已打开的工作区根；
//! 结果条数由上限约束，避免超大仓库把结果集与内存撑爆。

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ignore::WalkBuilder;

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
    pub preview: String,
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

fn relative_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 列出工作区文件（快速打开的数据源）。只返回文件，按相对路径排序后截断。
#[tauri::command]
pub async fn list_workspace_files(
    root: String,
    ignore_dirs: Vec<String>,
    limit: usize,
) -> Result<Vec<WorkspaceFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = PathBuf::from(&root);
        if !root_path.is_dir() {
            return Err("工作区目录不存在".to_string());
        }
        let limit = limit.max(1);
        let mut files: Vec<WorkspaceFile> = Vec::new();
        for result in walker(&root_path, &ignore_dirs) {
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
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
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
        )
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

fn search_blocking(
    root: &str,
    query: &str,
    case_sensitive: bool,
    regex: bool,
    ignore_dirs: &[String],
    max_files: usize,
    max_matches: usize,
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
            let preview: String = line.trim().chars().take(PREVIEW_CHARS).collect();
            matches.push(SearchMatch {
                line: idx as u32 + 1,
                col: col as u32,
                preview,
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
