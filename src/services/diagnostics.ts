/**
 * 本地日志 / 诊断（G4）：只写本地配置目录，不采集文件内容。
 * 日志写入失败必须静默：不能因为诊断本身影响主流程。
 */

import { invoke } from "@tauri-apps/api/core";
import { firstLine } from "../core/errors";

export type LogLevel = "info" | "warn" | "error";

/** 写入一条本地日志（失败忽略） */
export function logEvent(level: LogLevel, message: string, context?: string): void {
  void invoke("log_event", { level, message, context }).catch(() => {});
}

/** 记录异常：取首行，避免把多行堆栈塞进日志的一行 */
export function logError(message: string, error?: unknown): void {
  const detail =
    error === undefined
      ? ""
      : error instanceof Error
        ? error.stack ?? error.message
        : String(error);
  const first = detail ? firstLine(detail) : "";
  logEvent("error", message, first);
}

/** 打开日志目录（资源管理器） */
export async function openLogsDir(): Promise<void> {
  await invoke("open_logs_dir");
}

/** 导出诊断 JSON 并定位到文件；返回生成路径 */
export async function exportDiagnostics(): Promise<string> {
  const path = await invoke<string>("export_diagnostics");
  try {
    await invoke("reveal_in_file_manager", { path });
  } catch {
    // 定位失败不影响导出本身
  }
  return path;
}
