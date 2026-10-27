/**
 * 轻量通知中心（内存态）。
 *
 * 为什么需要：状态栏消息 3 秒就没了，失败与"待处理"提示错过就找不回来。
 * 这里只做**聚合 + 回看 + 一键动作**，不轮询、不持久化、上限 50 条 ——
 * 关掉应用就清空，避免变成第二套日志系统。
 */

export type NoticeKind = "external" | "saveFail" | "formatFail" | "gitFail";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  actions: NoticeAction[];
}

const MAX_NOTICES = 50;

const notices: Notice[] = [];
const listeners = new Set<() => void>();
let seq = 0;

export const NOTICE_LABELS: Record<NoticeKind, string> = {
  external: "外部修改",
  saveFail: "保存失败",
  formatFail: "格式化失败",
  gitFail: "Git 失败",
};

function emit(): void {
  for (const listener of listeners) listener();
}

/** 追加一条（同文案的旧条目会被移除，避免重复刷屏） */
export function addNotice(
  kind: NoticeKind,
  text: string,
  actions: NoticeAction[] = [],
  dedupeKey?: string,
): number {
  if (dedupeKey) {
    const existing = notices.findIndex((n) => n.kind === kind && n.text === text);
    if (existing >= 0) notices.splice(existing, 1);
  }
  const id = ++seq;
  notices.unshift({ id, kind, text, actions });
  if (notices.length > MAX_NOTICES) notices.length = MAX_NOTICES;
  emit();
  return id;
}

export function removeNotice(id: number): void {
  const index = notices.findIndex((n) => n.id === id);
  if (index < 0) return;
  notices.splice(index, 1);
  emit();
}

export function clearNotices(): void {
  if (notices.length === 0) return;
  notices.length = 0;
  emit();
}

export function listNotices(): readonly Notice[] {
  return notices;
}

export function subscribeNotices(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
