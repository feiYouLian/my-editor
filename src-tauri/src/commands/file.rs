//! 文件读写命令
//! - read_file：三段式编码检测（BOM → UTF-8 → chardetng）+ 换行符探测
//! - save_file：临时文件 → fsync → 原子 rename，保留换行符与 BOM

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::commands::encoding;

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Serialize)]
pub struct FileContent {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub content: String,
    pub encoding: String,
    pub newline: String,
    pub has_bom: bool,
    /// 编码置信度："bom" | "high" | "low" | "user"
    pub encoding_confidence: String,
    /// 候选编码（状态栏「重新打开为」菜单）
    pub encoding_candidates: Vec<String>,
    /// 是否只读：命中大文件阈值或日志扩展名时为 true
    pub readonly: bool,
    /// 只读原因（供前端提示；非只读时为空串）
    pub readonly_reason: String,
}

#[derive(Serialize)]
pub struct SaveResult {
    pub path: String,
    pub size: u64,
}

/// 是否存在 BOM（UTF-8 / UTF-16 LE / UTF-16 BE）
fn has_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&UTF8_BOM)
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
}

/// 主导换行符判定：分别统计 CRLF / LF / CR，取占比最高者
fn detect_newline(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf; // 纯 LF
    let cr = text.matches('\r').count() - crlf; // 纯 CR
    let max = crlf.max(lf).max(cr);
    if max == 0 {
        "NONE"
    } else if max == crlf {
        "CRLF"
    } else if max == cr {
        "CR"
    } else {
        "LF"
    }
}

/// 读取文件：编码检测（或按指定编码）+ 换行符探测
/// 二进制文件（前 8KB 出现 NUL 字节且无 BOM）拒绝读取，提示不支持
fn read_with_encoding(path: &str, forced: Option<&str>) -> Result<FileContent, String> {
    let p = PathBuf::from(path);
    let bytes = fs::read(&p).map_err(|e| format!("读取失败: {e}"))?;
    let bom = has_bom(&bytes);
    // 二进制检测：NUL 字节启发式；带 BOM 的 UTF-16 其 NUL 属正常，豁免
    if !bom && bytes[..bytes.len().min(8192)].contains(&0) {
        return Err("二进制文件暂不支持查看".to_string());
    }

    let (encoding, confidence, candidates) = match forced {
        Some(name) => (
            name.to_string(),
            "user".to_string(),
            encoding::CANDIDATES.iter().map(|s| (*s).to_string()).collect(),
        ),
        None => {
            let g = encoding::guess(&bytes);
            (g.encoding, g.confidence, g.candidates)
        }
    };
    let content = encoding::decode(&bytes, &encoding)?;
    let newline = detect_newline(&content);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(FileContent {
        path: path.to_string(),
        name,
        size: bytes.len() as u64,
        content,
        encoding,
        encoding_confidence: confidence,
        encoding_candidates: candidates,
        newline: newline.to_string(),
        has_bom: bom,
        readonly: false,
        readonly_reason: String::new(),
    })
}

/// 大文件 / .log 只读守卫：命中时标记只读，由前端禁用编辑入口
fn apply_readonly_guard(
    content: &mut FileContent,
    path: &Path,
    large_file_threshold: u64,
    log_extensions: &[String],
) {
    let Ok(meta) = fs::metadata(path) else { return };
    // 扩展名归一化为「.xxx」小写后比对，兼容配置里带/不带点号的写法
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let is_log = log_extensions.iter().any(|e| {
        let normalized = {
            let lower = e.to_ascii_lowercase();
            if lower.starts_with('.') { lower } else { format!(".{lower}") }
        };
        !normalized.is_empty() && normalized == ext
    });

    if meta.len() >= large_file_threshold {
        content.readonly = true;
        content.readonly_reason =
            format!("体积超过 {} MB 阈值", large_file_threshold / 1024 / 1024);
    } else if is_log {
        content.readonly = true;
        content.readonly_reason = "日志文件（.log）默认只读".to_string();
    }
}

/// 打开文本文件：自动检测编码 + 大文件 / .log 只读守卫
#[tauri::command]
pub fn open_text_file(
    path: String,
    large_file_threshold: u64,
    log_extensions: Vec<String>,
) -> Result<FileContent, String> {
    let mut content = read_with_encoding(&path, None)?;
    apply_readonly_guard(
        &mut content,
        Path::new(&path),
        large_file_threshold,
        &log_extensions,
    );
    Ok(content)
}

/// 「重新打开为」：按指定编码重新解读磁盘字节（不写盘），并重算只读守卫
#[tauri::command]
pub fn reopen_with_encoding(
    path: String,
    encoding: String,
    large_file_threshold: u64,
    log_extensions: Vec<String>,
) -> Result<FileContent, String> {
    let mut content = read_with_encoding(&path, Some(&encoding))?;
    apply_readonly_guard(
        &mut content,
        Path::new(&path),
        large_file_threshold,
        &log_extensions,
    );
    Ok(content)
}

/// 图片文件读取：返回 data URL（前端 <img> 直接展示）
#[derive(Serialize)]
pub struct ImageFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub data_url: String,
}

fn mime_for_ext(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

#[tauri::command]
pub fn read_image_file(path: String) -> Result<ImageFile, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| format!("读取失败: {e}"))?;
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mime = mime_for_ext(&ext)
        .ok_or_else(|| format!("不支持的图片格式: .{ext}"))?;
    let data_url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(ImageFile {
        path,
        name,
        size: bytes.len() as u64,
        mime: mime.to_string(),
        data_url,
    })
}

/// 原子写入：同目录临时文件 → fsync → rename
/// rename 失败重试 1 次（应对杀毒软件等短暂占用）
fn atomic_write(target: &PathBuf, bytes: &[u8]) -> Result<u64, String> {
    let dir = target
        .parent()
        .ok_or_else(|| "无法确定目标目录".to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "无法确定文件名".to_string())?;
    let tmp_path = dir.join(format!(".{}.tmp", file_name.to_string_lossy()));

    {
        let mut file =
            fs::File::create(&tmp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("写入临时文件失败: {e}（可能磁盘空间不足）"))?;
        file.sync_all().map_err(|e| format!("同步临时文件失败: {e}"))?;
    }

    let mut last_err = String::new();
    for _ in 0..2 {
        match fs::rename(&tmp_path, target) {
            Ok(()) => return Ok(bytes.len() as u64),
            Err(e) => last_err = e.to_string(),
        }
    }
    let _ = fs::remove_file(&tmp_path);
    Err(format!(
        "替换原文件失败: {last_err}（目标可能被其他程序占用）"
    ))
}

/// 保存文件：按目标编码与换行符改写，保留 BOM，走原子替换
#[tauri::command]
pub fn save_file(
    path: String,
    content: String,
    newline: String,
    has_bom: bool,
    encoding: String,
) -> Result<SaveResult, String> {
    let target = PathBuf::from(&path);

    // 先把既有换行统一为 \n，再按目标格式改写（避免 \r\n 被当作两个字符）
    let text = content.replace("\r\n", "\n");
    let text = match newline.as_str() {
        "CRLF" => text.replace('\n', "\r\n"),
        "CR" => text.replace('\n', "\r"),
        _ => text, // LF / NONE
    };

    let bytes = encoding::encode(&text, &encoding, has_bom)?;
    let size = atomic_write(&target, &bytes)?;
    Ok(SaveResult { path, size })
}
