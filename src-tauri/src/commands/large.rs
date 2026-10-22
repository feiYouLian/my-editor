//! 大文件只读虚拟视图后端
//! - 稀疏行索引：按字节间隔记录「行首偏移 + 行号」锚点，先建首屏区间、其余由后台线程补齐
//! - 按行窗口读取：定位锚点后顺扫，只读取需要的行，不把整文件载入内存
//! - 整文件过滤：返回命中的原始行号，供「过滤模式」按行号定位
//! - 缩略图行密度：由锚点推算每个桶的行数

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

use super::encoding;

/// 首屏索引区间：先扫这一段即可返回视图
const FIRST_SCAN_BYTES: u64 = 8 * 1024 * 1024;
/// 索引与过滤的单次读取块
const CHUNK: usize = 4 * 1024 * 1024;
/// 单次窗口读取的最大行数
const MAX_WINDOW_LINES: usize = 4000;
/// 过滤命中上限
const MAX_FILTER_MATCHES: usize = 50000;
/// 流式过滤单批最大命中数
const FILTER_BATCH_MAX: usize = 1000;
/// 单行展示裁剪阈值
const MAX_LINE_CHARS: usize = 4000;
/// 进度事件节流间隔
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub id: String,
    pub scanned: u64,
    pub total: u64,
    pub lines: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexReady {
    pub id: String,
    pub total_lines: usize,
    pub newline: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilterProgress {
    pub id: String,
    pub scanned: u64,
    pub total: u64,
    pub matches: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileInfo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub encoding: String,
    pub newline: String,
    pub total_lines: usize,
    pub indexed_bytes: u64,
    pub complete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineWindow {
    pub start: usize,
    pub line_nos: Vec<usize>,
    pub lines: Vec<String>,
    pub truncated_lines: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterResult {
    pub matches: Vec<usize>,
    pub truncated: bool,
    pub cancelled: bool,
    pub scanned: u64,
}

/// 流式过滤批次：命中行按批推给前端，首批到达即可先渲染
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilterBatch {
    pub id: String,
    pub request_id: u64,
    pub matches: Vec<usize>,
    pub scanned: u64,
    pub total: u64,
    pub truncated: bool,
    pub done: bool,
    pub cancelled: bool,
}

struct LargeFile {
    path: PathBuf,
    size: u64,
    encoding: String,
    newline: String,
    total_lines: usize,
    indexed_bytes: u64,
    complete: bool,
    /// (行首字节偏移, 该处行号 0-based)
    anchors: Vec<(u64, usize)>,
    /// 会话代号：同一路径二次打开时递增，后台索引线程只写回自己这一代
    session: u64,
}

/// 大文件会话注册表；Arc 以便后台索引线程共享
#[derive(Default, Clone)]
pub struct LargeState {
    files: Arc<Mutex<HashMap<String, LargeFile>>>,
    cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    /// 会话代号发生器（同一路径重复打开时区分新旧会话）
    next_session: Arc<AtomicU64>,
}

fn decode_line(bytes: &[u8], encoding_name: &str) -> String {
    let body = match bytes.last() {
        Some(b'\r') => &bytes[..bytes.len() - 1],
        _ => bytes,
    };
    encoding::decode(body, encoding_name)
        .unwrap_or_else(|_| String::from_utf8_lossy(body).into_owned())
}

fn clamp_line(text: String) -> (String, bool) {
    if text.chars().count() <= MAX_LINE_CHARS {
        return (text, false);
    }
    let head: String = text.chars().take(MAX_LINE_CHARS).collect();
    (format!("{head}…"), true)
}

/// 逐块扫描并记录锚点：锚点始终落在行首（刚跨过换行符处），因此可安全用于定位
struct Indexer {
    file: File,
    buf: Vec<u8>,
    pos: u64,
    line_no: usize,
    last_anchor: u64,
    last_byte: Option<u8>,
    crlf: u64,
    lf: u64,
    anchor_bytes: u64,
    anchors: Vec<(u64, usize)>,
}

impl Indexer {
    fn new(file: File, anchor_bytes: u64) -> Self {
        Self {
            file,
            buf: vec![0u8; CHUNK],
            pos: 0,
            line_no: 0,
            last_anchor: 0,
            last_byte: None,
            crlf: 0,
            lf: 0,
            anchor_bytes: anchor_bytes.max(4096),
            anchors: vec![(0, 0)],
        }
    }

    /// 处理下一个块；返回 false 表示已到文件末尾
    fn step(&mut self) -> Result<bool, String> {
        let n = {
            let file = &mut self.file;
            let buf = &mut self.buf;
            file.read(buf).map_err(|e| format!("读取失败: {e}"))?
        };
        if n == 0 {
            return Ok(false);
        }
        let positions: Vec<usize> = memchr::memchr_iter(b'\n', &self.buf[..n]).collect();
        for &idx in &positions {
            self.line_no += 1;
            let prev_is_cr = if idx > 0 {
                self.buf[idx - 1] == b'\r'
            } else {
                self.last_byte == Some(b'\r')
            };
            if prev_is_cr {
                self.crlf += 1;
            } else {
                self.lf += 1;
            }
            let after = self.pos + idx as u64 + 1;
            if after.saturating_sub(self.last_anchor) >= self.anchor_bytes {
                self.anchors.push((after, self.line_no));
                self.last_anchor = after;
            }
        }
        self.last_byte = self.buf[..n].last().copied();
        self.pos += n as u64;
        Ok(true)
    }

    /// 文件总行数：换行数 + 末尾无换行时的残余一行
    fn total_lines(&self) -> usize {
        self.line_no + usize::from(self.pos > 0 && self.last_byte != Some(b'\n'))
    }

    fn newline(&self) -> String {
        if self.line_no == 0 {
            "NONE".to_string()
        } else if self.crlf > self.lf {
            "CRLF".to_string()
        } else {
            "LF".to_string()
        }
    }
}

/// UTF-16 家族的换行符为双字节，字节级行扫描不成立，故虚拟视图不支持
fn is_utf16_bom(head: &[u8]) -> bool {
    matches!(head, [0xFF, 0xFE, ..] | [0xFE, 0xFF, ..])
}

fn read_head(path: &Path, len: usize) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| format!("读取失败: {e}"))?;
    let mut buf = vec![0u8; len];
    let n = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
    buf.truncate(n);
    Ok(buf)
}

/// 打开大文件：同步建首屏索引后立即返回，其余区间由后台线程补齐。
/// 读取后自动登记该路径，供后续作用域校验使用。
#[tauri::command]
pub fn open_large_file(
    app: tauri::AppHandle,
    state: tauri::State<LargeState>,
    guard: tauri::State<crate::commands::paths::PathGuard>,
    path: String,
    anchor_bytes: Option<u64>,
) -> Result<LargeFileInfo, String> {
    guard.add_path(&path);
    let p = PathBuf::from(&path);
    let size = std::fs::metadata(&p).map_err(|e| format!("读取文件信息失败: {e}"))?.len();
    let head = read_head(&p, 64 * 1024)?;
    if is_utf16_bom(&head) {
        return Err("UTF-16 文件暂不支持只读虚拟视图，请用编辑器打开".to_string());
    }
    let guess = encoding::guess(&head);
    let encoding_name = guess.encoding;

    let anchor_bytes = anchor_bytes.unwrap_or(64 * 1024);
    let file = File::open(&p).map_err(|e| format!("读取失败: {e}"))?;
    let mut indexer = Indexer::new(file, anchor_bytes);
    let mut reached_eof = false;
    while indexer.pos < FIRST_SCAN_BYTES {
        match indexer.step()? {
            true => {}
            false => {
                reached_eof = true;
                break;
            }
        }
    }

    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let newline = indexer.newline();
    // 同一路径二次打开（会话重开 / 虚拟视图替换）时分配新 session：
    // 旧会话的后台索引线程据此识别自己已过期，不再覆盖新会话
    let session = state.next_session.fetch_add(1, Ordering::Relaxed) + 1;
    let entry = LargeFile {
        path: p.clone(),
        size,
        encoding: encoding_name.clone(),
        newline: newline.clone(),
        total_lines: indexer.total_lines(),
        indexed_bytes: indexer.pos,
        complete: reached_eof,
        anchors: indexer.anchors.clone(),
        session,
    };
    let total_lines = entry.total_lines;
    let indexed_bytes = entry.indexed_bytes;

    let shared = state.inner().clone();
    {
        let mut map = shared.files.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(path.clone(), entry);
    }

    // 后台补齐剩余索引
    if !reached_eof {
        let app_bg = app.clone();
        let shared_bg = shared.clone();
        let id = path.clone();
        std::thread::spawn(move || {
            let file = match File::open(&p) {
                Ok(f) => f,
                Err(_) => return,
            };
            let mut idx = indexer;
            idx.file = file;
            let mut last_emit = Instant::now();
            loop {
                match idx.step() {
                    Ok(true) => {}
                    Ok(false) | Err(_) => break,
                }
                if last_emit.elapsed() >= PROGRESS_EVERY {
                    last_emit = Instant::now();
                    let _ = app_bg.emit(
                        "large://index-progress",
                        IndexProgress {
                            id: id.clone(),
                            scanned: idx.pos,
                            total: size,
                            lines: idx.line_no,
                        },
                    );
                }
            }
            // 会话校验：期间若同一路径被重新打开（新 session）或已关闭，
            // 旧线程的结果一律丢弃，绝不覆盖新会话 / 向已关闭会话发事件
            let current_session = {
                let map = shared_bg.files.lock().unwrap_or_else(|e| e.into_inner());
                map.get(&id).map(|item| item.session)
            };
            if current_session != Some(session) {
                return;
            }
            let total = idx.total_lines();
            let newline = idx.newline();
            {
                let mut map = shared_bg.files.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(item) = map.get_mut(&id) {
                    if item.session != session {
                        return;
                    }
                    item.anchors = idx.anchors;
                    item.total_lines = total;
                    item.newline = newline.clone();
                    item.indexed_bytes = idx.pos;
                    item.complete = true;
                }
            }
            let _ = app_bg.emit(
                "large://index-ready",
                IndexReady {
                    id,
                    total_lines: total,
                    newline,
                },
            );
        });
    }

    Ok(LargeFileInfo {
        id: path.clone(),
        path,
        name,
        size,
        encoding: encoding_name,
        newline,
        total_lines,
        indexed_bytes,
        complete: reached_eof,
    })
}

/// 解析锚点：取最后一个「行号 ≤ 目标行」的锚点作为扫描起点
fn locate(anchors: &[(u64, usize)], line: usize) -> (u64, usize) {
    let idx = match anchors.binary_search_by(|a| a.1.cmp(&line)) {
        Ok(i) => i,
        Err(i) => i.saturating_sub(1),
    };
    anchors.get(idx).copied().unwrap_or((0, 0))
}

/// 读取 [start, start+count) 行；返回行号与文本
#[tauri::command]
pub fn read_large_lines(
    state: tauri::State<LargeState>,
    id: String,
    start: usize,
    count: usize,
) -> Result<LineWindow, String> {
    let (path, encoding_name, anchors, complete, indexed_lines) = {
        let map = state.files.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(&id).ok_or("大文件会话已关闭")?;
        (
            entry.path.clone(),
            entry.encoding.clone(),
            entry.anchors.clone(),
            entry.complete,
            entry.anchors.last().map(|a| a.1).unwrap_or(0),
        )
    };
    if !complete && start > indexed_lines {
        return Err("索引建立中，请稍后再试".to_string());
    }

    let count = count.clamp(1, MAX_WINDOW_LINES);
    let from = locate(&anchors, start);
    let mut file = File::open(&path).map_err(|e| format!("读取失败: {e}"))?;
    file.seek(SeekFrom::Start(from.0))
        .map_err(|e| format!("定位失败: {e}"))?;

    let mut buf: Vec<u8> = Vec::with_capacity(1 << 20);
    let mut cursor = 0usize;
    let mut line_no = from.1;
    let mut line_nos: Vec<usize> = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let mut truncated_lines = 0usize;

    loop {
        if cursor >= buf.len() {
            let mut chunk = vec![0u8; 1 << 20];
            let n = file.read(&mut chunk).map_err(|e| format!("读取失败: {e}"))?;
            if n == 0 {
                break;
            }
            chunk.truncate(n);
            buf.extend_from_slice(&chunk);
        }

        match buf[cursor..].iter().position(|&b| b == b'\n') {
            Some(off) => {
                let end = cursor + off;
                if line_no >= start {
                    let (text, cut) = clamp_line(decode_line(&buf[cursor..end], &encoding_name));
                    truncated_lines += usize::from(cut);
                    line_nos.push(line_no);
                    lines.push(text);
                    if line_nos.len() >= count {
                        break;
                    }
                }
                cursor = end + 1;
                line_no += 1;
                if cursor >= (16 << 20) {
                    buf.drain(..cursor);
                    cursor = 0;
                }
            }
            None => {
                let mut chunk = vec![0u8; 1 << 20];
                let n = file.read(&mut chunk).map_err(|e| format!("读取失败: {e}"))?;
                if n == 0 {
                    if line_no >= start {
                        let (text, cut) = clamp_line(decode_line(&buf[cursor..], &encoding_name));
                        truncated_lines += usize::from(cut);
                        line_nos.push(line_no);
                        lines.push(text);
                    }
                    break;
                }
                chunk.truncate(n);
                buf.extend_from_slice(&chunk);
            }
        }
    }

    Ok(LineWindow {
        start,
        line_nos,
        lines,
        truncated_lines,
    })
}

/// 整文件过滤：返回命中行的原始行号（0-based）。
/// 命中行按批通过 `large://filter-batch` 先行推送，命令返回值作为最终权威结果。
/// 全文件遍历可能耗时数分钟：放 spawn_blocking 执行，避免阻塞事件循环
/// （否则界面连「取消」按钮都点不了）。
#[tauri::command]
pub async fn filter_large_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, LargeState>,
    id: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    request_id: u64,
) -> Result<FilterResult, String> {
    // State 引用不能进 'static 闭包：克隆内部 Arc 再移交
    let files = state.files.clone();
    let cancel_slot = state.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        filter_large_blocking(
            &app,
            &files,
            &cancel_slot,
            &id,
            &query,
            case_sensitive,
            use_regex,
            request_id,
        )
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

fn filter_large_blocking(
    app: &tauri::AppHandle,
    files: &Arc<Mutex<HashMap<String, LargeFile>>>,
    cancel_slot: &Arc<Mutex<Option<Arc<AtomicBool>>>>,
    id: &str,
    query: &str,
    case_sensitive: bool,
    use_regex: bool,
    request_id: u64,
) -> Result<FilterResult, String> {
    let (path, size, encoding_name) = {
        let map = files.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(id).ok_or("大文件会话已关闭")?;
        (entry.path.clone(), entry.size, entry.encoding.clone())
    };
    if query.is_empty() {
        return Ok(FilterResult {
            matches: Vec::new(),
            truncated: false,
            cancelled: false,
            scanned: 0,
        });
    }
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("正则表达式无效: {e}"))?;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = cancel_slot.lock().unwrap_or_else(|e| e.into_inner());
        // 新过滤开始前中止上一次仍在扫描的任务，避免两份全文件遍历并发
        if let Some(prev) = slot.take() {
            prev.store(true, Ordering::Relaxed);
        }
        *slot = Some(cancel.clone());
    }

    let mut file = File::open(&path).map_err(|e| format!("读取失败: {e}"))?;
    let mut buf = vec![0u8; CHUNK];
    let mut carry: Vec<u8> = Vec::new();
    let mut line_no = 0usize;
    let mut matches: Vec<usize> = Vec::new();
    let mut pending: Vec<usize> = Vec::new();
    let mut scanned = 0u64;
    let mut truncated = false;
    let mut cancelled = false;
    let mut last_emit = Instant::now();

    loop {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let n = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
        if n == 0 {
            break;
        }
        scanned += n as u64;

        let mut data: Vec<u8> = std::mem::take(&mut carry);
        data.extend_from_slice(&buf[..n]);
        let cut = memchr::memrchr(b'\n', &data).map(|i| i + 1).unwrap_or(0);
        carry = data[cut..].to_vec();

        if cut > 0 {
            let text = encoding::decode(&data[..cut], &encoding_name)
                .unwrap_or_else(|_| String::from_utf8_lossy(&data[..cut]).into_owned());
            // cut 落在换行符之后，故末尾必为空串，去除后即为本块完整行
            let parts: Vec<&str> = text.split('\n').collect();
            let line_count = parts.len().saturating_sub(1);
            for (i, line) in parts.iter().take(line_count).enumerate() {
                if re.is_match(line) {
                    let line_idx = line_no + i;
                    matches.push(line_idx);
                    pending.push(line_idx);
                    if matches.len() >= MAX_FILTER_MATCHES {
                        truncated = true;
                        break;
                    }
                }
            }
            line_no += line_count;
        }
        if truncated {
            break;
        }
        if last_emit.elapsed() >= PROGRESS_EVERY || pending.len() >= FILTER_BATCH_MAX {
            last_emit = Instant::now();
            let _ = app.emit(
                "large://filter-progress",
                FilterProgress {
                    id: id.to_string(),
                    scanned,
                    total: size,
                    matches: matches.len(),
                },
            );
            if !pending.is_empty() {
                let _ = app.emit(
                    "large://filter-batch",
                    FilterBatch {
                        id: id.to_string(),
                        request_id,
                        matches: std::mem::take(&mut pending),
                        scanned,
                        total: size,
                        truncated: false,
                        done: false,
                        cancelled: false,
                    },
                );
            }
        }
    }

    if !cancelled && !truncated && !carry.is_empty() {
        let body = match carry.last() {
            Some(b'\r') => &carry[..carry.len() - 1],
            _ => &carry[..],
        };
        let text = encoding::decode(body, &encoding_name)
            .unwrap_or_else(|_| String::from_utf8_lossy(body).into_owned());
        if re.is_match(&text) && matches.len() < MAX_FILTER_MATCHES {
            matches.push(line_no);
            pending.push(line_no);
        }
    }

    {
        // 仅清理自己登记的取消标志：期间可能已有新任务登记了新标志
        let mut slot = cancel_slot.lock().unwrap_or_else(|e| e.into_inner());
        let own = slot
            .as_ref()
            .map(|f| Arc::ptr_eq(f, &cancel))
            .unwrap_or(false);
        if own {
            *slot = None;
        }
    }

    let _ = app.emit(
        "large://filter-progress",
        FilterProgress {
            id: id.to_string(),
            scanned,
            total: size,
            matches: matches.len(),
        },
    );
    // 末批带 done 标记：前端据此收尾（含取消 / 截断状态）
    let _ = app.emit(
        "large://filter-batch",
        FilterBatch {
            id: id.to_string(),
            request_id,
            matches: pending,
            scanned,
            total: size,
            truncated,
            done: true,
            cancelled,
        },
    );

    Ok(FilterResult {
        matches,
        truncated,
        cancelled,
        scanned,
    })
}

