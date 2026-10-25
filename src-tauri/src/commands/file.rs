//! 文件读写命令
//! - read_file：三段式编码检测（BOM → UTF-8 → chardetng）+ 换行符探测
//! - save_file：临时文件 → fsync → 原子 rename，保留换行符与 BOM

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::commands::encoding;
use crate::commands::paths::PathGuard;

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
pub(crate) fn detect_newline(text: &str) -> &'static str {
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

/// 统一换行符为 LF（\r\n / \r → \n）。
/// 编辑器内核按 \n 存储行；若原样保留 \r\n，编辑器内容与基线永远不相等，
/// 会出现「撤销回原状仍显示未保存」。原始风格由 newline 字段承载，保存时还原。
fn normalize_eol(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
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
    let raw = encoding::decode(&bytes, &encoding)?;
    // 换行符风格取自原始文本，内容统一为 LF（见 normalize_eol）
    let newline = detect_newline(&raw);
    let content = normalize_eol(&raw);
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

/// 打开文本文件：自动检测编码 + 大文件 / .log 只读守卫。
/// 读取后自动登记该路径，供后续保存 / 运行 / 导出等操作通过作用域校验。
/// 整文件读取放 spawn_blocking 执行，避免大文件阻塞事件循环。
#[tauri::command]
pub async fn open_text_file(
    state: tauri::State<'_, PathGuard>,
    path: String,
    large_file_threshold: u64,
    log_extensions: Vec<String>,
) -> Result<FileContent, String> {
    state.add_path(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let mut content = read_with_encoding(&path, None)?;
        apply_readonly_guard(
            &mut content,
            Path::new(&path),
            large_file_threshold,
            &log_extensions,
        );
        Ok(content)
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

/// 「重新打开为」：按指定编码重新解读磁盘字节（不写盘），并重算只读守卫
#[tauri::command]
pub async fn reopen_with_encoding(
    state: tauri::State<'_, PathGuard>,
    path: String,
    encoding: String,
    large_file_threshold: u64,
    log_extensions: Vec<String>,
) -> Result<FileContent, String> {
    state.add_path(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let mut content = read_with_encoding(&path, Some(&encoding))?;
        apply_readonly_guard(
            &mut content,
            Path::new(&path),
            large_file_threshold,
            &log_extensions,
        );
        Ok(content)
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
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

/// 图片读取的体积上限：防止超大图被整读后 base64 放大 ~4/3 撑爆内存。
/// 前端预览 / 导出另有 4MB / 10MB 预算，这里是后端的最后一道防线。
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

#[tauri::command]
pub async fn read_image_file(
    state: tauri::State<'_, PathGuard>,
    path: String,
) -> Result<ImageFile, String> {
    state.add_path(&path);
    tauri::async_runtime::spawn_blocking(move || {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let p = PathBuf::from(&path);
        let meta = fs::metadata(&p).map_err(|e| format!("读取文件信息失败: {e}"))?;
        if meta.len() > MAX_IMAGE_BYTES {
            return Err(format!(
                "图片体积超过 {} MB，已拒绝处理",
                MAX_IMAGE_BYTES / 1024 / 1024
            ));
        }
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
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

/// 原子写入：同目录临时文件 → fsync → rename
/// rename 失败重试 1 次（应对杀毒软件等短暂占用）
pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<u64, String> {
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

/// 文件字节数与扩展名：供打开前判断走编辑器还是只读虚拟视图
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProbe {
    pub size: u64,
    pub extension: String,
}

#[tauri::command]
pub fn probe_file(state: tauri::State<'_, PathGuard>, path: String) -> Result<FileProbe, String> {
    state.add_path(&path);
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("读取文件信息失败: {e}"))?;
    let extension = p
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    Ok(FileProbe {
        size: meta.len(),
        extension,
    })
}

/// 按目标风格改写换行符（先把内容统一为 \n，避免 \r\n 被当作两个字符）
pub(crate) fn apply_eol(text: &str, newline: &str) -> String {
    let unified = normalize_eol(text);
    match newline {
        "CRLF" => unified.replace('\n', "\r\n"),
        "CR" => unified.replace('\n', "\r"),
        _ => unified, // LF / NONE
    }
}

/// 保存文件：按目标编码与换行符改写，保留 BOM，走原子替换。
/// 保存成功后登记该路径（后续同目录写入 / 导出素材等操作由此获得作用域）。
/// 全文编码 + fsync 可能耗时（大文件 / 杀毒扫描）：放 spawn_blocking，避免卡主线程。
#[tauri::command]
pub async fn save_file(
    watch: tauri::State<'_, crate::commands::watch::WatchState>,
    guard: tauri::State<'_, PathGuard>,
    path: String,
    content: String,
    newline: String,
    has_bom: bool,
    encoding: String,
) -> Result<SaveResult, String> {
    let target = PathBuf::from(&path);
    // 自身写盘：写前先开静默窗口、写后刷新指纹，避免 notify 把本次保存误判为外部修改
    crate::commands::watch::mark_writing(&watch, &target);
    // 路径登记（轻量、幂等）放外层：闭包内不再借用 State
    guard.add_path(&path);
    let watch_state = (*watch).clone();
    let target_bg = target.clone();
    let written = tauri::async_runtime::spawn_blocking(move || {
        let text = apply_eol(&content, &newline);
        let bytes = encoding::encode(&text, &encoding, has_bom)?;
        atomic_write(&target_bg, &bytes)
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?;
    // 无论成败都要结束「正在写」标记，否则失败后该文件的外部修改会被永久吞掉
    crate::commands::watch::note_written(&watch_state, &target);
    let size = written?;
    Ok(SaveResult { path, size })
}

/// 写入二进制文件（内容为 base64），自动创建父目录；返回写入字节数。
/// 供「插入剪贴板图片」等需要落盘二进制的场景使用。
/// 安全：目标必须位于应用已知路径范围内（已打开/保存文件的同目录等）；
/// 解码 + 写盘放 spawn_blocking；作用域校验先于解码，避免未授权路径也触发大内存分配。
#[tauri::command]
pub async fn write_binary_file(
    state: tauri::State<'_, PathGuard>,
    path: String,
    base64_data: String,
) -> Result<u64, String> {
    let target = state.ensure_file_scope(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        let bytes = STANDARD
            .decode(base64_data.as_bytes())
            .map_err(|e| format!("base64 解码失败: {e}"))?;
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
        }
        atomic_write(&target, &bytes)
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_read_normalizes_content_but_keeps_style() {
        assert_eq!(detect_newline("a\r\nb\r\n"), "CRLF");
        assert_eq!(normalize_eol("a\r\nb\r\n"), "a\nb\n");
    }

    #[test]
    fn lone_cr_read_normalizes_content_but_keeps_style() {
        assert_eq!(detect_newline("a\rb\r"), "CR");
        assert_eq!(normalize_eol("a\rb\r"), "a\nb\n");
    }

    #[test]
    fn lf_and_single_line_texts_pass_through() {
        assert_eq!(normalize_eol("a\nb\n"), "a\nb\n");
        assert_eq!(detect_newline("a\nb\n"), "LF");
        assert_eq!(detect_newline("no line break"), "NONE");
    }

    #[test]
    fn mixed_endings_take_majority_style() {
        assert_eq!(detect_newline("a\r\nb\r\nc\n"), "CRLF");
    }

    #[test]
    fn save_restores_the_original_style() {
        // 读入（CRLF → LF）后再保存（LF → CRLF）应还原原始字节风格
        assert_eq!(apply_eol(&normalize_eol("a\r\nb\r\n"), "CRLF"), "a\r\nb\r\n");
        assert_eq!(apply_eol("a\nb\n", "LF"), "a\nb\n");
        assert_eq!(apply_eol("a\nb\n", "CR"), "a\rb\r");
        assert_eq!(apply_eol("a\nb\n", "NONE"), "a\nb\n");
    }
}
