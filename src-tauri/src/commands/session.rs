//! 会话与草稿持久化。
//!
//! - session.json：打开的文件列表（含光标位置）、激活文件与分栏比例
//! - drafts/：未保存内容的防抖草稿，文件名取 key 的哈希，内含原文件指纹用于过期判定
//!
//! 两者都位于 Tauri 应用配置目录；config.json 不含这两类数据。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// 草稿指纹计算内容哈希的体量上限：超过则只用 mtime + 大小判定过期，
/// 避免启动扫描时读取大文件
const HASH_MAX_BYTES: u64 = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionFile {
    pub path: String,
    /// 光标行（1 基）
    pub line: u32,
    /// 光标列（1 基）
    pub col: u32,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionState {
    pub open_files: Vec<SessionFile>,
    pub active_file: Option<String>,
    /// 分栏比例（编辑区占比，0.15 - 0.85）
    pub split_ratio: Option<f64>,
}

fn session_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("session.json"))
}

/// 读取会话（不存在/损坏则返回默认值）
#[tauri::command]
pub fn load_session(app: tauri::AppHandle) -> SessionState {
    let Ok(path) = session_file(&app) else {
        return SessionState::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => SessionState::default(),
    }
}

/// 保存会话（临时文件 + 原子替换）
#[tauri::command]
pub fn save_session(app: tauri::AppHandle, state: SessionState) -> Result<(), String> {
    let path = session_file(&app)?;
    let json = serde_json::to_string_pretty(&state).map_err(|e| format!("序列化失败: {e}"))?;
    atomic_write(&path, &json)
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

/// 写入草稿的入参（由前端提供）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInput {
    /// 稳定标识：文件路径，或未命名标签的 "untitled:<tabId>"
    pub key: String,
    /// 关联的文件路径（未命名为 None）
    pub path: Option<String>,
    pub name: String,
    pub content: String,
    pub encoding: String,
    pub newline: String,
    pub has_bom: bool,
}

/// 落盘的草稿元信息 + 内容
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
struct DraftFile {
    key: String,
    path: Option<String>,
    name: String,
    encoding: String,
    newline: String,
    has_bom: bool,
    /// 写入草稿时原文件的修改时间（秒）
    mtime: u64,
    /// 写入草稿时原文件大小（字节）
    size: u64,
    /// 写入草稿时原文件内容哈希（体量超限时为空）
    hash: String,
    /// 草稿写入时间（秒）
    saved_at: u64,
    content: String,
}

/// 返回给前端的草稿信息（不含内容，除 read_draft 外）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    key: String,
    path: Option<String>,
    name: String,
    encoding: String,
    newline: String,
    has_bom: bool,
    saved_at: u64,
    /// 原文件是否已变化（原文件不存在 / mtime / 大小 / 内容哈希不一致）
    stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

impl DraftInfo {
    fn from_file(file: DraftFile) -> Self {
        let stale = is_stale(&file);
        Self {
            key: file.key,
            path: file.path,
            name: file.name,
            encoding: file.encoding,
            newline: file.newline,
            has_bom: file.has_bom,
            saved_at: file.saved_at,
            stale,
            content: None,
        }
    }
}

fn drafts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?.join("drafts");
    fs::create_dir_all(&dir).map_err(|e| format!("创建草稿目录失败: {e}"))?;
    Ok(dir)
}

fn draft_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    Ok(drafts_dir(app)?.join(format!("{}.json", hash_hex(key.as_bytes()))))
}

/// 写入（覆盖）某标签的草稿，返回更新后的元信息
#[tauri::command]
pub fn write_draft(app: tauri::AppHandle, draft: DraftInput) -> Result<DraftInfo, String> {
    let (mtime, size, hash) = match draft.path.as_deref() {
        Some(p) => fingerprint(Path::new(p)),
        None => (0, 0, String::new()),
    };
    let file = DraftFile {
        key: draft.key.clone(),
        path: draft.path,
        name: draft.name,
        encoding: draft.encoding,
        newline: draft.newline,
        has_bom: draft.has_bom,
        mtime,
        size,
        hash,
        saved_at: now_secs(),
        content: draft.content,
    };
    let path = draft_path(&app, &draft.key)?;
    let json = serde_json::to_string(&file).map_err(|e| format!("序列化失败: {e}"))?;
    atomic_write(&path, &json)?;
    Ok(DraftInfo::from_file(file))
}

/// 列出全部草稿（含过期判定；内容不返回）
#[tauri::command]
pub fn list_drafts(app: tauri::AppHandle) -> Vec<DraftInfo> {
    let Ok(dir) = drafts_dir(&app) else {
        return Vec::new();
    };
    read_all_drafts(&dir)
        .into_iter()
        .map(DraftInfo::from_file)
        .collect()
}

