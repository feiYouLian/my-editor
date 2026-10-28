/**
 * 最近消息环形缓冲（内存态，20 条）。
 *
 * 状态栏瞬时消息 3–8 秒即消失，而「刚才那句提示到底说的是什么」是最常见的
 * 回看需求。这里只留最近若干条供通知面板展示：不落盘、不分类、不参与
 * ⚠ 角标计数——需要用户处理的事仍然走 `app/noticeStore`。
 *
 * 放在 core 而不是 app：statusBar（ui 层）与 noticePanel（panels 层）都要读，
 * 而 ui 不允许依赖 app。
 */

const MAX_MESSAGES = 20;

export interface LoggedMessage {
  id: number;
  text: string;
  /** 记录时刻（epoch ms），面板里格式化为 HH:MM:SS */
  at: number;
}

const items: LoggedMessage[] = [];
const listeners = new Set<() => void>();
let seq = 0;

/** 追加一条；连续重复（如「正在格式化，请稍候…」）只刷新时间，不堆条目 */
export function recordMessage(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const head = items[0];
  if (head && head.text === trimmed) {
    head.at = Date.now();
    emit();
    return;
  }
  items.unshift({ id: ++seq, text: trimmed, at: Date.now() });
  if (items.length > MAX_MESSAGES) items.length = MAX_MESSAGES;
  emit();
}

export function listMessages(): readonly LoggedMessage[] {
  return items;
}

export function clearMessages(): void {
  items.length = 0;
  emit();
}

export function subscribeMessages(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}
