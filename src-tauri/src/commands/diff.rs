//! 文本差异比较：双栏对齐行 + 差异块索引 + 统一 diff 补丁

use serde::Serialize;
use similar::{ChangeTag, TextDiff};

use super::encoding;

/// 对齐后的双栏行；kind = equal / change / del / ins
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub kind: String,
    pub old_no: Option<usize>,
    pub new_no: Option<usize>,
    pub left: String,
    pub right: String,
}

/// 差异块在 rows 中的定位（供「上一处 / 下一处」导航）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkRef {
    pub row: usize,
    pub old_start: usize,
    pub new_start: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub left_label: String,
    pub right_label: String,
    pub rows: Vec<DiffRow>,
    pub hunks: Vec<HunkRef>,
    pub added: usize,
    pub removed: usize,
    pub identical: bool,
    /// 是否因行尾差异（CRLF / LF）做过归一化；为 true 时行尾差异不计入结果
    pub newline_normalized: bool,
    /// 统一 diff 文本（含 --- / +++ 头），用于导出 .patch
    pub patch: String,
}

fn strip_eol(s: &str) -> String {
    s.trim_end_matches(['\n', '\r']).to_string()
}

/// 把待配对的删除 / 新增按行对齐成同一视觉行；多余的一侧单独成行
fn flush_pending(
    rows: &mut Vec<DiffRow>,
    hunks: &mut Vec<HunkRef>,
    dels: &mut Vec<(usize, String)>,
    inss: &mut Vec<(usize, String)>,
) {
    if dels.is_empty() && inss.is_empty() {
        return;
    }
    let start = rows.len();
    let total = dels.len().max(inss.len());
    for i in 0..total {
        let row = match (dels.get(i), inss.get(i)) {
            (Some((no, t)), Some((nno, u))) => DiffRow {
                kind: "change".into(),
                old_no: Some(*no),
                new_no: Some(*nno),
                left: t.clone(),
                right: u.clone(),
            },
            (Some((no, t)), None) => DiffRow {
                kind: "del".into(),
                old_no: Some(*no),
                new_no: None,
                left: t.clone(),
                right: String::new(),
            },
            (None, Some((nno, u))) => DiffRow {
                kind: "ins".into(),
                old_no: None,
                new_no: Some(*nno),
                left: String::new(),
                right: u.clone(),
            },
            (None, None) => break,
        };
        rows.push(row);
    }
    let (old_start, new_start) = rows
        .get(start)
        .map(|r| (r.old_no.unwrap_or(0), r.new_no.unwrap_or(0)))
        .unwrap_or((0, 0));
    hunks.push(HunkRef {
        row: start,
        old_start,
        new_start,
    });
    dels.clear();
    inss.clear();
}

/// 归一化：CRLF / CR → LF，并保证文本以单个换行结尾。
/// 编辑器内部一律使用 LF；不归一化时 CRLF 文件与编辑内容会整篇被判为修改。
/// 补齐结尾换行让「最后一行缺少换行」与「有换行」等价，避免行数不同时把首行误判为修改。
/// 返回值第二项表示原文是否含 CR（供界面提示「已忽略行尾差异」）。
fn normalize(text: &str) -> (String, bool) {
    let had_cr = text.contains('\r');
    let mut unified = if had_cr {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_string()
    };
    if !unified.is_empty() && !unified.ends_with('\n') {
        unified.push('\n');
    }
    (unified, had_cr)
}

fn payload(left_label: &str, right_label: &str, left: &str, right: &str) -> DiffPayload {
    let (left_n, left_cr) = normalize(left);
    let (right_n, right_cr) = normalize(right);
    let diff = TextDiff::from_lines(&left_n, &right_n);
    let mut rows: Vec<DiffRow> = Vec::new();
    let mut hunks: Vec<HunkRef> = Vec::new();
    let (mut added, mut removed) = (0usize, 0usize);
    let mut dels: Vec<(usize, String)> = Vec::new();
    let mut inss: Vec<(usize, String)> = Vec::new();
    let (mut old_no, mut new_no) = (0usize, 0usize);

    for change in diff.iter_all_changes() {
        let text = strip_eol(change.value());
        match change.tag() {
            ChangeTag::Equal => {
                flush_pending(&mut rows, &mut hunks, &mut dels, &mut inss);
                old_no += 1;
                new_no += 1;
                rows.push(DiffRow {
                    kind: "equal".into(),
                    old_no: Some(old_no),
                    new_no: Some(new_no),
                    left: text.clone(),
                    right: text,
                });
            }
            ChangeTag::Delete => {
                old_no += 1;
                removed += 1;
                dels.push((old_no, text));
            }
            ChangeTag::Insert => {
                new_no += 1;
                added += 1;
                inss.push((new_no, text));
            }
        }
    }
    flush_pending(&mut rows, &mut hunks, &mut dels, &mut inss);

    let patch = diff
        .unified_diff()
        .context_radius(3)
        .header(left_label, right_label)
        .to_string();

    DiffPayload {
        left_label: left_label.to_string(),
        right_label: right_label.to_string(),
        identical: added == 0 && removed == 0,
        newline_normalized: left_cr || right_cr,
        rows,
        hunks,
        added,
        removed,
        patch,
    }
}

/// 比较两段文本
#[tauri::command]
pub fn diff_texts(
    left_text: String,
    right_text: String,
    left_label: String,
    right_label: String,
) -> DiffPayload {
    payload(&left_label, &right_label, &left_text, &right_text)
}

