import { invoke } from "@tauri-apps/api/core";

/**
 * 会话与草稿服务：
 * - session.json：打开的文件（含光标位置与滚动偏移）、激活文件、分栏比例
 * - drafts/：未保存内容的防抖草稿（配置目录），按 key 索引
 */

export interface SessionFile {
  path: string;
  /** 光标行（1 基） */
  line: number;
  /** 光标列（1 基） */
  col: number;
  /** 书签行号（1 基，升序）；旧会话文件缺省为空 */
  bookmarks?: number[];
  /** 折叠区：[起始行, 结束行]（1 基）；旧会话文件缺省为空 */
  folds?: number[][];
  /** 关闭时的滚动位置（像素，0 = 顶部）；旧会话缺省为 undefined（回退到「让光标可见」） */
  scrollTop?: number;
  /** 关闭时该标签是否处于选中状态（重启后复原激活项） */
  active?: boolean;
}

export interface SessionState {
  openFiles: SessionFile[];
  activeFile: string | null;
  /** 关闭时选中的是未命名标签：记录其名称，草稿恢复后据此激活 */
  activeUntitledName?: string | null;
}

export interface DraftInfo {
  key: string;
  path: string | null;
  name: string;
  encoding: string;
  newline: string;
  hasBom: boolean;
  /** 草稿写入时间（秒） */
  savedAt: number;
  /** 原文件是否已变化（原文件缺失 / mtime / 大小 / 哈希不一致） */
  stale: boolean;
  /** 仅 readDraft 返回 */
  content?: string;
}

export interface DraftInput {
  key: string;
  path: string | null;
  name: string;
  content: string;
  encoding: string;
  newline: string;
  hasBom: boolean;
}

export function loadSession(): Promise<SessionState> {
  return invoke<SessionState>("load_session");
}

export async function saveSession(state: SessionState): Promise<void> {
  await invoke("save_session", { state });
}

export function writeDraft(draft: DraftInput): Promise<DraftInfo> {
  return invoke<DraftInfo>("write_draft", { draft });
}

export function listDrafts(): Promise<DraftInfo[]> {
  return invoke<DraftInfo[]>("list_drafts");
}

export function readDraft(key: string): Promise<DraftInfo | null> {
  return invoke<DraftInfo | null>("read_draft", { key });
}

export async function deleteDraft(key: string): Promise<void> {
  await invoke("delete_draft", { key });
}

export function cleanupDrafts(retentionDays: number): Promise<number> {
  return invoke<number>("cleanup_drafts", { retentionDays });
}
