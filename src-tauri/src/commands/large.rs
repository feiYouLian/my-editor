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

/// 「跟随文件尾部」的一次刷新结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeRefresh {
    pub info: LargeFileInfo,
    /// 是否读到了新内容（false = 文件没变 / 仍在校验）
    pub grew: bool,
    /// 文件被截断或替换：续扫不成立，前端应重新打开
    pub reset_required: bool,
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
    /// 锚点间隔（续扫时要沿用同一间隔，否则新旧锚点密度不一致）
    anchor_bytes: u64,
    /// 已扫描到的行号计数（续扫的起点状态，不能从 total_lines 反推）
    scan_line_no: usize,
    /// 已扫描区间最后一个字节（判断末尾是否有未结束的行）
    scan_last_byte: Option<u8>,
    /// 后台索引线程是否仍在跑：此时禁止续扫，否则两处同时写 anchors
    bg_indexing: bool,
    /// 会话取消标志：关闭会话时置位，后台索引 / 续扫线程据此提前退出，
    /// 不再把整个文件读完（否则关掉 1GB 日志后仍会持续读盘）
    cancel: Arc<AtomicBool>,
}

/// 大文件会话注册表；Arc 以便后台索引线程共享
#[derive(Default, Clone)]
pub struct LargeState {
    files: Arc<Mutex<HashMap<String, LargeFile>>>,
    /// 各会话的过滤取消标志（按 id）。
    /// 不能只用全局单槽：关闭标签 A 时不该把标签 B 正在进行的过滤一起取消，
    /// 反之关闭会话本身（逃生门 / 退出）也必须能停掉它的过滤。
    filter_cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
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
        // 直接迭代换行位置：短行日志下一个 4MB 块有十几万个换行，
        // 先 collect 成 Vec 会白付一次分配 + 一次遍历（1GB 文件累计上百 MB 临时分配）
        for idx in memchr::memchr_iter(b'\n', &self.buf[..n]) {
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

/// 后台补齐索引的核心循环：每读完一块检查一次取消标志。
/// 返回 `false` = 被取消，调用方必须丢弃已扫结果（会话已关闭 / 已被新会话取代）。
fn drain_index(
    idx: &mut Indexer,
    cancelled: &AtomicBool,
    mut on_step: impl FnMut(&Indexer),
) -> bool {
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return false;
        }
        match idx.step() {
            Ok(true) => on_step(idx),
            // 读到末尾或读错误：按「已扫到能扫的为止」处理（与原语义一致）
            Ok(false) | Err(_) => return true,
        }
    }
}

