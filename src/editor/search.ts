import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * 查找替换集成（设计文档 3.4）：
 * - @codemirror/search 提供：查找替换面板（底部）、增量搜索、
 *   正则捕获组替换（$1/$0）、In Selection 开关——均为原生能力（spike 结论）
 * - 自定义部分：搜索结果面板（searchPanel.ts）与书签（bookmarks.ts）
 */
export function searchExtensions(): Extension[] {
  return [
    search({ top: false }),
    keymap.of(searchKeymap),
  ];
}
