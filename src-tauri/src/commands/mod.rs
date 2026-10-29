//! Tauri 命令层。
//!
//! 进程类命令统一走 [`no_console`]：GUI 子系统进程（本应用）spawn 控制台程序时，
//! Windows 会为子进程新建一个控制台窗口——表现为桌面不断闪烁黑框。

pub mod batch;
pub mod clipboard;
pub mod config;
pub mod diff;
pub mod encoding;
pub mod fetch;
pub mod file;
pub mod format;
pub mod fs;
pub mod git;
pub mod large;
pub mod paths;
pub mod run;
pub mod search;
pub mod session;
pub mod startup;
pub mod terminal;
pub mod watch;
pub mod workspace;

/// 给子进程加 `CREATE_NO_WINDOW`，避免 GUI 程序 spawn 控制台程序时闪出黑框。
///
/// 本应用是 `windows_subsystem = "windows"` 的 GUI 进程，自身没有控制台；
/// 此时哪怕 stdout/stderr 已被管道接管，Windows 仍会为 console 子进程
/// （git / cmd / taskkill / 格式化工具 / 脚本运行器）新建控制台窗口。
/// 非 Windows 平台为空操作。
#[cfg(windows)]
pub(crate) fn no_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    /// 不创建控制台窗口
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub(crate) fn no_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}
