//! Code Run：运行当前文件并流式回传输出（**非沙箱**）。
//! 仅支持 Python / Node / Java / cURL；超时 30s、输出上限 1MB、可随时停止。
//! 停止采用「结束整棵进程树」策略：Windows 用 `taskkill /T /F`，其它平台 kill 直接子进程。
//! 说明：这里用 `std::process` + 线程实现（不引入 tokio/process 特性），行为与设计一致。

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 单次运行超时
const TIMEOUT_SECS: u64 = 30;
/// 输出总量上限（stdout + stderr 合计）
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// 输出批量回传：间隔与体积阈值（事件节流，避免逐行刷屏）
const FLUSH_MS: u128 = 80;
const FLUSH_BYTES: usize = 16 * 1024;
/// 读取缓冲
const READ_BUF: usize = 4096;

/// 输出片段事件
pub const CHUNK_EVENT: &str = "run://chunk";
/// 运行结束事件
pub const EXIT_EVENT: &str = "run://exit";

/// 当前运行的进程（同一时刻只允许一个）
#[derive(Default, Clone)]
pub struct RunState {
    slot: Arc<Mutex<Option<Running>>>,
    /// 单调递增的运行代号：reaper 只处理自己那一代的进程，
    /// 防止旧 reaper 超时后误杀新一轮 run 启动的进程
    generation: Arc<AtomicU64>,
}

struct Running {
    child: Child,
    /// 是否由「停止」或超时终止
    stopped: Arc<AtomicBool>,
    /// 本次运行的代号
    generation: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunChunk {
    /// "stdout" | "stderr"
    pub stream: String,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunExit {
    pub code: Option<i32>,
    pub duration_ms: u64,
    pub truncated: bool,
    pub stopped: bool,
    pub timed_out: bool,
}

/// 简易引号感知切分（供 cURL 参数解析；不做变量展开与转义展开）
fn split_args(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in text.chars() {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else {
                    current.push(ch);
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                } else if ch.is_whitespace() {
                    if !current.is_empty() {
                        out.push(std::mem::take(&mut current));
                    }
                } else {
                    current.push(ch);
                }
            }
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// 按运行器构造命令（cURL 从文件内容解析参数）
fn build_command(runner: &str, file: &Path) -> Result<Command, String> {
    let path = file.to_string_lossy().to_string();
    let cmd = match runner {
        "python" => {
            let mut c = Command::new("python");
            c.arg(&path);
            // 避免中文 Windows 控制台按 GBK 输出
            c.env("PYTHONIOENCODING", "utf-8");
            c
        }
        "node" => {
            let mut c = Command::new("node");
            c.arg(&path);
            c
        }
        "java" => {
            // 单文件源码启动（Java 11+）；指定 UTF-8 输出
            let mut c = Command::new("java");
            c.args(["-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", path.as_str()]);
            c
        }
        "curl" => {
            let text =
                std::fs::read_to_string(file).map_err(|e| format!("读取失败: {e}"))?;
            let mut args: Vec<String> = text
                .lines()
                .filter(|line| !line.trim_start().starts_with('#'))
                .flat_map(split_args)
                .collect();
            if args.first().map(|a| a == "curl").unwrap_or(false) {
                args.remove(0);
            }
            if args.is_empty() {
                return Err("cURL 参数为空（文件内按 curl 参数书写）".to_string());
            }
            let mut c = Command::new("curl");
            c.args(args);
            c
        }
        other => return Err(format!("不支持的运行器: {other}")),
    };
    Ok(cmd)
}

/// 结束整棵进程树（Windows）/ 直接子进程（其它平台）
fn kill_tree(slot: &Arc<Mutex<Option<Running>>>) {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    let Some(running) = guard.as_mut() else {
        return;
    };
    #[cfg(windows)]
    {
        // 结束整棵进程树：脚本自行拉起的子进程也能一并清理
        let pid = running.child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    let _ = running.child.kill();
}

/// 仅当 slot 中仍是指定代际的进程时才结束它。
/// 旧 reaper 的超时兜底必须用这个：否则会杀掉新一轮 run 的进程。
fn kill_tree_if_generation(slot: &Arc<Mutex<Option<Running>>>, generation: u64) {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    let Some(running) = guard.as_mut() else {
        return;
    };
    if running.generation != generation {
        return;
    }
    #[cfg(windows)]
    {
        let pid = running.child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    let _ = running.child.kill();
}

/// 读取线程：按体积 / 时间批量回传，超过总量上限后只标记截断
fn spawn_reader<R: Read + Send + 'static>(
    app: AppHandle,
    stream: &'static str,
    reader: R,
    counter: Arc<AtomicUsize>,
    truncated: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut pending: Vec<u8> = Vec::new();
        let mut last = Instant::now();
        let mut buf = vec![0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let used = counter.fetch_add(n, Ordering::Relaxed) + n;
                    if used > MAX_OUTPUT_BYTES {
                        truncated.store(true, Ordering::Relaxed);
                        continue;
                    }
                    pending.extend_from_slice(&buf[..n]);
                    if pending.len() >= FLUSH_BYTES || last.elapsed().as_millis() >= FLUSH_MS {
                        flush(&app, stream, &mut pending);
                        last = Instant::now();
                    }
                }
                Err(_) => break,
            }
        }
        flush(&app, stream, &mut pending);
    });
}

