//! 批量另存为编码：把选中的文本文件按目标编码另存为新副本。
//! 非破坏式——只写入输出目录，绝不覆盖原文件；同名目标已存在时跳过并报错。
//! 源编码逐文件探测（与打开文件同一套检测），换行符可保持原样或统一指定。

use serde::Serialize;
use std::path::{Path, PathBuf};

use super::encoding;
use super::file::{apply_eol, atomic_write, detect_newline};
use super::paths::PathGuard;

/// 源文件是否带 UTF-8 BOM（转存为 UTF-8 时沿用）
fn has_utf8_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xEF, 0xBB, 0xBF])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub written: Vec<String>,
    pub failures: Vec<BatchFailure>,
}

/// 批量另存为指定编码
/// - newline："KEEP"（保持各文件原有风格）| "LF" | "CRLF" | "CR"
/// - out_dir：输出目录（与原文件同路径会被拒绝）
/// 安全：输入文件与输出目录都必须在应用已知路径范围内
/// （对话框选取的路径需由前端先 register_paths 登记）。
/// 多文件读写放 spawn_blocking 执行，避免阻塞事件循环。
#[tauri::command]
pub async fn batch_save_encoding(
    state: tauri::State<'_, PathGuard>,
    files: Vec<String>,
    encoding: String,
    newline: String,
    out_dir: String,
) -> Result<BatchReport, String> {
    if encoding::lookup(&encoding).is_none() {
        return Err(format!("不支持的编码: {encoding}"));
    }
    // 作用域校验同步完成（快），失败直接返回
    let dir = state.ensure_file_scope(&out_dir)?;
    if !dir.is_dir() {
        return Err(format!("输出目录不存在: {}", dir.display()));
    }
    let scoped: Vec<PathBuf> = files
        .iter()
        .filter_map(|f| state.ensure_file_scope(f).ok())
        .collect();
    let failures: Vec<BatchFailure> = files
        .iter()
        .filter(|f| state.ensure_file_scope(f).is_err())
        .map(|f| BatchFailure {
            path: f.clone(),
            error: "路径不在已打开的工作区/文件范围内，已跳过".to_string(),
        })
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let mut failures = failures;
        let mut written = Vec::new();
        // 预检：先确认所有目标都可用（无同名冲突），再统一开写。
        // 原实现逐个转换，中途遇到同名文件已落盘一半，输出目录留半成品。
        let mut jobs: Vec<(PathBuf, PathBuf)> = Vec::new();
        for src in &scoped {
            let Some(name) = src.file_name() else {
                failures.push(BatchFailure {
                    path: src.to_string_lossy().to_string(),
                    error: "无法取得文件名".to_string(),
                });
                continue;
            };
            let target = dir.join(name);
            if same_path(src, &target) {
                failures.push(BatchFailure {
                    path: src.to_string_lossy().to_string(),
                    error: "输出路径与原文件相同，请选择其它输出目录".to_string(),
                });
                continue;
            }
            if target.exists() {
                failures.push(BatchFailure {
                    path: src.to_string_lossy().to_string(),
                    error: format!("输出目录中已存在同名文件: {}", target.display()),
                });
                continue;
            }
            jobs.push((src.clone(), target));
        }
        for (src, target) in jobs {
            match convert_prechecked(&src, &target, &encoding, &newline) {
                Ok(path) => written.push(path),
                Err(error) => failures.push(BatchFailure {
                    path: src.to_string_lossy().to_string(),
                    error,
                }),
            }
        }
        Ok(BatchReport { written, failures })
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

/// 单文件转换：读源 → 按探测编码解码 → 套用换行风格 → 按目标编码写入输出目录
/// （目标路径已由调用方预检过）
fn convert_prechecked(
    source: &Path,
    target: &Path,
    encoding_name: &str,
    newline: &str,
) -> Result<String, String> {
    let bytes = std::fs::read(source).map_err(|e| format!("读取失败: {e}"))?;

    let guess = encoding::guess(&bytes);
    let text = encoding::decode(&bytes, &guess.encoding)
        .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).into_owned());
    let eol = if newline == "KEEP" {
        detect_newline(&text).to_string()
    } else {
        newline.to_string()
    };
    let converted = apply_eol(&text, &eol);
    let out = encoding::encode(&converted, encoding_name, has_utf8_bom(&bytes))?;
    atomic_write(target, &out)?;
    Ok(target.to_string_lossy().to_string())
}

/// 单文件转换（含目标预检）：供测试与单独调用使用
#[cfg(test)]
fn convert_one(
    source: &Path,
    out_dir: &Path,
    encoding_name: &str,
    newline: &str,
) -> Result<String, String> {
    let name = source
        .file_name()
        .ok_or_else(|| "无法取得文件名".to_string())?;
    let target = out_dir.join(name);
    if same_path(source, &target) {
        return Err("输出路径与原文件相同，请选择其它输出目录".to_string());
    }
    if target.exists() {
        return Err(format!("输出目录中已存在同名文件: {}", target.display()));
    }
    convert_prechecked(source, &target, encoding_name, newline)
}

/// 路径等价判定（Windows 下大小写与分隔符不敏感）
fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("my_editor_batch_test_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn converts_gbk_source_to_utf8_copy() {
        let src_dir = temp_dir("gbk_src");
        let src = src_dir.join("a.txt");
        std::fs::write(&src, encoding::encode("中文测试", "GBK", false).unwrap()).unwrap();

        let out_dir = temp_dir("gbk_out");
        let written = convert_one(&src, &out_dir, "UTF-8", "KEEP").unwrap();

        assert_eq!(std::fs::read(&written).unwrap(), "中文测试".as_bytes());
        assert!(src.exists(), "原文件必须保留");
    }

    #[test]
    fn refuses_output_path_equal_to_source() {
        let dir = temp_dir("same");
        let src = dir.join("a.txt");
        std::fs::write(&src, b"x").unwrap();
        let err = convert_one(&src, &dir, "UTF-8", "KEEP").unwrap_err();
        assert!(err.contains("相同"));
    }

    #[test]
    fn refuses_existing_target_file() {
        let src_dir = temp_dir("exists_src");
        let src = src_dir.join("a.txt");
        std::fs::write(&src, b"x").unwrap();
        let out_dir = temp_dir("exists_out");
        std::fs::write(out_dir.join("a.txt"), b"old").unwrap();

        let err = convert_one(&src, &out_dir, "UTF-8", "KEEP").unwrap_err();
        assert!(err.contains("已存在"));
    }

    #[test]
    fn keeps_or_forces_line_endings() {
        let src_dir = temp_dir("eol_src");
        let src = src_dir.join("a.txt");
        std::fs::write(&src, b"a\r\nb\r\n").unwrap();
        let out_dir = temp_dir("eol_out");

        let kept = convert_one(&src, &out_dir, "UTF-8", "KEEP").unwrap();
        assert_eq!(std::fs::read(&kept).unwrap(), b"a\r\nb\r\n");
        std::fs::remove_file(&kept).unwrap();

        let forced = convert_one(&src, &out_dir, "UTF-8", "LF").unwrap();
        assert_eq!(std::fs::read(&forced).unwrap(), b"a\nb\n");
    }

    #[test]
    fn unknown_encoding_rejected() {
        let src_dir = temp_dir("bad_src");
        let src = src_dir.join("a.txt");
        std::fs::write(&src, b"x").unwrap();
        let out_dir = temp_dir("bad_out");
        assert!(convert_one(&src, &out_dir, "NO-SUCH-ENCODING", "KEEP").is_err());
    }
}
