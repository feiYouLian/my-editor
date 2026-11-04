//! 本地日志与诊断（G4）。
//!
//! 设计取舍：
//! - 不引入日志框架：只需要“最近发生了什么”，滚动文件 + 一条命令即可；
//! - 只写本地配置目录，不采集文件内容/路径列表之外的隐私数据；
//! - 前端未捕获异常、保存/格式化/Git 失败可由 UI 主动写入；
//! - `export_diagnostics` 生成一份可直接发给开发者的 JSON（版本/系统/日志尾部）。

use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
const LOG_DIR_NAME: &str = "logs";
const LOG_FILE: &str = "app.log";
/// 单文件上限；超过后 app.log → app.log.1 → app.log.2
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
/// 保留文件数（含当前文件）
const KEEP_FILES: usize = 3;
const MAX_LINE_CHARS: usize = 4000;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());
static HOOK_ONCE: Once = Once::new();

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn sanitize(value: &str) -> String {
    let one_line = value.replace(['\r', '\n'], "\\n");
    one_line.chars().take(MAX_LINE_CHARS).collect()
}

/// 应用启动时调用一次：确定日志目录并安装 panic hook。
pub fn init(app: &tauri::AppHandle) {
    let Ok(config_dir) = crate::commands::config::app_config_dir(app) else {
        return;
    };
    let dir = config_dir.join(LOG_DIR_NAME);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = LOG_DIR.set(dir);

    HOOK_ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            write_line("panic", &info.to_string(), None);
            previous(info);
        }));
    });
}

fn logs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::commands::config::app_config_dir(app)?.join(LOG_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    Ok(dir)
}

fn rotate_if_needed(dir: &Path) -> std::io::Result<()> {
    let current = dir.join(LOG_FILE);
    let Ok(meta) = fs::metadata(&current) else {
        return Ok(());
    };
    if meta.len() < MAX_LOG_BYTES {
        return Ok(());
    }
    // 丢弃最旧一份，其余整体后移
    let oldest = dir.join(format!("{LOG_FILE}.{}", KEEP_FILES - 1));
    let _ = fs::remove_file(&oldest);
    for index in (1..KEEP_FILES - 1).rev() {
        let from = dir.join(format!("{LOG_FILE}.{index}"));
        let to = dir.join(format!("{LOG_FILE}.{}", index + 1));
        if from.exists() {
            let _ = fs::rename(from, to);
        }
    }
    fs::rename(&current, dir.join(format!("{LOG_FILE}.1")))
}

fn append_line(dir: &Path, line: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    rotate_if_needed(dir)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(LOG_FILE))?;
    writeln!(file, "{line}")
}

fn write_line(level: &str, message: &str, context: Option<&str>) {
    let Some(dir) = LOG_DIR.get() else {
        return;
    };
    let mut line = format!("[{}] [{}] {}", now_ms(), level, sanitize(message));
    if let Some(ctx) = context.filter(|v| !v.trim().is_empty()) {
        line.push_str(" | ");
        line.push_str(&sanitize(ctx));
    }
    let _ = append_line(dir, &line);
}

/// 前端/后端主动写入日志；失败不抛给调用方（日志不能影响主流程）。
#[tauri::command]
pub fn log_event(
    app: tauri::AppHandle,
    level: String,
    message: String,
    context: Option<String>,
) -> Result<(), String> {
    if LOG_DIR.get().is_none() {
        // setup 之前调用（极早）：补一次初始化
        init(&app);
    }
    write_line(&level, &message, context.as_deref());
    Ok(())
}

/// 打开日志目录（资源管理器）。
#[tauri::command]
pub fn open_logs_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = logs_dir(&app)?;
    crate::commands::fs::reveal_path(&dir, false)
}

/// 导出诊断包：版本、系统、时间、日志尾部（不含用户文件内容）。
#[tauri::command]
pub fn export_diagnostics(app: tauri::AppHandle) -> Result<String, String> {
    let dir = logs_dir(&app)?;
    let log_path = dir.join(LOG_FILE);
    let mut tail = Vec::new();
    if let Ok(bytes) = fs::read(&log_path) {
        let start = bytes.len().saturating_sub(100 * 1024);
        tail.extend_from_slice(&bytes[start..]);
    }
    let payload = json!({
        "generatedAtMs": now_ms(),
        "version": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "configDir": crate::commands::config::app_config_dir(&app)
            .map(|p| p.to_string_lossy().to_string())
            .ok(),
        "logTail": String::from_utf8_lossy(&tail),
    });
    let out = dir.join(format!("diagnostics-{}.json", now_ms()));
    fs::write(&out, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写入诊断文件失败: {e}"))?;
    Ok(out.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("my_editor_log_test_{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_one_line_and_sanitizes_newlines() {
        let dir = temp_dir("write");
        append_line(&dir, "[1] [info] hello").unwrap();
        let text = fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert!(text.contains("hello"));
        assert_eq!(text.lines().count(), 1);
    }

    #[test]
    fn rotates_when_over_limit() {
        let dir = temp_dir("rotate");
        let log = dir.join(LOG_FILE);
        fs::write(&log, vec![b'x'; (MAX_LOG_BYTES as usize) + 1]).unwrap();
        append_line(&dir, "[2] [info] after").unwrap();

        assert!(dir.join(format!("{LOG_FILE}.1")).exists());
        let size = fs::metadata(&log).unwrap().len();
        assert!(size < MAX_LOG_BYTES);
    }

    #[test]
    fn sanitize_limits_length_and_flattens() {
        let text = sanitize("a\nb\rc");
        assert_eq!(text, "a\\nb\\nc");
        assert!(sanitize(&"x".repeat(MAX_LINE_CHARS + 100)).chars().count() <= MAX_LINE_CHARS);
    }
}