fn flush(app: &AppHandle, stream: &str, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(pending).into_owned();
    pending.clear();
    let _ = app.emit(
        CHUNK_EVENT,
        RunChunk {
            stream: stream.to_string(),
            text,
        },
    );
}

/// 守望线程：轮询退出状态，处理超时并在结束时推送 `run://exit`。
/// 只处理自己这一代（generation）的进程：slot 已被新一轮 run 替换时
/// 立即退出，绝不误杀新进程，也不会重复/矛盾地推送退出事件。
fn spawn_reaper(
    app: AppHandle,
    slot: Arc<Mutex<Option<Running>>>,
    generation: u64,
    started: Instant,
    truncated: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let timeout = Duration::from_secs(TIMEOUT_SECS);
        let mut timed_out = false;
        let code: Option<i32>;
        loop {
            {
                let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
                let Some(running) = guard.as_mut() else {
                    return; // 已被其它路径清理
                };
                if running.generation != generation {
                    return; // slot 已是新一轮 run 的进程：不碰它
                }
                match running.child.try_wait() {
                    Ok(Some(status)) => {
                        code = status.code();
                        *guard = None;
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        code = None;
                        *guard = None;
                        break;
                    }
                }
            }
            if started.elapsed() >= timeout {
                timed_out = true;
                stopped.store(true, Ordering::Relaxed);
                kill_tree_if_generation(&slot, generation);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = app.emit(
            EXIT_EVENT,
            RunExit {
                code,
                duration_ms: started.elapsed().as_millis() as u64,
                truncated: truncated.load(Ordering::Relaxed),
                stopped: stopped.load(Ordering::Relaxed),
                timed_out,
            },
        );
    });
}

/// 运行当前文件：先停掉上一个任务，再启动新进程并流式回传。
/// 安全：目标文件必须是应用已知路径（当前打开的标签），runner 仅接受
/// 内置白名单（python / node / java / curl）。
#[tauri::command]
pub fn run_code(
    app: AppHandle,
    state: tauri::State<RunState>,
    guard: tauri::State<crate::commands::paths::PathGuard>,
    path: String,
    runner: String,
) -> Result<(), String> {
    guard.ensure_file_scope(&path)?;
    kill_tree(&state.slot);

    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err(format!("文件不存在: {path}"));
    }
    let work_dir = file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut cmd = build_command(&runner, &file)?;
    cmd.current_dir(&work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动失败（{runner} 是否已安装并在 PATH 中？）: {e}"))?;
    // 取管道失败时必须终止已启动的进程，否则留下孤儿进程
    let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
        (Some(out), Some(err)) => (out, err),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("无法读取进程输出管道".to_string());
        }
    };

    let counter = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let stopped = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;

    spawn_reader(
        app.clone(),
        "stdout",
        stdout,
        Arc::clone(&counter),
        Arc::clone(&truncated),
    );
    spawn_reader(
        app.clone(),
        "stderr",
        stderr,
        Arc::clone(&counter),
        Arc::clone(&truncated),
    );

    *state.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running {
        child,
        stopped: Arc::clone(&stopped),
        generation,
    });
    spawn_reaper(
        app,
        Arc::clone(&state.slot),
        generation,
        started,
        truncated,
        stopped,
    );
    Ok(())
}

/// 停止当前运行；返回是否有正在运行的任务
#[tauri::command]
pub fn stop_run(state: tauri::State<RunState>) -> bool {
    {
        let guard = state.slot.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(running) => running.stopped.store(true, Ordering::Relaxed),
            None => return false,
        }
    }
    kill_tree(&state.slot);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(tag: &str, content: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("my_editor_run_test_{tag}"));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn split_args_handles_quotes_and_spaces() {
        assert_eq!(split_args("  -X   POST  "), vec!["-X", "POST"]);
        assert_eq!(
            split_args("-d \"a b\" -H 'c:d'"),
            vec!["-d", "a b", "-H", "c:d"]
        );
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn curl_runner_strips_leading_curl_and_comments() {
        let file = temp_file(
            "curl.txt",
            "# 注释行\ncurl -X POST https://example.com -d \"a=1\"\n",
        );
        let cmd = build_command("curl", &file).unwrap();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["-X", "POST", "https://example.com", "-d", "a=1"]);
    }

    #[test]
    fn curl_runner_rejects_empty_arguments() {
        let file = temp_file("curl_empty.txt", "# 只有注释\n");
        assert!(build_command("curl", &file).is_err());
    }

    #[test]
    fn python_runner_sets_utf8_io_encoding() {
        let file = temp_file("py.py", "print('hi')");
        let cmd = build_command("python", &file).unwrap();
        let envs: Vec<String> = cmd
            .get_envs()
            .filter_map(|(k, v)| v.map(|v| format!("{}={}", k.to_string_lossy(), v.to_string_lossy())))
            .collect();
        assert!(envs.iter().any(|e| e == "PYTHONIOENCODING=utf-8"));
    }

    #[test]
    fn unsupported_runner_is_rejected() {
        let file = temp_file("x.txt", "x");
        assert!(build_command("ruby", &file).is_err());
    }
}
