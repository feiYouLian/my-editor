//! 启动耗时采样。
//!
//! 前端 bootstrap 完成、首帧绘制后调用一次，把「进程启动 → 可交互」的耗时
//! 覆盖写到 `<配置目录>/startup.json`。**只保留最近一次**，不滚动、不增长，
//! 所以它不是通用日志（通用日志刻意未实现），只是让「启动快」成为一个
//! 用户可自查的数字，而不只是开发机上肉眼的感觉。

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// 进程启动时刻。用 `OnceLock` 而非 `manage`：不依赖 Builder，也便于单测。
static STARTED_AT: OnceLock<Instant> = OnceLock::new();

/// 记录进程启动时刻，必须在 `run()` 最开始调用一次（越早越准）。
pub fn mark_start() {
    let _ = STARTED_AT.set(Instant::now());
}

/// 进程启动到现在经过的毫秒数（未打点时返回 0）。
pub fn elapsed_ms() -> u64 {
    STARTED_AT
        .get()
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir)
}

/// 前端就绪：覆盖写 `startup.json`，返回耗时（毫秒）。
///
/// 写盘走 `spawn_blocking`：即使只有一个 <200 字节的文件，也不把阻塞 IO
/// 放在命令主体里（与项目其余写盘命令同一纪律）。
#[tauri::command]
pub async fn frontend_ready(app: tauri::AppHandle) -> Result<u64, String> {
    let ms = elapsed_ms();
    let written: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
        let dir = config_dir(&app)?;
        let recorded_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let body =
            format!("{{\"processToFrontendReadyMs\":{ms},\"recordedAtUnixMs\":{recorded_at}}}\n");
        std::fs::write(dir.join("startup.json"), body)
            .map_err(|e| format!("写入 startup.json 失败: {e}"))
    })
    .await
    .map_err(|e| format!("启动采样任务失败: {e}"))?;
    written?;
    Ok(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 未打点时不 panic（命令被误调用时应降级为 0，而不是崩）
    ///
    /// 注意：`OnceLock` 在进程内只生效一次，且测试并行执行，所以这里
    /// 不断言具体值——断言「已打点」会在别的测试先调用 `mark_start` 时失效。
    #[test]
    fn elapsed_ms_never_panics() {
        let _ = elapsed_ms();
    }

    /// mark_start 幂等：重复调用不 panic，且打点后耗时单调可用
    #[test]
    fn mark_start_is_idempotent() {
        mark_start();
        mark_start();
        // 不断言 > 0：Instant 精度足够但 as_millis 可能截断为 0
        assert!(elapsed_ms() < 60_000);
    }
}
