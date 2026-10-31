/**
 * per-workspace 设置的 IPC 薄封装。
 *
 * 数据落在 `<应用配置目录>/workspaces/<hash>.json`（Rust 侧决定），
 * **不写进用户仓库**；读失败/损坏按"无覆盖"处理，不阻塞打开工作区。
 */

import { invoke } from "@tauri-apps/api/core";
import { normalizeOverrides, type WorkspaceOverrides } from "../core/workspaceOverrides";

export type { WorkspaceOverrides };

/** 读取工作区覆盖（不存在或损坏返回空对象） */
export async function loadWorkspaceOverrides(root: string): Promise<WorkspaceOverrides> {
  try {
    const raw = await invoke<WorkspaceOverrides>("load_workspace_overrides", { root });
    return normalizeOverrides(raw);
  } catch (e) {
    // 读不到只影响"是否带覆盖"，不该打断工作区切换
    console.warn("[workspace] 读取工作区设置失败", e);
    return {};
  }
}

/**
 * 保存工作区覆盖；全部为空时后端会删除文件（回到跟随全局）。
 * 返回归一化后的值：调用方据此热应用，避免内存与磁盘不一致。
 */
export async function saveWorkspaceOverrides(
  root: string,
  overrides: WorkspaceOverrides,
): Promise<WorkspaceOverrides> {
  const payload = normalizeOverrides({ ...overrides, root });
  await invoke("save_workspace_overrides", { root, overrides: payload });
  return payload;
}
