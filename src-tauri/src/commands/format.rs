//! CLI 格式化通道
//! Rust 侧 spawn 外部 CLI 工具：stdin 喂内容、stdout 收结果、5s 超时中断。
//! 覆盖 Prettier 生态之外的语言：Black / gofmt / rustfmt /
//! google-java-format / clang-format。
//!
//! 配置驱动（config.json → formatters）：{ tool, args }，
//! args 中的 __PLACEHOLDER__ 由前端替换为真实文件路径
//! （clang-format 的 -assume-filename 需要它才能找到 .clang-format）。

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// 格式化超时（超时即中断子进程）
const FORMAT_TIMEOUT_SECS: u64 = 5;

/// 运行 CLI 格式化工具：content 经 stdin 传入，返回 stdout 内容
#[tauri::command]
pub async fn run_cli_formatter(
    tool: String,
    args: Vec<String>,
    content: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_blocking(&tool, &args, &content))
        .await
        .map_err(|e| format!("任务调度失败: {e}"))?
}

/// Windows 下 .cmd/.bat 包装脚本必须经 cmd /C 调用（Rust 直接 spawn 会失败）
#[cfg(windows)]
fn build_command(tool: &str, args: &[String]) -> Command {
    let lower = tool.to_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(tool).args(args);
        cmd
    } else {
        let mut cmd = Command::new(tool);
        cmd.args(args);
        cmd
    }
}

#[cfg(not(windows))]
fn build_command(tool: &str, args: &[String]) -> Command {
    let mut cmd = Command::new(tool);
    cmd.args(args);
    cmd
}

fn run_blocking(tool: &str, args: &[String], content: &str) -> Result<String, String> {
    let mut cmd = build_command(tool, args);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "未找到格式化工具「{tool}」：请先安装该工具，或在 config.json 的 formatters 中配置完整路径"
            )
        } else {
            format!("启动工具「{tool}」失败: {e}")
        }
    })?;

    // 共享子进程句柄：超时由外层 kill（锁只在 take 管道和轮询时短暂持有）
    let child = Arc::new(Mutex::new(child));
    let worker_child = Arc::clone(&child);

    let input = content.to_string();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            // 取出管道句柄（不持锁做 IO，保证超时线程能拿到锁 kill）
            let (stdin_opt, mut stdout_opt, mut stderr_opt) = {
                let mut guard = worker_child.lock().unwrap_or_else(|e| e.into_inner());
                (guard.stdin.take(), guard.stdout.take(), guard.stderr.take())
            };

            if let Some(mut stdin) = stdin_opt {
                stdin
                    .write_all(input.as_bytes())
                    .map_err(|e| format!("写入 stdin 失败: {e}"))?;
                drop(stdin); // 关闭 stdin，通知工具输入结束
            }

            let mut stdout = String::new();
            if let Some(mut out) = stdout_opt.take() {
                out.read_to_string(&mut stdout)
                    .map_err(|e| format!("读取输出失败: {e}"))?;
            }

            let mut stderr = String::new();
            if let Some(mut err) = stderr_opt.take() {
                let _ = err.read_to_string(&mut stderr);
            }

            // 轮询等待退出（不持锁，超时线程才能 kill）
            let status = loop {
                {
                    let mut guard = worker_child.lock().unwrap_or_else(|e| e.into_inner());
                    match guard.try_wait() {
                        Ok(Some(status)) => break status,
                        Ok(None) => {}
                        Err(e) => return Err(format!("等待进程退出失败: {e}")),
                    }
                }
                thread::sleep(Duration::from_millis(20));
            };

            if !status.success() {
                let msg = stderr.trim();
                return Err(if msg.is_empty() {
                    format!("工具异常退出（退出码: {status}）")
                } else {
                    format!("工具报错: {msg}")
                });
            }
            Ok(stdout)
        })();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_secs(FORMAT_TIMEOUT_SECS)) {
        Ok(result) => result,
        Err(_) => {
            // 超时：终止子进程（已关闭 stdin，多数工具会自行退出，这里兜底 kill）
            if let Ok(mut guard) = child.lock() {
                let _ = guard.kill();
            }
            Err(format!("格式化超时（{FORMAT_TIMEOUT_SECS}s），已中断"))
        }
    }
}
