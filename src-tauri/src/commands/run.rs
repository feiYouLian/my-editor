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

/// Windows 上必须用 curl.exe：PowerShell 会把 curl 解析为 Invoke-WebRequest 别名
#[cfg(windows)]
pub(crate) const CURL_PROGRAM: &str = "curl.exe";
#[cfg(not(windows))]
pub(crate) const CURL_PROGRAM: &str = "curl";

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

/// 拼接续行：行尾 `\`（bash）或 `` ` ``（PowerShell）与下一行合并（去掉续行符，补一个空格）。
/// 注释行（`#` 开头）整行剔除；续行中的 `#` 不当作注释。
fn join_continuations(text: &str) -> String {
    let mut out = String::new();
    let mut continued = false;
    for line in text.lines() {
        if !continued && line.trim_start().starts_with('#') {
            continue;
        }
        let trimmed = line.trim_end();
        let stem = trimmed
            .strip_suffix('\\')
            .or_else(|| trimmed.strip_suffix('`'));
        if let Some(stem) = stem {
            out.push_str(stem);
            out.push(' ');
            continued = true;
        } else {
            out.push_str(line);
            out.push('\n');
            continued = false;
        }
    }
    out
}

/// 解析 cURL 参数脚本（内容而非路径）：剔首词 `curl` / `curl.exe`、去注释、拼续行、引号感知切分。
/// 兼容 PowerShell 的 `& 'curl' ...` 形式（DevTools / 浏览器复制常见）。
fn parse_curl_args(text: &str) -> Result<Vec<String>, String> {
    let joined = join_continuations(text);
    let mut args = split_args(&joined);
    // PowerShell 调用运算符不是 curl 参数
    if args.first().map(|a| a == "&").unwrap_or(false) {
        args.remove(0);
    }
    // 去掉开头的 curl / curl.exe（大小写不敏感）
    if args
        .first()
        .map(|a| a.eq_ignore_ascii_case("curl") || a.eq_ignore_ascii_case("curl.exe"))
        .unwrap_or(false)
    {
        args.remove(0);
    }
    if args.is_empty() {
        return Err(
            "cURL 参数为空（按 curl 参数书写，支持 PowerShell 的 & 'curl' 形式）".to_string(),
        );
    }
    Ok(args)
}

/// 运行源：磁盘文件或直接给定的脚本内容（cURL）
pub(crate) enum RunSource<'a> {
    File(&'a Path),
    Script(&'a str),
}

/// 与进程创建方式无关的命令描述：run_code 与终端执行共用。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    /// 需要在子进程 / shell 行中设置的环变量
    pub envs: Vec<(String, String)>,
}

fn file_arg(file: &Path) -> String {
    file.to_string_lossy().into_owned()
}

/// 按运行器生成命令描述（不创建进程）
pub(crate) fn command_spec(runner: &str, source: RunSource<'_>) -> Result<CommandSpec, String> {
    match (runner, source) {
        ("python", RunSource::File(file)) => Ok(CommandSpec {
            program: "python".into(),
            args: vec![file_arg(file)],
            // 避免中文 Windows 控制台按 GBK 输出
            envs: vec![("PYTHONIOENCODING".into(), "utf-8".into())],
        }),
        ("node", RunSource::File(file)) => Ok(CommandSpec {
            program: "node".into(),
            args: vec![file_arg(file)],
            envs: Vec::new(),
        }),
        ("java", RunSource::File(file)) => Ok(CommandSpec {
            // 单文件源码启动（Java 11+）；指定 UTF-8 输出
            program: "java".into(),
            args: vec![
                "-Dfile.encoding=UTF-8".into(),
                "-Dstdout.encoding=UTF-8".into(),
                file_arg(file),
            ],
            envs: Vec::new(),
        }),
        ("curl", RunSource::File(file)) => {
            let text = std::fs::read_to_string(file).map_err(|e| format!("读取失败: {e}"))?;
            command_spec("curl", RunSource::Script(&text))
        }
        ("curl", RunSource::Script(text)) => Ok(CommandSpec {
            program: CURL_PROGRAM.into(),
            args: parse_curl_args(text)?,
            envs: Vec::new(),
        }),
        ("python" | "node" | "java", RunSource::Script(_)) => {
            Err(format!("{runner} 需要磁盘文件，不能直接执行脚本文本"))
        }
        (other, _) => Err(format!("不支持的运行器: {other}")),
    }
}

