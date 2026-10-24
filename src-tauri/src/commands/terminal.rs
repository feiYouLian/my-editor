//! 内置终端：真实 PTY（Windows ConPTY / Unix pty），单会话。
//!
//! 前后端协议：
//! - `terminal_open` 创建会话，返回 `TerminalInfo { id, shell, cwd }`
//! - `terminal_write` 接收键盘输入（字符串），`terminal_resize` 同步行列
//! - 输出经 `terminal://output` 事件回传（base64，前端解码为 Uint8Array 交给 xterm，
//!   避免 UTF-8 在分块边界被截断）
//! - 进程退出经 `terminal://exit` 事件回传
//! - `terminal_run_code` / `terminal_run_curl` 把命令写入现有 shell（VSCode Code Runner 语义）
//!
//! 安全：终端是任意命令执行入口（非沙箱），与 Code Run 的既有语义一致。
//! `terminal_run_code` 仍校验文件路径在 PathGuard 范围内；终端内自行 `cd` 不受限制。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::paths::PathGuard;
use crate::commands::run::{
    command_spec, render_shell_line, shell_kind, CommandSpec, RunSource, ShellKind,
};

/// 终端输出事件
pub const OUTPUT_EVENT: &str = "terminal://output";
/// 终端进程退出事件
pub const EXIT_EVENT: &str = "terminal://exit";
/// 单次输入上限（防大段粘贴撑爆后端）
const MAX_INPUT_BYTES: usize = 1024 * 1024;

/// PowerShell 启动时把控制台输入/输出切到 UTF-8，避免中文乱码
#[cfg(windows)]
const POWERSHELL_UTF8_INIT: &str = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false)";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    /// shell 展示名（powershell / pwsh / bash…）
    pub shell: String,
    pub cwd: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalChunk {
    id: String,
    /// base64 编码的输出字节
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    id: String,
    code: Option<i32>,
}

/// 终端应用状态：同一时刻只保留一个会话
#[derive(Default)]
pub struct TerminalState {
    slot: Arc<Mutex<Option<Session>>>,
    seq: Arc<AtomicU64>,
}

struct Session {
    id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    shell_kind: ShellKind,
}

fn default_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string())
}

/// PATH 中查找可执行文件（Windows 自动检测 pwsh 用）
#[cfg(windows)]
fn find_in_path(exe: &str) -> Option<String> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

#[cfg(windows)]
fn find_pwsh() -> Option<String> {
    if let Some(path) = find_in_path("pwsh.exe") {
        return Some(path);
    }
    let program_files = std::env::var_os("ProgramFiles")?;
    let candidate = PathBuf::from(program_files)
        .join("PowerShell")
        .join("7")
        .join("pwsh.exe");
    candidate
        .is_file()
        .then(|| candidate.to_string_lossy().into_owned())
}

/// shell 与启动参数：空串 = 自动检测
fn resolve_shell(requested: &str) -> (String, Vec<String>, String) {
    let requested = requested.trim();
    #[cfg(windows)]
    {
        let program = if !requested.is_empty() {
            requested.to_string()
        } else if let Some(pwsh) = find_pwsh() {
            pwsh
        } else {
            "powershell.exe".to_string()
        };
        let mut args = Vec::new();
        if shell_kind(&program) == ShellKind::PowerShell {
            args = vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                POWERSHELL_UTF8_INIT.to_string(),
            ];
        }
        let label = Path::new(&program)
            .file_stem()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_else(|| program.clone());
        (program, args, label)
    }
    #[cfg(not(windows))]
    {
        let program = if !requested.is_empty() {
            requested.to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        };
        let label = Path::new(&program)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| program.clone());
        (program, Vec::new(), label)
    }
}

/// 创建终端会话（会先结束旧会话）。cwd 无效时回退到进程当前目录。
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: tauri::State<TerminalState>,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    let (program, args, shell_label) = resolve_shell(&shell);
    let requested_cwd = PathBuf::from(cwd.trim());
    let cwd = if cwd.trim().is_empty() || !requested_cwd.is_dir() {
        default_cwd()
    } else {
        requested_cwd.to_string_lossy().into_owned()
    };

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建终端失败: {e}"))?;

    let mut cmd = CommandBuilder::new(&program);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "my-editor");
    cmd.env("PYTHONIOENCODING", "utf-8");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动终端失败（{program}）: {e}"))?;
    drop(pair.slave);
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let _ = child.kill();
            return Err(format!("读取终端输出失败: {e}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let _ = child.kill();
            return Err(format!("写入终端失败: {e}"));
        }
    };

    let id = format!("term-{}", state.seq.fetch_add(1, Ordering::Relaxed) + 1);
    let info = TerminalInfo {
        id: id.clone(),
        shell: shell_label.clone(),
        cwd: cwd.clone(),
    };
    let session = Session {
        id: id.clone(),
        master: pair.master,
        writer,
        child,
        shell_kind: shell_kind(&program),
    };

    // 新会话就绪后再替换旧会话；替换出来的旧会话在锁外结束，避免持锁做 taskkill
    let old = {
        let mut guard = state.slot.lock().unwrap_or_else(|e| e.into_inner());
        guard.replace(session)
    };
    if let Some(mut old) = old {
        kill_session(&mut old);
    }

    spawn_reader(app.clone(), id.clone(), reader);
    spawn_reaper(app, Arc::clone(&state.slot), id);
    Ok(info)
}