/// 中止正在进行的过滤
#[tauri::command]
pub fn cancel_large_task(state: tauri::State<LargeState>) {
    let slot = state.cancel.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(flag) = slot.as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// 缩略图行密度：按字节区间把行数摊到各桶
#[tauri::command]
pub fn large_minimap(
    state: tauri::State<LargeState>,
    id: String,
    buckets: usize,
) -> Result<Vec<u32>, String> {
    let map = state.files.lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.get(&id).ok_or("大文件会话已关闭")?;
    let buckets = buckets.clamp(1, 2000);
    let mut out = vec![0u32; buckets];
    if entry.size == 0 {
        return Ok(out);
    }
    let scale = buckets as f64 / entry.size as f64;
    for pair in entry.anchors.windows(2) {
        let (p0, l0) = pair[0];
        let (p1, l1) = pair[1];
        let lines = l1.saturating_sub(l0);
        if lines == 0 {
            continue;
        }
        let b0 = (p0 as f64 * scale) as usize;
        let b1 = ((p1 as f64 * scale) as usize).min(buckets - 1);
        let span = b1 - b0 + 1;
        let per = (lines / span).max(1) as u32;
        for b in b0..=b1 {
            out[b] = out[b].saturating_add(per);
        }
    }
    Ok(out)
}

/// 切换解码编码：单字节家族（UTF-8 / GBK / Big5…）字节偏移不变，无需重建索引
#[tauri::command]
pub fn set_large_encoding(
    state: tauri::State<LargeState>,
    id: String,
    encoding_name: String,
) -> Result<(), String> {
    if encoding::lookup(&encoding_name).is_none() {
        return Err(format!("不支持的编码: {encoding_name}"));
    }
    let mut map = state.files.lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.get_mut(&id).ok_or("大文件会话已关闭")?;
    entry.encoding = encoding_name;
    Ok(())
}

/// 查询会话当前状态（切换回标签时用，索引可能已由后台补齐）
#[tauri::command]
pub fn large_file_info(
    state: tauri::State<LargeState>,
    id: String,
) -> Result<LargeFileInfo, String> {
    let map = state.files.lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.get(&id).ok_or("大文件会话已关闭")?;
    let name = entry
        .path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(LargeFileInfo {
        id: id.clone(),
        path: entry.path.to_string_lossy().to_string(),
        name,
        size: entry.size,
        encoding: entry.encoding.clone(),
        newline: entry.newline.clone(),
        total_lines: entry.total_lines,
        indexed_bytes: entry.indexed_bytes,
        complete: entry.complete,
    })
}

/// 关闭大文件会话，释放索引
#[tauri::command]
pub fn close_large_file(state: tauri::State<LargeState>, id: String) {
    let mut map = state.files.lock().unwrap_or_else(|e| e.into_inner());
    map.remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 写临时文件并返回路径（文件名带前缀，避免并发用例互相覆盖）
    fn temp_file(tag: &str, content: &[u8]) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("my_editor_large_test_{tag}.txt"));
        let mut file = File::create(&path).unwrap();
        file.write_all(content).unwrap();
        path
    }

    /// 跑完整索引，返回 Indexer 终态
    fn index_all(path: &Path, anchor_bytes: u64) -> Indexer {
        let mut indexer = Indexer::new(File::open(path).unwrap(), anchor_bytes);
        while indexer.step().unwrap() {}
        indexer
    }

    #[test]
    fn counts_lines_for_lf_file() {
        let p = temp_file("lf", b"a\nb\nc\n");
        let idx = index_all(&p, 4096);
        assert_eq!(idx.total_lines(), 3);
        assert_eq!(idx.newline(), "LF");
    }

    #[test]
    fn counts_residual_last_line_without_newline() {
        let p = temp_file("noeol", b"a\nb\nc");
        let idx = index_all(&p, 4096);
        assert_eq!(idx.total_lines(), 3);
        assert_eq!(idx.newline(), "LF");
    }

    #[test]
    fn detects_crlf_when_majority() {
        let p = temp_file("crlf", b"a\r\nb\r\nc\r\n");
        let idx = index_all(&p, 4096);
        assert_eq!(idx.total_lines(), 3);
        assert_eq!(idx.newline(), "CRLF");
    }

    #[test]
    fn empty_file_has_no_newline_style() {
        let p = temp_file("empty", b"");
        let idx = index_all(&p, 4096);
        assert_eq!(idx.total_lines(), 0);
        assert_eq!(idx.newline(), "NONE");
    }

    #[test]
    fn anchors_always_land_on_line_start() {
        // 每行 5000 字节，行距超过 4096 锚点间隔 → 每行各记一个锚点
        let line = format!("{}\n", "x".repeat(5000));
        let content = line.repeat(4);
        let p = temp_file("anchors", content.as_bytes());
        let idx = index_all(&p, 4096);
        assert_eq!(idx.total_lines(), 4);
        assert!(idx.anchors.len() >= 4);
        let bytes = std::fs::read(&p).unwrap();
        // 锚点首项固定为 (0,0)；其余锚点前一个字节必须是换行符（行首不变式）
        assert_eq!(idx.anchors[0], (0, 0));
        for &(pos, _line) in idx.anchors.iter().skip(1) {
            assert_eq!(bytes[pos as usize - 1], b'\n');
        }
    }

    #[test]
    fn locate_returns_last_anchor_at_or_before_line() {
        let anchors = vec![(0u64, 0usize), (10, 3), (20, 7)];
        assert_eq!(locate(&anchors, 0), (0, 0));
        assert_eq!(locate(&anchors, 3), (10, 3));
        assert_eq!(locate(&anchors, 5), (10, 3));
        assert_eq!(locate(&anchors, 7), (20, 7));
        assert_eq!(locate(&anchors, 999), (20, 7));
    }

    #[test]
    fn clamp_line_truncates_over_threshold() {
        let short = "hello".to_string();
        assert_eq!(clamp_line(short.clone()), (short, false));

        let long = "y".repeat(MAX_LINE_CHARS + 10);
        let (text, truncated) = clamp_line(long);
        assert!(truncated);
        assert!(text.ends_with('…'));
        assert_eq!(text.chars().count(), MAX_LINE_CHARS + 1);
    }

    #[test]
    fn utf16_bom_detected_and_utf8_rejected() {
        assert!(is_utf16_bom(&[0xFF, 0xFE, 0x41, 0x00]));
        assert!(is_utf16_bom(&[0xFE, 0xFF, 0x00, 0x41]));
        assert!(!is_utf16_bom(&[0xEF, 0xBB, 0xBF]));
        assert!(!is_utf16_bom(b"plain"));
    }
}
