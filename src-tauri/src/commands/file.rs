//! 文件读写命令
//! - read_file：BOM / 换行符探测 + UTF-8 宽松解码（暂不含完整编码检测链）
//! - save_file：临时文件 → fsync → 原子 rename，保留换行符与 BOM

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

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

/// BOM 探测（UTF-8 / UTF-16 LE / UTF-16 BE）
fn detect_bom(bytes: &[u8]) -> (&'static str, bool) {
    if bytes.starts_with(&UTF8_BOM) {
        ("UTF-8", true)
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        ("UTF-16 LE", true)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        ("UTF-16 BE", true)
    } else {
        ("UTF-8", false)
    }
}

/// 解码为 String：UTF-16 按端序解码，其余按 UTF-8 宽松解码
fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16(&bytes[2..], false);
    }
    let body = if bytes.starts_with(&UTF8_BOM) {
        &bytes[3..]
    } else {
        bytes
    };
    String::from_utf8_lossy(body).to_string()
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let unit = if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        };
        units.push(unit);
    }
    // 奇数长度文件的尾字节忽略
    String::from_utf16_lossy(&units)
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

/// 读取文件：探测 BOM 与换行符，按 UTF-8 宽松解码
/// 二进制文件（前 8KB 出现 NUL 字节且非 UTF-16）拒绝读取，提示不支持
fn read_file_inner(path: &str) -> Result<FileContent, String> {
    let p = PathBuf::from(path);
    let bytes = fs::read(&p).map_err(|e| format!("读取失败: {e}"))?;
    let (encoding, has_bom) = detect_bom(&bytes);
    // 二进制检测：NUL 字节启发式；UTF-16 的 NUL 属正常，豁免
    if !has_bom && bytes[..bytes.len().min(8192)].contains(&0) {
        return Err("二进制文件暂不支持查看".to_string());
    }
    let content = decode_text(&bytes);
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
        encoding: encoding.to_string(),
        newline: newline.to_string(),
        has_bom,
        readonly: false,
        readonly_reason: String::new(),
    })
}

/// 打开文本文件（大文件 / .log 只读守卫）
/// 命中「体积 ≥ large_file_threshold」或「扩展名属 log_extensions」时，
/// 仍读入内容但标记为只读，由前端以只读方式载入并禁用编辑入口。
#[tauri::command]
pub fn open_text_file(
    path: String,
    large_file_threshold: u64,
    log_extensions: Vec<String>,
) -> Result<FileContent, String> {
    let p = PathBuf::from(&path);
    let size = fs::metadata(&p).map_err(|e| format!("读取失败: {e}"))?.len();

    // 扩展名归一化为「.xxx」小写后比对，兼容配置里带/不带点号的写法
    let ext = p
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let is_log = log_extensions.iter().any(|e| {
        let e = e.to_ascii_lowercase();
        let normalized = if e.starts_with('.') { e } else { format!(".{e}") };
        !normalized.is_empty() && normalized == ext
    });

    let mut content = read_file_inner(&path)?;
    if size >= large_file_threshold {
        content.readonly = true;
        content.readonly_reason =
            format!("体积超过 {} MB 阈值", large_file_threshold / 1024 / 1024);
    } else if is_log {
        content.readonly = true;
        content.readonly_reason = "日志文件（.log）默认只读".to_string();
    }
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

/// 保存文件：按目标换行符统一改写，保留 BOM，走原子替换
#[tauri::command]
pub fn save_file(
    path: String,
    content: String,
    newline: String,
    has_bom: bool,
) -> Result<SaveResult, String> {
    let target = PathBuf::from(&path);

    // 先把既有换行统一为 \n，再按目标格式改写（避免 \r\n 被当作两个字符）
    let text = content.replace("\r\n", "\n");
    let text = match newline.as_str() {
        "CRLF" => text.replace('\n', "\r\n"),
        "CR" => text.replace('\n', "\r"),
        _ => text, // LF / NONE
    };

    let mut bytes = text.into_bytes();
    if has_bom {
        let mut with_bom = Vec::with_capacity(bytes.len() + UTF8_BOM.len());
        with_bom.extend_from_slice(&UTF8_BOM);
        with_bom.append(&mut bytes);
        bytes = with_bom;
    }

    let size = atomic_write(&target, &bytes)?;
    Ok(SaveResult { path, size })
}
