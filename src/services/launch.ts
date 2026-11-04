import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 命令行启动文件服务（对接 Rust cli.rs）。
 *
 * 来源：资源管理器「打开方式 ▸ my-editor」、把文件拖到 exe 上、应用已运行时
 * 再次用本程序打开文件（单实例插件把路径转发给已有进程）。
 */

/** 取走启动参数里的待打开文件（Rust 侧取完即清空） */
export function takePendingFiles(): Promise<string[]> {
  return invoke<string[]>("take_pending_files");
}

/** 取走启动参数里的工作区目录（命令行传目录时设置；取完即清空） */
export function takePendingWorkspace(): Promise<string | null> {
  return invoke<string | null>("take_pending_workspace");
}

/** 订阅「外部又送来了文件」（应用已在运行时再次打开） */
export function onOpenExternalFiles(cb: () => void): Promise<UnlistenFn> {
  return listen("open-files", () => cb());
}
