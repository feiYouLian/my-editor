import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * 工作区服务（设计文档 3.10 轻量版）：
 * 打开目录 + 持久化根目录/展开状态/打开文件列表。
 * 状态存 Rust 侧 workspace.json（Tauri 配置目录），启动时恢复。
 */

export interface WorkspaceState {
  root: string | null;
  expanded: string[];
  open_files: string[];
  active_file: string | null;
}

export async function loadWorkspace(): Promise<WorkspaceState> {
  return invoke<WorkspaceState>("load_workspace");
}

export async function saveWorkspace(state: WorkspaceState): Promise<void> {
  await invoke("save_workspace", { state });
}

/** 弹出目录选择对话框 */
export async function pickDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** 防抖保存（展开状态频繁变更时合并请求） */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function saveWorkspaceDebounced(state: WorkspaceState, delay = 300): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveWorkspace(state).catch((e) => console.warn("[workspace] 保存失败", e));
  }, delay);
}
