//! TODO 列表扫描。
//! 按关键字扫描工作区文本文件（默认 TODO / FIXME / XXX / HACK），
//! 与全局搜索一致地走 ignore（尊重 .gitignore），跳过二进制与超大文件。

use ignore::{WalkBuilder, WalkState};
use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 默认关键字（前端未传时使用）
pub const DEFAULT_KEYWORDS: [&str; 4] = ["TODO", "FIXME", "XXX", "HACK"];
/// 单行文本展示上限
const MAX_LINE_CHARS: usize = 200;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TodoHit {
    pub path: String,
    pub name: String,
    /// 行号（1 基）
    pub line: usize,
    /// 命中的关键字（统一大写）
    pub kind: String,
    /// 行内容（去掉关键字前的注释前缀，超长截断）
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoOutcome {
    pub items: Vec<TodoHit>,
    pub files_scanned: usize,
    pub truncated: bool,
}

/// 关键字 → 匹配正则：按字面转义并按词边界匹配，忽略大小写
fn build_regex(keywords: &[String]) -> Result<Regex, String> {
    let keys: Vec<String> = if keywords.is_empty() {
        DEFAULT_KEYWORDS.iter().map(|s| (*s).to_string()).collect()
    } else {
        keywords
            .iter()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .collect()
    };
    if keys.is_empty() {
        return Err("关键字不能为空".to_string());
    }
    let alternation = keys
        .iter()
        .map(|k| regex::escape(k))
        .collect::<Vec<_>>()
        .join("|");
    Regex::new(&format!(r"(?i)\b({alternation})\b")).map_err(|e| format!("关键字无效: {e}"))
}

/// 行内容裁剪：去掉关键字之前的注释符号与前导空白，超长截断。
/// start 为关键字在行内的字节偏移（由正则匹配给出，大小写无关）；
/// 不含 ';'，避免把语句结束符一并吃掉。
fn clamp_text(line: &str, start: usize) -> String {
    let head = line[..start].trim_end_matches([' ', '/', '*', '#', '<', '!', '-']);
    let body = line[start..].trim();
    let text = if head.is_empty() {
        body.to_string()
    } else {
        format!("{head} · {body}")
    };
    if text.chars().count() <= MAX_LINE_CHARS {
        text
    } else {
        let cut: String = text.chars().take(MAX_LINE_CHARS).collect();
        format!("{cut}…")
    }
}

#[tauri::command]
pub fn scan_todos(
    root: String,
    keywords: Vec<String>,
    max_file_bytes: u64,
    max_results: usize,
) -> Result<TodoOutcome, String> {
    let re = build_regex(&keywords)?;
    let items = Arc::new(Mutex::new(Vec::<TodoHit>::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    WalkBuilder::new(Path::new(&root)).build_parallel().run({
        let items = Arc::clone(&items);
        let scanned = Arc::clone(&scanned);
        let truncated = Arc::clone(&truncated);
        let re = re.clone();
        move || {
            let items = Arc::clone(&items);
            let scanned = Arc::clone(&scanned);
            let truncated = Arc::clone(&truncated);
            let re = re.clone();
            Box::new(move |entry| {
                if truncated.load(Ordering::Relaxed) {
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
                let Ok(bytes) = std::fs::read(path) else {
                    return WalkState::Continue;
                };
                // 二进制启发式：前 8KB 出现 NUL 字节则跳过
                if bytes[..bytes.len().min(8192)].contains(&0) {
                    return WalkState::Continue;
                }
                scanned.fetch_add(1, Ordering::Relaxed);
                let text = String::from_utf8_lossy(&bytes);
                let name = path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let path_str = path.to_string_lossy().to_string();

                let mut found = Vec::new();
                for (idx, line) in text.lines().enumerate() {
                    let Some(caps) = re.captures(line) else {
                        continue;
                    };
                    let Some(m) = caps.get(1) else {
                        continue;
                    };
                    found.push(TodoHit {
                        path: path_str.clone(),
                        name: name.clone(),
                        line: idx + 1,
                        kind: m.as_str().to_uppercase(),
                        text: clamp_text(line, m.start()),
                    });
                }

                if found.is_empty() {
                    return WalkState::Continue;
                }
                let mut guard = items.lock().unwrap_or_else(|e| e.into_inner());
                for hit in found {
                    if guard.len() >= max_results {
                        truncated.store(true, Ordering::Relaxed);
                        break;
                    }
                    guard.push(hit);
                }
                if truncated.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                WalkState::Continue
            })
        }
    });

    let mut out = items.lock().unwrap_or_else(|e| e.into_inner()).clone();
    // 遍历顺序由并行决定，按路径 + 行号排序保证稳定展示
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(TodoOutcome {
        items: out,
        files_scanned: scanned.load(Ordering::Relaxed),
        truncated: truncated.load(Ordering::Relaxed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regex_matches_keywords_at_word_boundary() {
        let re = build_regex(&[]).unwrap();
        assert!(re.is_match("// TODO: 补充测试"));
        assert!(re.is_match("/* FIXME 这里有问题 */"));
        assert!(!re.is_match("case hacker: break;")); // 词边界：HACK 不命中 hacker
        assert!(!re.is_match("print('todos')"));
    }

    #[test]
    fn unusable_keyword_sets_are_rejected() {
        assert!(build_regex(&["".to_string(), "  ".to_string()]).is_err());
    }

    #[test]
    fn custom_keywords_are_literal_and_case_insensitive() {
        let re = build_regex(&["待办".to_string(), "NOTE".to_string()]).unwrap();
        assert!(re.is_match("// 待办 明天处理"));
        assert!(re.is_match("note: 记得回来"));
    }

    #[test]
    fn clamp_text_strips_comment_prefix_and_truncates() {
        assert_eq!(clamp_text("// TODO: 补充测试", 3), "TODO: 补充测试");
        assert_eq!(clamp_text("    // todo: 补充测试", 7), "todo: 补充测试");
        // 关键字前有非注释内容时保留，用 · 连接（"let x = 1; // TODO 待处理" 中 TODO 位于第 14 字节）
        assert_eq!(clamp_text("let x = 1; // TODO 待处理", 14), "let x = 1; · TODO 待处理");

        let long = format!("// TODO {}", "x".repeat(500));
        let out = clamp_text(&long, 3);
        assert_eq!(out.chars().count(), MAX_LINE_CHARS + 1);
        assert!(out.ends_with('…'));
    }
}