/// 按运行器构造命令（cURL 从文件内容解析参数）
fn build_command(runner: &str, file: &Path) -> Result<Command, String> {
    let spec = command_spec(runner, RunSource::File(file))?;
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args);
    for (key, value) in &spec.envs {
        cmd.env(key, value);
    }
    Ok(cmd)
}

/// shell 类型决定命令行引号规则
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShellKind {
    PowerShell,
    Posix,
    Cmd,
}

/// 由可执行文件名推断 shell 类型（powershell.exe / pwsh / cmd.exe / bash…）
pub(crate) fn shell_kind(program: &str) -> ShellKind {
    let name = program
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    if name.contains("powershell") || name.contains("pwsh") {
        ShellKind::PowerShell
    } else if name == "cmd" || name == "cmd.exe" {
        ShellKind::Cmd
    } else {
        ShellKind::Posix
    }
}

fn quote_powershell(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "''"))
}

fn quote_posix(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// 把命令描述渲染成可写入 shell 的一行命令。
/// PowerShell 用 `& 'prog' 'arg'`；POSIX 用 `'prog' 'arg'`；cmd.exe 暂不支持。
pub(crate) fn render_shell_line(kind: ShellKind, spec: &CommandSpec) -> Result<String, String> {
    match kind {
        ShellKind::Cmd => Err("cmd.exe 暂不支持在终端运行，请改用 PowerShell".to_string()),
        ShellKind::PowerShell => {
            let mut parts: Vec<String> = Vec::new();
            for (key, value) in &spec.envs {
                parts.push(format!("$env:{key}={}", quote_powershell(value)));
            }
            let mut cmd = format!("& {}", quote_powershell(&spec.program));
            for arg in &spec.args {
                cmd.push(' ');
                cmd.push_str(&quote_powershell(arg));
            }
            parts.push(cmd);
            Ok(parts.join("; "))
        }
        ShellKind::Posix => {
            let mut line = String::new();
            for (key, value) in &spec.envs {
                line.push_str(key);
                line.push('=');
                line.push_str(&quote_posix(value));
                line.push(' ');
            }
            line.push_str(&quote_posix(&spec.program));
            for arg in &spec.args {
                line.push(' ');
                line.push_str(&quote_posix(arg));
            }
            Ok(line)
        }
    }
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

/// 返回可安全按 UTF-8 解码的前缀长度。
/// 末尾不完整的 1–3 字节字符序列留到下一次 flush，避免中文在分块边界被替换为乱码。
fn utf8_flush_len(buf: &[u8]) -> usize {
    if buf.is_empty() {
        return 0;
    }
    // 跳过末尾的 UTF-8 连续字节（10xxxxxx），定位最后一个 lead byte
    let mut i = buf.len();
    while i > 0 && buf[i - 1] & 0xC0 == 0x80 {
        i -= 1;
    }
    if i == 0 {
        // 整块都是连续字节（不应发生：尾部一直向前结转）：直接 lossy 输出
        return buf.len();
    }
    let lead = buf[i - 1];
    let need = if lead < 0x80 {
        1
    } else if lead >> 5 == 0b110 {
        2
    } else if lead >> 4 == 0b1110 {
        3
    } else if lead >> 3 == 0b11110 {
        4
    } else {
        1 // 非法 lead：不累加，直接交给 lossy 解码
    };
    let continuation = buf.len() - i;
    if need > 1 && continuation + 1 < need {
        i - 1
    } else {
        buf.len()
    }
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
                    let complete = utf8_flush_len(&pending);
                    if complete < pending.len() {
                        // 末尾字符被截断：只回传完整前缀，尾部留到下一次读取
                        if complete == 0 {
                            continue;
                        }
                        let tail = pending.split_off(complete);
                        flush(&app, stream, &mut pending);
                        pending = tail;
                        last = Instant::now();
                    } else if pending.len() >= FLUSH_BYTES
                        || last.elapsed().as_millis() >= FLUSH_MS
                    {
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

/// 启动进程并接管输出（run_code / run_curl 共用）：
/// 管道接管 → 读取线程 → 登记 slot → 守望线程。
fn spawn_run(
    app: AppHandle,
    slot: &Arc<Mutex<Option<Running>>>,
    generation_counter: &Arc<AtomicU64>,
    mut cmd: Command,
    label: &str,
) -> Result<(), String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动失败（{label} 是否已安装并在 PATH 中？）: {e}"))?;
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
    let generation = generation_counter.fetch_add(1, Ordering::Relaxed) + 1;

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

    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running {
        child,
        stopped: Arc::clone(&stopped),
        generation,
    });
    spawn_reaper(app, Arc::clone(slot), generation, started, truncated, stopped);
    Ok(())
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
    cmd.current_dir(&work_dir);
    spawn_run(app, &state.slot, &state.generation, cmd, &runner)
}

/// 执行一段 cURL 脚本（内容而非路径）：无需先保存文件，选区/整篇由前端裁决。
/// 不走 PathGuard：参数是脚本内容；`-o 路径` 等由 curl 自行解释（与终端执行等价）。
#[tauri::command]
pub fn run_curl(
    app: AppHandle,
    state: tauri::State<RunState>,
    guard: tauri::State<crate::commands::paths::PathGuard>,
    script: String,
) -> Result<(), String> {
    let spec = command_spec("curl", RunSource::Script(&script))?;
    kill_tree(&state.slot);

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args);
    // 无磁盘文件可依：取首个已登记的工作区目录；没有则用进程默认目录
    if let Some(dir) = guard.first_dir_root() {
        cmd.current_dir(dir);
    }
    spawn_run(app, &state.slot, &state.generation, cmd, "curl")
}

/// 停止当前运行；返回是否有正在运行的任务
///
/// taskkill 可能耗时（应用退出流程也会调用本命令），必须放到阻塞线程，
/// 否则会占住主线程让窗口「未响应」。
#[tauri::command]
pub async fn stop_run(state: tauri::State<'_, RunState>) -> Result<bool, String> {
    let slot = state.slot.clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(running) => running.stopped.store(true, Ordering::Relaxed),
                None => return false,
            }
        }
        kill_tree(&slot);
        true
    })
    .await
    .map_err(|e| format!("停止运行失败: {e}"))
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

    #[test]
    fn parse_curl_args_supports_long_options_and_quotes() {
        let args = parse_curl_args(
            "curl --header 'Accept: application/json' -X POST https://example.com -d '{\"a\":1}'",
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "--header",
                "Accept: application/json",
                "-X",
                "POST",
                "https://example.com",
                "-d",
                "{\"a\":1}",
            ]
        );
    }

    #[test]
    fn parse_curl_args_joins_continuation_lines() {
        let args = parse_curl_args(
            "# 注释\ncurl -X POST \\\n  -H 'X-A: 1' \\\n  https://example.com\n",
        )
        .unwrap();
        assert_eq!(
            args,
            vec!["-X", "POST", "-H", "X-A: 1", "https://example.com"]
        );
    }

    #[test]
    fn parse_curl_args_rejects_empty_script() {
        assert!(parse_curl_args("# 只有注释\n\n  ").is_err());
        assert!(parse_curl_args("").is_err());
    }

    #[test]
    fn utf8_flush_len_holds_incomplete_sequences() {
        assert_eq!(utf8_flush_len(b""), 0);
        assert_eq!(utf8_flush_len("a".as_bytes()), 1);
        assert_eq!(utf8_flush_len(&[0xE4]), 0);
        assert_eq!(utf8_flush_len(&[0xE4, 0xB8]), 0);
        assert_eq!(utf8_flush_len("中".as_bytes()), 3);
        assert_eq!(utf8_flush_len(b"a\xE4\xB8"), 1);
        assert_eq!(utf8_flush_len("😀".as_bytes()), 4);
        assert_eq!(utf8_flush_len(&[0xFF, b'a']), 2);
    }

    #[test]
    fn shell_kind_detects_known_shells() {
        assert_eq!(shell_kind("powershell.exe"), ShellKind::PowerShell);
        assert_eq!(
            shell_kind("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
            ShellKind::PowerShell
        );
        assert_eq!(shell_kind("cmd.exe"), ShellKind::Cmd);
        assert_eq!(shell_kind("/bin/bash"), ShellKind::Posix);
    }

    #[test]
    fn powershell_line_quotes_args_and_envs() {
        let spec = CommandSpec {
            program: "python".into(),
            args: vec!["C:\\a b\\测试.py".into(), "it's".into()],
            envs: vec![("PYTHONIOENCODING".into(), "utf-8".into())],
        };
        let line = render_shell_line(ShellKind::PowerShell, &spec).unwrap();
        assert_eq!(
            line,
            "$env:PYTHONIOENCODING='utf-8'; & 'python' 'C:\\a b\\测试.py' 'it''s'"
        );
    }

    #[test]
    fn posix_line_quotes_args_and_envs() {
        let spec = CommandSpec {
            program: "python".into(),
            args: vec!["a b".into(), "it's".into()],
            envs: vec![("PYTHONIOENCODING".into(), "utf-8".into())],
        };
        let line = render_shell_line(ShellKind::Posix, &spec).unwrap();
        assert_eq!(line, "PYTHONIOENCODING='utf-8' 'python' 'a b' 'it'\\''s'");
    }

    #[test]
    fn cmd_shell_is_rejected_for_terminal_run() {
        let spec = CommandSpec {
            program: "python".into(),
            args: vec!["a.py".into()],
            envs: Vec::new(),
        };
        assert!(render_shell_line(ShellKind::Cmd, &spec).is_err());
    }

    #[test]
    fn command_spec_matches_each_runner() {
        let file = temp_file("spec.py", "print('hi')");
        let py = command_spec("python", RunSource::File(&file)).unwrap();
        assert_eq!(py.program, "python");
        assert_eq!(py.args.len(), 1);
        assert_eq!(py.envs[0].0, "PYTHONIOENCODING");

        let java = command_spec("java", RunSource::File(&file)).unwrap();
        assert_eq!(java.args[0], "-Dfile.encoding=UTF-8");

        let curl = command_spec("curl", RunSource::Script("curl -sS https://example.com")).unwrap();
        assert!(curl.program == "curl" || curl.program == "curl.exe");
        assert_eq!(curl.args, vec!["-sS", "https://example.com"]);

        assert!(command_spec("node", RunSource::Script("x")).is_err());
        assert!(command_spec("ruby", RunSource::File(&file)).is_err());
    }

    #[test]
    fn parse_curl_args_accepts_powershell_and_curl_exe() {
        // 浏览器 DevTools / PowerShell 复制的命令：& 'curl' / & 'curl.exe'
        let args = parse_curl_args(
            "& 'curl.exe' '--url' 'http://localhost:8082/userInfo/accessToken' '-X' 'POST' '-H' 'Authorization: 1'",
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "--url",
                "http://localhost:8082/userInfo/accessToken",
                "-X",
                "POST",
                "-H",
                "Authorization: 1",
            ]
        );

        // 直接 curl.exe 写法（大小写不敏感）
        let args = parse_curl_args("CURL.EXE -sS https://example.com").unwrap();
        assert_eq!(args, vec!["-sS", "https://example.com"]);

        // 注释行之后的 & 'CURL'
        let args = parse_curl_args("# 注释\n& 'CURL' '--url' 'http://example.com'").unwrap();
        assert_eq!(args, vec!["--url", "http://example.com"]);

        // PowerShell 反引号续行
        let args = parse_curl_args(
            "& 'curl' '--url' 'http://example.com' `\n  '-H' 'A: b' `\n  '-X' 'POST'",
        )
        .unwrap();
        assert_eq!(
            args,
            vec!["--url", "http://example.com", "-H", "A: b", "-X", "POST"]
        );
    }
}
