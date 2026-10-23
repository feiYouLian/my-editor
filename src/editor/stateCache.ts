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
const STATE_CACHE_LIMIT = 16;
/** 单文档缓存体积上限（字节） */
const STATE_CACHE_MAX_BYTES = 5 * 1024 * 1024;

export class DocumentStateCache {
  private cache = new Map<string, CachedState>();

  get(key: string): CachedState | undefined {
    return this.cache.get(key);
  }

  /** 写入并淘汰最旧条目；超大文档直接跳过 */
  set(key: string, entry: Omit<CachedState, "state"> & { state: EditorState }): void {
    if (entry.state.doc.length > STATE_CACHE_MAX_BYTES) return;
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > STATE_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  delete(key: string): void {
    this.cache.delete(key);
  }
}