/// 读取单个草稿内容（不存在返回 None）
#[tauri::command]
pub fn read_draft(app: tauri::AppHandle, key: String) -> Result<Option<DraftInfo>, String> {
    let path = draft_path(&app, &key)?;
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    let Ok(mut file) = serde_json::from_str::<DraftFile>(&text) else {
        return Ok(None);
    };
    let content = std::mem::take(&mut file.content);
    let mut info = DraftInfo::from_file(file);
    info.content = Some(content);
    Ok(Some(info))
}

/// 删除草稿（保存成功或用户丢弃后调用）
#[tauri::command]
pub fn delete_draft(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let path = draft_path(&app, &key)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除草稿失败: {e}"))?;
    }
    Ok(())
}

/// 清理超过保留天数的草稿，返回删除数量（retention_days 为 0 时不清理）
#[tauri::command]
pub fn cleanup_drafts(app: tauri::AppHandle, retention_days: u32) -> Result<u32, String> {
    if retention_days == 0 {
        return Ok(0);
    }
    let dir = drafts_dir(&app)?;
    let cutoff = now_secs().saturating_sub(retention_days as u64 * 24 * 3600);
    let mut removed = 0u32;
    for file in read_all_drafts(&dir) {
        if file.saved_at < cutoff {
            let path = dir.join(format!("{}.json", hash_hex(file.key.as_bytes())));
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir)
}

fn atomic_write(path: &Path, json: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换失败: {e}"))?;
    Ok(())
}

fn read_all_drafts(dir: &Path) -> Vec<DraftFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|text| serde_json::from_str::<DraftFile>(&text).ok())
        .collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 原文件指纹：mtime / 大小 / 内容哈希（体量超限时哈希为空）
fn fingerprint(path: &Path) -> (u64, u64, String) {
    let Ok(md) = fs::metadata(path) else {
        return (0, 0, String::new());
    };
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = md.len();
    let hash = if size <= HASH_MAX_BYTES {
        fs::read(path).map(|b| hash_hex(&b)).unwrap_or_default()
    } else {
        String::new()
    };
    (mtime, size, hash)
}

/// 原文件是否与写草稿时不一致（无关联文件时视为不过期）
fn is_stale(file: &DraftFile) -> bool {
    let Some(p) = file.path.as_deref() else {
        return false;
    };
    let (mtime, size, hash) = fingerprint(Path::new(p));
    if mtime == 0 && size == 0 {
        // 原文件已不存在
        return true;
    }
    if mtime != file.mtime || size != file.size {
        return true;
    }
    !file.hash.is_empty() && !hash.is_empty() && hash != file.hash
}

/// FNV-1a 64 位哈希（跨版本稳定，用于文件名与内容指纹）
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn hash_hex(bytes: &[u8]) -> String {
    format!("{:016x}", fnv1a(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(tag: &str, content: &[u8]) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("my_editor_session_test_{tag}.txt"));
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn hash_is_stable_64bit_hex() {
        let h = hash_hex(b"hello");
        assert_eq!(h.len(), 16);
        assert_eq!(h, hash_hex(b"hello"));
        assert_ne!(h, hash_hex(b"world"));
        // 与 FNV-1a 规范值一致（"a" → 0xaf63dc4c8601ec8c）
        assert_eq!(hash_hex(b"a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn draft_without_path_never_stale() {
        let file = DraftFile {
            key: "untitled:tab-1".into(),
            path: None,
            ..Default::default()
        };
        assert!(!is_stale(&file));
    }

    #[test]
    fn draft_with_missing_original_is_stale() {
        let file = DraftFile {
            key: "k".into(),
            path: Some("Z:/definitely/not/here/x.txt".into()),
            ..Default::default()
        };
        assert!(is_stale(&file));
    }

    #[test]
    fn fresh_draft_is_not_stale_then_goes_stale_after_edit() {
        let path = temp_file("fresh", b"hello world");
        let (mtime, size, hash) = fingerprint(&path);
        let file = DraftFile {
            key: "k".into(),
            path: Some(path.to_string_lossy().to_string()),
            mtime,
            size,
            hash,
            ..Default::default()
        };
        assert!(!is_stale(&file));

        // 原文件被改动（大小变化）→ 草稿过期
        fs::write(&path, b"hello world, changed").unwrap();
        assert!(is_stale(&file));
    }

    #[test]
    fn info_from_file_exposes_metadata_without_content() {
        let file = DraftFile {
            key: "k".into(),
            path: None,
            name: "未命名".into(),
            content: "body".into(),
            ..Default::default()
        };
        let info = DraftInfo::from_file(file);
        assert_eq!(info.key, "k");
        assert_eq!(info.name, "未命名");
        assert!(info.content.is_none());
    }

    #[test]
    fn fingerprint_of_oversized_file_skips_hash() {
        // 造一个超过 HASH_MAX_BYTES 的文件：只校验大小信号，哈希留空
        let big = vec![b'z'; (HASH_MAX_BYTES + 1) as usize];
        let path = temp_file("big", &big);
        let (_mtime, size, hash) = fingerprint(&path);
        assert_eq!(size, HASH_MAX_BYTES + 1);
        assert!(hash.is_empty());
    }
}