#[tauri::command]
pub fn terminal_write(
    state: tauri::State<TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_INPUT_BYTES {
        return Err("终端输入过长".to_string());
    }
    let mut guard = state.slot.lock().unwrap_or_else(|e| e.into_inner());
    let session = guard.as_mut().ok_or_else(|| "终端未启动".to_string())?;
    if session.id != id {
        return Err("终端会话已变更，请重新打开终端".to_string());
    }
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("写入终端失败: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("写入终端失败: {e}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut guard = state.slot.lock().unwrap_or_else(|e| e.into_inner());
    let session = guard.as_mut().ok_or_else(|| "终端未启动".to_string())?;
    if session.id != id {
        return Err("终端会话已变更，请重新打开终端".to_string());
    }
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端尺寸失败: {e}"))
}

/// 关闭终端会话；id 为空串时关闭当前会话
///
/// 结束 ConPTY 子进程要等 taskkill 返回，应用退出流程也会调用本命令，
/// 因此放到阻塞线程执行，避免占住主线程让窗口「未响应」。
#[tauri::command]
pub async fn terminal_close(state: tauri::State<'_, TerminalState>, id: String) -> Result<(), String> {
    let slot = state.slot.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = guard.as_mut() else {
            return;
        };
        if !id.is_empty() && session.id != id {
            return;
        }
        kill_session(session);
        *guard = None;
    })
    .await
    .map_err(|e| format!("关闭终端失败: {e}"))
}

/// 在终端中运行当前文件（PowerShell/POSIX 引号规则由 Rust 侧处理）
#[tauri::command]
pub fn terminal_run_code(
    state: tauri::State<TerminalState>,
    guard: tauri::State<PathGuard>,
    id: String,
    path: String,
    runner: String,
) -> Result<(), String> {
    let target = guard.ensure_file_scope(&path)?;
    if !target.is_file() {
        return Err(format!("文件不存在: {path}"));
    }
    let spec = command_spec(&runner, RunSource::File(&target))?;
    write_command(&state, &id, &spec)
}

/// 在终端中执行 cURL 脚本（内容而非路径）
#[tauri::command]
pub fn terminal_run_curl(
    state: tauri::State<TerminalState>,
    id: String,
    script: String,
) -> Result<(), String> {
    let spec = command_spec("curl", RunSource::Script(&script))?;
    write_command(&state, &id, &spec)
}

fn write_command(
    state: &tauri::State<TerminalState>,
    id: &str,
    spec: &CommandSpec,
) -> Result<(), String> {
    let mut guard = state.slot.lock().unwrap_or_else(|e| e.into_inner());
    let session = guard.as_mut().ok_or_else(|| "终端未启动".to_string())?;
    if session.id != id {
        return Err("终端会话已变更，请重新打开终端".to_string());
    }
    let line = render_shell_line(session.shell_kind, spec)?;
    session
        .writer
        .write_all(line.as_bytes())
        .and_then(|_| session.writer.write_all(b"\r"))
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("写入终端失败: {e}"))
}

fn kill_session(session: &mut Session) {
    #[cfg(windows)]
    {
        if let Some(pid) = session.child.process_id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
    }
    let _ = session.child.kill();
}

/// 读取线程：输出按字节 base64 回传，前端交给 xterm 解码。
/// 每次读取即发送（8KB），保证提示符 / 单字符输入的延迟；高速输出由 xterm 自身缓冲。
fn spawn_reader(app: AppHandle, id: String, mut reader: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app.emit(
                        OUTPUT_EVENT,
                        TerminalChunk {
                            id: id.clone(),
                            data: STANDARD.encode(&buf[..n]),
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
}

/// 守望线程：轮询退出状态并推送 `terminal://exit`
fn spawn_reaper(app: AppHandle, slot: Arc<Mutex<Option<Session>>>, id: String) {
    std::thread::spawn(move || loop {
        let finished: Option<Option<i32>> = {
            let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            let Some(session) = guard.as_mut() else {
                return;
            };
            if session.id != id {
                return;
            }
            match session.child.try_wait() {
                Ok(Some(status)) => Some(Some(status.exit_code() as i32)),
                Ok(None) => None,
                Err(_) => Some(None),
            }
        };
        if let Some(code) = finished {
            {
                let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
                if guard.as_ref().map(|s| s.id == id).unwrap_or(false) {
                    *guard = None;
                }
            }
            let _ = app.emit(EXIT_EVENT, TerminalExit { id, code });
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_shell_never_returns_empty_program() {
        let (program, args, label) = resolve_shell("");
        assert!(!program.trim().is_empty());
        assert!(!label.is_empty());
        // Windows 默认 PowerShell 会带 UTF-8 初始化参数
        #[cfg(windows)]
        if shell_kind(&program) == ShellKind::PowerShell {
            assert!(args.iter().any(|a| a == "-NoLogo"));
            assert!(args.iter().any(|a| a.contains("UTF8Encoding")));
        }
    }

    #[test]
    fn default_cwd_is_not_empty() {
        assert!(!default_cwd().is_empty());
    }
}
