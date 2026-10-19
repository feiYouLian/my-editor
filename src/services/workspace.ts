import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * 工作区服务：打开目录 + 持久化根目录与展开状态。
 * 状态存 Rust 侧 workspace.json（Tauri 配置目录），启动时恢复。
 * 打开的文件列表与光标位置不在此文件，见 services/session.ts。
 */

export interface WorkspaceState {
  root: string | null;
  expanded: string[];
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