/// 读取文件并按检测到的编码解码（解码失败回退 UTF-8 宽松解码）
fn read_text(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取失败 {path}: {e}"))?;
    let guess = encoding::guess(&bytes);
    Ok(encoding::decode(&bytes, &guess.encoding)
        .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).into_owned()))
}

fn short_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// 比较两个文件
#[tauri::command]
pub fn diff_files(left_path: String, right_path: String) -> Result<DiffPayload, String> {
    let left = read_text(&left_path)?;
    let right = read_text(&right_path)?;
    Ok(payload(
        &short_name(&left_path),
        &short_name(&right_path),
        &left,
        &right,
    ))
}

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 文件所在目录是否处于 Git 仓库内
#[tauri::command]
pub fn git_available(path: String) -> bool {
    let Some(dir) = std::path::Path::new(&path).parent() else {
        return false;
    };
    git(&dir.to_string_lossy(), &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// 与 Git 比较：scope = "worktree"（HEAD vs 磁盘）| "index"（HEAD vs 暂存区）
#[tauri::command]
pub fn git_diff(path: String, scope: String) -> Result<DiffPayload, String> {
    let p = std::path::Path::new(&path);
    let dir = p
        .parent()
        .ok_or("无法确定文件所在目录")?
        .to_string_lossy()
        .to_string();
    let root = git(&dir, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let root_path = std::path::Path::new(&root)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&root));
    let rel = p
        .canonicalize()
        .map_err(|e| format!("解析文件路径失败: {e}"))?
        .strip_prefix(&root_path)
        .map_err(|_| "文件不在 Git 仓库内".to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    let old = git(&dir, &["show", &format!("HEAD:{rel}")])
        .map_err(|e| format!("无法读取 HEAD 版本：{e}"))?;
    let (new, right_label) = if scope == "index" {
        (
            git(&dir, &["show", &format!(":{rel}")])
                .map_err(|e| format!("无法读取暂存版本：{e}"))?,
            format!("暂存区 · {rel}"),
        )
    } else {
        (read_text(&path)?, format!("工作区 · {rel}"))
    };

    Ok(payload(
        &format!("HEAD · {rel}"),
        &right_label,
        &old,
        &new,
    ))
}

/// 导出统一 diff 补丁：写入 <path>.patch，返回实际写入路径
#[tauri::command]
pub fn export_patch(path: String, content: String) -> Result<String, String> {
    let target = format!("{path}.patch");
    let tmp = format!("{target}.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("替换失败: {e}"))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_unifies_eol_and_ensures_trailing_newline() {
        assert_eq!(normalize("a\r\nb\r\n"), ("a\nb\n".to_string(), true));
        assert_eq!(normalize("a\nb"), ("a\nb\n".to_string(), false));
        assert_eq!(normalize("x\ry"), ("x\ny\n".to_string(), true));
        assert_eq!(normalize("z"), ("z\n".to_string(), false));
        assert_eq!(normalize(""), (String::new(), false));
    }

    #[test]
    fn trailing_newline_presence_is_not_a_difference() {
        let p = payload("l", "r", "a\nb", "a\nb\n");
        assert!(p.identical);
    }

    #[test]
    fn identical_when_only_eol_differs() {
        let p = payload("l", "r", "a\r\nb\r\n", "a\nb\n");
        assert!(p.identical);
        assert!(p.newline_normalized);
        assert_eq!((p.added, p.removed), (0, 0));
    }

    #[test]
    fn plain_identical_text_is_identical() {
        let p = payload("l", "r", "same\ntext\n", "same\ntext\n");
        assert!(p.identical);
        assert!(!p.newline_normalized);
    }

    #[test]
    fn change_pairs_deleted_with_inserted() {
        let p = payload("l", "r", "one\ntwo\n", "one\nTWO\n");
        assert!(!p.identical);
        assert_eq!((p.added, p.removed), (1, 1));
        let change = p.rows.iter().find(|r| r.kind == "change").expect("应有 change 行");
        assert_eq!(change.left, "two");
        assert_eq!(change.right, "TWO");
        assert_eq!(p.hunks.len(), 1);
        assert_eq!(p.hunks[0].old_start, 2);
        assert_eq!(p.hunks[0].new_start, 2);
    }

    #[test]
    fn pure_insertion_and_deletion() {
        let ins = payload("l", "r", "a\n", "a\nb\nc\n");
        assert_eq!((ins.added, ins.removed), (2, 0));
        assert!(ins.rows.iter().any(|r| r.kind == "ins"));

        let del = payload("l", "r", "a\nb\nc\n", "a\n");
        assert_eq!((del.added, del.removed), (0, 2));
        assert!(del.rows.iter().any(|r| r.kind == "del"));
    }

    #[test]
    fn unchanged_lines_keep_both_line_numbers() {
        let p = payload("l", "r", "a\nb\n", "a\nb\n");
        for row in p.rows.iter().filter(|r| r.kind == "equal") {
            assert_eq!(row.old_no, row.new_no);
            assert_eq!(row.left, row.right);
        }
    }

    #[test]
    fn patch_carries_unified_header() {
        let p = payload("left.txt", "right.txt", "a\n", "b\n");
        assert!(p.patch.contains("--- left.txt"));
        assert!(p.patch.contains("+++ right.txt"));
    }
}
