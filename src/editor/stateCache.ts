/**
 * 每标签独立的编辑状态缓存：恢复时保住各自的撤销历史 / 光标，
 * 避免跨标签串台。超大文档不缓存，防止多标签叠加占用内存。
 */

import type { EditorState } from "@codemirror/state";

export interface CachedState {
  state: EditorState;
  /** 缓存时的配置代数：代数一致说明无需重新配置扩展 */
  generation: number;
  /** 该状态实际生效的高亮语言（null = 纯文本 / 被性能保护禁用） */
  langKey: string | null;
  readonly: boolean;
}

/** 缓存条数上限 */
const STATE_CACHE_LIMIT = 8;
/** 单文档缓存体积上限（字节）：文档文本 + 语法树 + 撤销历史叠加后约为文本的 2–3 倍 */
const STATE_CACHE_MAX_BYTES = 2 * 1024 * 1024;

export class DocumentStateCache {
  private cache = new Map<string, CachedState>();
  /** 超限文档不缓存 EditorState，但保留光标：切回时不该跳回文首 */
  private cursors = new Map<string, number>();
  /**
   * 「确实丢了撤销历史」的文档。
   *
   * 只有**本来有历史、现在拿不到**才算丢：超大文档切走时拒绝了缓存、或缓存超 8 条被淘汰。
   * 用这个集合决定要不要提示，而不是"缓存里没有就提示"——
   * 后者会导致每次打开文件都报一次「撤销历史已释放」，而首次打开时根本无历史可丢。
   */
  private lost = new Set<string>();

  get(key: string): CachedState | undefined {
    return this.cache.get(key);
  }

  /** 写入并淘汰最旧条目；超大文档只记光标，不保留状态 */
  set(key: string, entry: Omit<CachedState, "state"> & { state: EditorState }): void {
    if (entry.state.doc.length > STATE_CACHE_MAX_BYTES) {
      this.cursors.set(key, entry.state.selection.main.head);
      this.cache.delete(key);
      // 刚才这个文档在编辑器里是有撤销历史的，但体积超限存不下 → 历史确实被释放了
      this.lost.add(key);
      return;
    }
    this.cursors.delete(key);
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.lost.delete(key);
    while (this.cache.size > STATE_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.lost.add(oldest);
    }
  }

  /** 取出并清除「撤销历史已丢失」标记（每个文档只应提示一次，调用方另有去重） */
  takeLost(key: string): boolean {
    return this.lost.delete(key);
  }

  /** 取出并清除超限文档记录的光标位置 */
  takeCursor(key: string): number | undefined {
    const head = this.cursors.get(key);
    this.cursors.delete(key);
    return head;
  }

  delete(key: string): void {
    this.cache.delete(key);
    this.cursors.delete(key);
  }
}