/// 打开文件并把读指针定位到已索引位置：续扫（后台补齐 / 外部增长后刷新）共用。
/// 少了这一步会把文件头当成 `pos` 之后的内容重复扫描。
fn reopen_at(path: &Path, pos: u64) -> Result<File, String> {
    let mut file = File::open(path).map_err(|e| format!("读取失败: {e}"))?;
    file.seek(SeekFrom::Start(pos))
        .map_err(|e| format!("定位失败: {e}"))?;
    Ok(file)
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

/// 打开大文件：首屏索引放到 spawn_blocking，避免 8MB 扫描阻塞事件循环；
/// 读取后自动登记该路径，供后续作用域校验使用。
#[tauri::command]
pub async fn open_large_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, LargeState>,
    guard: tauri::State<'_, crate::commands::paths::PathGuard>,
    path: String,
    anchor_bytes: Option<u64>,
) -> Result<LargeFileInfo, String> {
    guard.add_path(&path);
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        open_large_file_blocking(app, &shared, path, anchor_bytes)
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

fn open_large_file_blocking(
    app: tauri::AppHandle,
    state: &LargeState,
    path: String,
    anchor_bytes: Option<u64>,
) -> Result<LargeFileInfo, String> {
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
    // 关闭会话时置位：后台线程每块检查一次，不再把整个文件读完
    let cancel = Arc::new(AtomicBool::new(false));
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
        anchor_bytes: indexer.anchor_bytes,
        scan_line_no: indexer.line_no,
        scan_last_byte: indexer.last_byte,
        // 下方若启动后台索引线程会置 true
        bg_indexing: !reached_eof,
        cancel: Arc::clone(&cancel),
    };
    let total_lines = entry.total_lines;
    let indexed_bytes = entry.indexed_bytes;

    let shared = state.clone();
    {
        let mut map = shared.files.lock().unwrap_or_else(|e| e.into_inner());
        // 同一路径二次打开（会话重开 / 虚拟视图替换）：旧会话的索引线程必须停，
        // 否则它会读完整文件才在末尾发现 session 已过期，白读一遍
        if let Some(old) = map.get(&path) {
            old.cancel.store(true, Ordering::Relaxed);
        }
        map.insert(path.clone(), entry);
    }

    // 后台补齐剩余索引
    if !reached_eof {
        let app_bg = app.clone();
        let shared_bg = shared.clone();
        let id = path.clone();
        std::thread::spawn(move || {
            let mut idx = indexer;
            // 初始扫描已读过 idx.pos 个字节：新句柄必须定位到同一位置，
            // 否则会把文件头当成 pos 之后的内容再扫一遍——行数翻倍、锚点越过 EOF，
            // 缩略图按字节摊桶时就会算出负区间（曾导致 usize 下溢 panic）。
            idx.file = match reopen_at(&p, idx.pos) {
                Ok(f) => f,
                Err(_) => return,
            };
            let mut last_emit = Instant::now();
            let finished = drain_index(&mut idx, &cancel, |idx| {
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
            });
            // 会话已关闭：结果无主，直接退出（不再等整个文件扫完）
            if !finished {
                return;
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
                    item.scan_line_no = idx.line_no;
                    item.scan_last_byte = idx.last_byte;
                    item.bg_indexing = false;
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
    // 锚点表可能有十几万项（1GB / 64KB ≈ 16K 项）：滚动时每次窗口读取都克隆一次
    // 会产生周期性 256KB 分配。在锁内直接定位，只带出标量。
    let (path, encoding_name, from, complete, total_lines) = {
        let map = state.files.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(&id).ok_or("大文件会话已关闭")?;
        (
            entry.path.clone(),
            entry.encoding.clone(),
            locate(&entry.anchors, start),
            entry.complete,
            entry.total_lines,
        )
    };
    // 行号上界用 total_lines 而不是"最后一个锚点的行号"：
    // 跟随模式（tail -f）续扫时锚点会比已扫行数滞后一个间隔，
    // 用锚点行号会让"读尾窗"误报"索引建立中"
    if !complete && start > total_lines {
        return Err("索引建立中，请稍后再试".to_string());
    }

    let count = count.clamp(1, MAX_WINDOW_LINES);
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
    let filter_cancel = state.filter_cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        filter_large_blocking(
            &app,
            &files,
            &filter_cancel,
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

/// 过滤收尾的结果集处理：取消 = 结果作废。
/// 已扫描到的部分命中不能随末批 / 返回值带出去，否则前端会出现
/// 「状态栏已中止，视图仍按半截命中虚拟化」的自相矛盾显示。
fn finalize_matches(cancelled: bool, matches: &mut Vec<usize>, pending: &mut Vec<usize>) {
    if cancelled {
        matches.clear();
        pending.clear();
    }
}

/// 把新读到的块拼到缓冲尾部，返回可处理前缀长度（最后一个换行之后）。
/// 返回 0 表示本块没有换行：整块都是未结束的行，留给下一块继续拼接。
fn append_block(data: &mut Vec<u8>, block: &[u8]) -> usize {
    data.extend_from_slice(block);
    memchr::memrchr(b'\n', data).map(|i| i + 1).unwrap_or(0)
}

fn filter_large_blocking(
    app: &tauri::AppHandle,
    files: &Arc<Mutex<HashMap<String, LargeFile>>>,
    filter_cancel: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
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
        let mut map = filter_cancel.lock().unwrap_or_else(|e| e.into_inner());
        // 同一会话上一次过滤仍在跑：先中止，避免两份全文件遍历并发
        if let Some(prev) = map.insert(id.to_string(), Arc::clone(&cancel)) {
            prev.store(true, Ordering::Relaxed);
        }
    }

    let mut file = File::open(&path).map_err(|e| format!("读取失败: {e}"))?;
    let mut buf = vec![0u8; CHUNK];
    // 复用同一块缓冲承接「上一块未结束的行 + 本块」：每块不再重新分配 4MB，
    // 也不会为尾部残余再 to_vec 一份（1GB 文件可省掉约 1GB 的分配流量）
    let mut data: Vec<u8> = Vec::with_capacity(CHUNK + 64 * 1024);
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

        let cut = append_block(&mut data, &buf[..n]);

        if cut > 0 {
            let text = encoding::decode(&data[..cut], &encoding_name)
                .unwrap_or_else(|_| String::from_utf8_lossy(&data[..cut]).into_owned());
            // cut 落在换行符之后，故末尾必为空串，去除后即为本块完整行
            let parts: Vec<&str> = text.split('\n').collect();
            let line_count = parts.len().saturating_sub(1);
            for (i, line) in parts.iter().take(line_count).enumerate() {
                // 块内检查点：一个 4MB 块可能有十万行，逐行正则期间也要能及时停下
                if i & 1023 == 0 && cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break;
                }
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
            if cancelled {
                break;
            }
            line_no += line_count;
            // 已处理部分移出缓冲，最后一段未结束的行留给下一块拼接
            data.drain(..cut);
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

    if !cancelled && !truncated && !data.is_empty() {
        let body = match data.last() {
            Some(b'\r') => &data[..data.len() - 1],
            _ => &data[..],
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
        let mut map = filter_cancel.lock().unwrap_or_else(|e| e.into_inner());
        let own = map
            .get(id)
            .map(|f| Arc::ptr_eq(f, &cancel))
            .unwrap_or(false);
        if own {
            map.remove(id);
        }
    }

    finalize_matches(cancelled, &mut matches, &mut pending);

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

/// 中止正在进行的过滤：带 id 只取消该会话，不带 id 取消全部（退出 / 重载兜底）
#[tauri::command]
pub fn cancel_large_task(state: tauri::State<LargeState>, id: Option<String>) {
    let map = state.filter_cancel.lock().unwrap_or_else(|e| e.into_inner());
    match id {
        Some(id) => {
            if let Some(flag) = map.get(&id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        None => {
            for flag in map.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

/// 缩略图行密度：把锚点区间的行数摊到各桶。
///
/// 锚点偏移理论上不超过 `size`，但外部截断 / 续扫竞态下仍可能越界；
/// 两端都夹到 `[0, buckets-1]`，避免 `b1 - b0` 的 usize 下溢。
fn accumulate_minimap(anchors: &[(u64, usize)], size: u64, buckets: usize) -> Vec<u32> {
    let mut out = vec![0u32; buckets];
    if size == 0 {
        return out;
    }
    let last = buckets - 1;
    let scale = buckets as f64 / size as f64;
    for pair in anchors.windows(2) {
        let (p0, l0) = pair[0];
        let (p1, l1) = pair[1];
        let lines = l1.saturating_sub(l0);
        if lines == 0 {
            continue;
        }
        let b0 = ((p0 as f64 * scale) as usize).min(last);
        let b1 = ((p1 as f64 * scale) as usize).min(last);
        let (lo, hi) = if b0 <= b1 { (b0, b1) } else { (b1, b0) };
        let span = hi - lo + 1;
        let per = (lines / span).max(1) as u32;
        for b in lo..=hi {
            out[b] = out[b].saturating_add(per);
        }
    }
    out
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
    Ok(accumulate_minimap(
        &entry.anchors,
        entry.size,
        buckets.clamp(1, 2000),
    ))
}

/// 过滤结果出口：把命中行写到 `<文件>.filtered.txt`。
/// 视图保持只读语义：导出的是副本，不改动原文件。
///
/// 作用域以「已打开的大文件会话」为准：只有通过 open_large_file 打开过的路径
/// 才允许写它的 .filtered.txt，不依赖前端登记，也不给任意路径写文件的能力。
/// 同名目标已存在时拒绝写入（前端确认覆盖后置 `overwrite`），写入走原子替换不留半截文件。
#[tauri::command]
pub fn export_large_matches(
    state: tauri::State<'_, LargeState>,
    guard: tauri::State<'_, crate::commands::paths::PathGuard>,
    path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let target = PathBuf::from(&path);
    let known = {
        let map = state.files.lock().unwrap_or_else(|e| e.into_inner());
        map.values().any(|entry| entry.path == target)
    };
    if !known {
        return Err("只有已打开的大文件才能导出命中行".to_string());
    }
    let out = PathBuf::from(format!("{path}.filtered.txt"));
    ensure_export_target(&out, overwrite.unwrap_or(false))?;
    crate::commands::file::atomic_write(&out, content.as_bytes())?;
    // 登记为已知路径：导出结果可直接在编辑器打开
    guard.add_path(&out.to_string_lossy());
    Ok(out.to_string_lossy().into_owned())
}

/// 导出目标检查：已存在且未确认覆盖时拒绝，错误里带上两条出路
fn ensure_export_target(out: &Path, overwrite: bool) -> Result<(), String> {
    if out.exists() && !overwrite {
        return Err(format!(
            "目标已存在：{}。可先删除 / 重命名旧文件，或在确认覆盖后重试",
            out.display()
        ));
    }
    Ok(())
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

fn info_of(id: &str, entry: &LargeFile) -> LargeFileInfo {
    let name = entry
        .path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    LargeFileInfo {
        id: id.to_string(),
        path: entry.path.to_string_lossy().to_string(),
        name,
        size: entry.size,
        encoding: entry.encoding.clone(),
        newline: entry.newline.clone(),
        total_lines: entry.total_lines,
        indexed_bytes: entry.indexed_bytes,
        complete: entry.complete,
    }
}

/// 查询会话当前状态（切换回标签时用，索引可能已由后台补齐）
#[tauri::command]
pub fn large_file_info(
    state: tauri::State<LargeState>,
    id: String,
) -> Result<LargeFileInfo, String> {
    let map = state.files.lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.get(&id).ok_or("大文件会话已关闭")?;
    Ok(info_of(&id, entry))
}

/// 单次续扫上限：日志暴涨时不让一次轮询卡太久（剩余部分下一轮继续）
const MAX_REFRESH_BYTES: u64 = 32 * 1024 * 1024;

/// 跟随文件尾部：把索引续扫到最新 EOF，返回最新状态。
///
/// - 文件被截断/轮转（变小）→ `resetRequired`，前端提示重新打开；
/// - 后台索引仍在跑 → 本轮不续扫（避免两处同时写 anchors），前端下一轮再看；
/// - 单次最多续扫 `MAX_REFRESH_BYTES`，未追平时 `complete=false`，下一轮继续。
#[tauri::command]
pub async fn refresh_large_file(
    state: tauri::State<'_, LargeState>,
    id: String,
) -> Result<LargeRefresh, String> {
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || refresh_large_blocking(&files, &id))
        .await
        .map_err(|e| format!("任务调度失败: {e}"))?
}

fn current_info(
    files: &Arc<Mutex<HashMap<String, LargeFile>>>,
    id: &str,
) -> Result<LargeFileInfo, String> {
    let map = files.lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.get(id).ok_or("大文件会话已关闭")?;
    Ok(info_of(id, entry))
}

fn refresh_large_blocking(
    files: &Arc<Mutex<HashMap<String, LargeFile>>>,
    id: &str,
) -> Result<LargeRefresh, String> {
    // 第一段快照只取"判断是否需要续扫"的字段：
    // 每秒轮询一次，锚点表在大文件上有十几万项，不能每轮都克隆
    let (path, prev_size, complete, bg_indexing) = {
        let map = files.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(id).ok_or("大文件会话已关闭")?;
        (
            entry.path.clone(),
            entry.size,
            entry.complete,
            entry.bg_indexing,
        )
    };

    let new_size = std::fs::metadata(&path)
        .map_err(|e| format!("读取文件信息失败: {e}"))?
        .len();
    if new_size < prev_size {
        // 截断 / 轮转：旧锚点已失效，续扫会读出"错行"的内容
        return Ok(LargeRefresh {
            info: current_info(files, id)?,
            grew: false,
            reset_required: true,
        });
    }
    if bg_indexing || (new_size == prev_size && complete) {
        return Ok(LargeRefresh {
            info: current_info(files, id)?,
            grew: false,
            reset_required: false,
        });
    }

    // 确实要续扫：这一次才取锚点/行号快照，读盘期间不持锁
    let (indexed, scan_line_no, scan_last_byte, anchors, anchor_bytes, session, cancel) = {
        let map = files.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(id).ok_or("大文件会话已关闭")?;
        (
            entry.indexed_bytes,
            entry.scan_line_no,
            entry.scan_last_byte,
            entry.anchors.clone(),
            entry.anchor_bytes,
            entry.session,
            Arc::clone(&entry.cancel),
        )
    };

    let target = new_size.min(indexed.saturating_add(MAX_REFRESH_BYTES));
    // step() 顺序读文件：续扫必须先把句柄定位到已索引位置
    let file = reopen_at(&path, indexed)?;
    let mut idx = Indexer::new(file, anchor_bytes);
    idx.anchors = anchors;
    idx.last_anchor = idx.anchors.last().map(|a| a.0).unwrap_or(0);
    idx.pos = indexed;
    idx.line_no = scan_line_no;
    idx.last_byte = scan_last_byte;
    while idx.pos < target {
        // 会话已关闭：不把这一轮 32MB 读完（返回值与"读到一半会话消失"一致）
        if cancel.load(Ordering::Relaxed) {
            return Err("大文件会话已关闭".to_string());
        }
        match idx.step()? {
            true => {}
            false => break,
        }
    }

    let pos = idx.pos;
    let total = idx.total_lines();
    let caught_up = pos >= new_size;
    let grew = pos > indexed;
    let info = {
        let mut map = files.lock().unwrap_or_else(|e| e.into_inner());
        let item = map.get_mut(id).ok_or("大文件会话已关闭")?;
        if item.session != session {
            return Err("大文件会话已被重新打开".to_string());
        }
        item.size = new_size;
        item.anchors = idx.anchors;
        item.total_lines = total;
        item.indexed_bytes = pos;
        item.complete = caught_up;
        // 换行风格只在首次打开时判定：续扫只看得到新增片段，据此改判会来回抖
        item.scan_line_no = idx.line_no;
        item.scan_last_byte = idx.last_byte;
        info_of(id, item)
    };
    Ok(LargeRefresh {
        info,
        grew,
        reset_required: false,
    })
}

/// 关闭大文件会话，释放索引
///
/// 退出流程会逐个关闭会话，而锁可能正被索引/缩略图线程占用，
/// 因此放到阻塞线程等锁，避免主线程被挂住导致窗口「未响应」。
#[tauri::command]
pub async fn close_large_file(
    state: tauri::State<'_, LargeState>,
    id: String,
) -> Result<(), String> {
    let files = state.files.clone();
    let filter_cancel = state.filter_cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let mut map = files.lock().unwrap_or_else(|e| e.into_inner());
            // 先置位再移除：后台索引线程每块读开头检查该标志，
            // 否则 1GB 日志关掉后仍会读到 EOF（并继续发进度事件）
            if let Some(entry) = map.get(&id) {
                entry.cancel.store(true, Ordering::Relaxed);
            }
            map.remove(&id);
        }
        // 关会话同时停掉它自己的过滤：逃生门 / 退出流程不一定先调 cancel_large_task
        let mut filters = filter_cancel.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(flag) = filters.remove(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    })
    .await
    .map_err(|e| format!("关闭大文件会话失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 写临时文件并返回路径（文件名带前缀，避免并发用例互相覆盖）
    fn temp_file(tag: &str, content: &[u8]) -> PathBuf {
        crate::commands::test_support::temp_file("large", tag, content)
    }

    /// 续扫必须从已索引位置开始（少 seek 会把文件头再扫一遍）
    #[test]
    fn reopen_at_seeks_to_saved_offset() {
        let path = temp_file("reopen_at", b"0123456789");
        let mut file = reopen_at(&path, 4).expect("按偏移打开");
        let mut rest = String::new();
        file.read_to_string(&mut rest).expect("读取剩余内容");
        assert_eq!(rest, "456789");
    }

    /// 导出目标已存在时：未确认覆盖必须拒绝并给出可行动提示；确认后放行
    #[test]
    fn export_target_refuses_overwrite_without_confirmation() {
        let existing = temp_file("export_exists", b"old");
        let err = ensure_export_target(&existing, false).unwrap_err();
        assert!(err.contains("目标已存在"), "{err}");
        assert!(ensure_export_target(&existing, true).is_ok());

        let mut missing = std::env::temp_dir();
        missing.push("my_editor_large_test_export_absent.txt.filtered.txt");
        let _ = std::fs::remove_file(&missing);
        assert!(ensure_export_target(&missing, false).is_ok());
    }

    /// 锚点偏移越过文件末尾时不得下溢：整体夹到最后一个桶
    #[test]
    fn minimap_clamps_anchor_past_size() {
        // 取 E2E 崩溃现场的量级：size 与末尾锚点
        let anchors = [(0u64, 0usize), (21_702_706, 200_000), (21_768_324, 200_100)];
        let out = accumulate_minimap(&anchors, 21_688_894, 240);
        assert_eq!(out.len(), 240);
        assert!(out[239] > 0);
    }

    /// 正常区间按行数均匀摊到各桶
    #[test]
    fn minimap_spreads_lines_across_buckets() {
        let out = accumulate_minimap(&[(0, 0), (100, 100)], 100, 10);
        assert_eq!(out.iter().sum::<u32>(), 100);
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

    /// 会话关闭（取消标志置位）后：后台索引必须在下一次检查点退出，不再读下一块
    #[test]
    fn drain_index_stops_after_cancel() {
        // 5MB > CHUNK，正常要读两块；第一块处理完就置位取消
        let content = vec![b'a'; 5 * 1024 * 1024];
        let p = temp_file("drain_cancel", &content);
        let mut idx = Indexer::new(File::open(&p).unwrap(), 4096);
        let cancelled = AtomicBool::new(false);
        let mut steps = 0;
        let finished = drain_index(&mut idx, &cancelled, |_| {
            steps += 1;
            cancelled.store(true, Ordering::Relaxed);
        });
        assert!(!finished, "取消后不得报告已完成");
        assert_eq!(steps, 1, "第一块后即应停止");
        assert_eq!(idx.pos, CHUNK as u64, "取消后不应再读下一块");
    }

    /// 未取消时：正常扫到文件末尾，行数与一次性扫描一致
    #[test]
    fn drain_index_scans_to_eof_without_cancel() {
        let p = temp_file("drain_full", b"a\nb\nc\n");
        let mut idx = Indexer::new(File::open(&p).unwrap(), 4096);
        let cancelled = AtomicBool::new(false);
        let finished = drain_index(&mut idx, &cancelled, |_| {});
        assert!(finished);
        assert_eq!(idx.total_lines(), 3);
    }

    /// 过滤块拼接：跨块的行必须完整保留，已处理前缀可安全移除
    #[test]
    fn append_block_keeps_partial_line_across_chunks() {
        let mut data: Vec<u8> = Vec::new();
        // 第一块：一行完整 + 半行（cut 落在换行之后）
        let cut = append_block(&mut data, b"line1\npart");
        assert_eq!(cut, 6);
        data.drain(..cut);
        assert_eq!(data, b"part");

        // 第二块：补齐上一行 + 一行完整 + 新的半行
        let cut = append_block(&mut data, b"ial\nline2\nhal");
        assert_eq!(&data[..cut], b"partial\nline2\n");
        data.drain(..cut);
        assert_eq!(data, b"hal");
    }

    /// 取消后不得把半截命中交给前端（否则「已中止 + 半截列表」自相矛盾）
    #[test]
    fn cancelled_filter_drops_partial_matches() {
        let mut matches = vec![1usize, 2, 3];
        let mut pending = vec![2usize, 3];
        finalize_matches(true, &mut matches, &mut pending);
        assert!(matches.is_empty());
        assert!(pending.is_empty());

        // 未取消：结果原样保留
        let mut kept = vec![7usize];
        finalize_matches(false, &mut kept, &mut Vec::new());
        assert_eq!(kept, vec![7]);
    }

    /// 整块没有换行：返回 0，缓冲继续累积（超长行跨块）
    #[test]
    fn append_block_without_newline_keeps_whole_block() {
        let mut data: Vec<u8> = Vec::new();
        assert_eq!(append_block(&mut data, b"abcdef"), 0);
        assert_eq!(data, b"abcdef");
        assert_eq!(append_block(&mut data, b"gh\n"), 9);
    }

    /// 从另一个文件的终态接着扫：模拟 refresh_large_file 的续扫（含句柄定位）
    fn resume_with(full_path: &Path, first: &Indexer, anchor_bytes: u64) -> Indexer {
        let mut file = File::open(full_path).unwrap();
        file.seek(SeekFrom::Start(first.pos)).unwrap();
        let mut idx = Indexer::new(file, anchor_bytes);
        idx.anchors = first.anchors.clone();
        idx.last_anchor = idx.anchors.last().map(|a| a.0).unwrap_or(0);
        idx.pos = first.pos;
        idx.line_no = first.line_no;
        idx.last_byte = first.last_byte;
        idx
    }

    /// 续扫（tail -f）：从首段的终态接着扫，行号/锚点必须与一次性整扫一致
    #[test]
    fn resumed_scan_matches_single_pass() {
        let head_path = temp_file("resume_head", b"a\nb\nc\n");
        let full_path = temp_file("resume_full", b"a\nb\nc\nd\ne\n");

        let first = index_all(&head_path, 4096);
        assert_eq!(first.total_lines(), 3);

        let mut resumed = resume_with(&full_path, &first, 4096);
        while resumed.step().unwrap() {}

        let single = index_all(&full_path, 4096);
        assert_eq!(resumed.total_lines(), single.total_lines());
        assert_eq!(resumed.total_lines(), 5);
        assert_eq!(resumed.anchors, single.anchors);
    }

    /// 续扫起点落在"未结束的行"上时，尾行不能被多算一行
    #[test]
    fn resumed_scan_handles_trailing_partial_line() {
        let head_path = temp_file("resume_partial_head", b"a\nbb");
        let full_path = temp_file("resume_partial_full", b"a\nbbcc\nd\n");

        let first = index_all(&head_path, 4096);
        assert_eq!(first.total_lines(), 2);

        let mut resumed = resume_with(&full_path, &first, 4096);
        while resumed.step().unwrap() {}

        assert_eq!(resumed.total_lines(), 3);
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
