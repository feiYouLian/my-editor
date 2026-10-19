import { invoke } from "@tauri-apps/api/core";

/**
 * 会话与草稿服务：
 * - session.json：打开的文件（含光标位置）、激活文件、分栏比例
 * - drafts/：未保存内容的防抖草稿（配置目录），按 key 索引
 */

export interface SessionFile {
  path: string;
  /** 光标行（1 基） */
  line: number;
  /** 光标列（1 基） */
  col: number;
}

export interface SessionState {
  openFiles: SessionFile[];
  activeFile: string | null;
  splitRatio: number | null;
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

/** 防抖保存会话（标签切换/光标移动频繁触发时合并请求） */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function saveSessionDebounced(state: SessionState, delay = 400): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveSession(state).catch((e) => console.warn("[session] 保存失败", e));
  }, delay);
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
