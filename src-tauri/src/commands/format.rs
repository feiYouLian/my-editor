//! CLI 格式化通道
//! Rust 侧 spawn 外部 CLI 工具：stdin 喂内容、stdout 收结果、5s 超时中断。
//! 覆盖 Prettier 生态之外的语言：Black / gofmt / rustfmt /
//! google-java-format / clang-format。
//!
//! 安全模型（重要）：工具与参数一律在后端按「语言键」从 config.json 的
//! formatters 表解析，前端只传语言键 + 内容。若允许前端指定 tool/args，
//! WebView 内任意脚本（XSS、被污染的预览内容）即可借该命令以用户权限
//! 启动任意程序（RCE）。

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// 格式化超时（超时即中断子进程）
const FORMAT_TIMEOUT_SECS: u64 = 5;

/// 未命名文档的合成扩展名（供 clang-format -assume-filename 定位 .clang-format）
fn synthetic_ext(language_key: &str) -> &'static str {
    match language_key {
        "python" => "py",
        "go" => "go",
        "rust" => "rs",
        "java" => "java",
        "cpp" => "cpp",
        _ => "txt",
    }
}

/// 拒绝可写文件 / 读取外部配置的危险参数（纵深防御，正常模板不会命中）
fn is_rejected_arg(arg: &str) -> bool {
    let lower = arg.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "-o" | "-i" | "--in-place" | "--output" | "--config" | "-config"
    ) || lower.starts_with("--output=")
        || lower.starts_with("--config=")
        || lower.starts_with("-o=")
        || lower.starts_with("-config=")
}

/// 运行 CLI 格式化工具：按语言键解析配置，content 经 stdin 传入，返回 stdout 内容
#[tauri::command]
pub async fn run_cli_formatter(
    app: tauri::AppHandle,
    language_key: String,
    file_path: Option<String>,
    content: String,
) -> Result<String, String> {
    // 工具/参数只信后端配置：前端只传语言键，杜绝任意命令执行
    let entry = crate::commands::config::load_config(app)
        .formatters
        .get(&language_key)
        .cloned()
        .ok_or_else(|| format!("语言「{language_key}」未配置 CLI 格式化器"))?;
    let tool = entry.tool.trim().to_string();
    if tool.is_empty() {
        return Err(format!("语言「{language_key}」的格式化工具未配置"));
    }
    let assume_name = file_path
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| format!("untitled.{}", synthetic_ext(&language_key)));
    // Rust 的 String::replace 无 $ 特殊语义，路径含 $&/$1 不会破坏参数
    let args: Vec<String> = entry
        .args
        .iter()
        .map(|a| a.replace("__PLACEHOLDER__", &assume_name))
        .collect();
    if let Some(bad) = args.iter().find(|a| is_rejected_arg(a)) {
        return Err(format!(
            "参数「{bad}」被安全策略拒绝（不允许写文件或读取外部配置）"
        ));
    }
    tauri::async_runtime::spawn_blocking(move || run_blocking(&tool, &args, &content))
        .await
        .map_err(|e| format!("任务调度失败: {e}"))?
}

/// Windows 下 .cmd/.bat 包装脚本必须经 cmd /C 调用（Rust 直接 spawn 会失败）
#[cfg(windows)]
fn build_command(tool: &str, args: &[String]) -> Command {
    let lower = tool.to_lowercase();
    let mut cmd = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(tool).args(args);
        cmd
    } else {
        let mut cmd = Command::new(tool);
        cmd.args(args);
        cmd
    };
    // 工具与 cmd /C 都是控制台程序：不隐藏会闪黑框
    crate::commands::no_console(&mut cmd);
    cmd
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
