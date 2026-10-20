import { search, searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";

/**
 * 查找替换集成：
 * - @codemirror/search 提供：查找替换面板（底部）、增量搜索、
 *   正则捕获组替换（$1/$0）、In Selection 开关——均为 @codemirror/search 原生能力
 * - 面板外观：文案在此中文化（下方 phrases），配色由 main.css 按应用主题变量覆盖
 * - 自定义部分：搜索结果面板（searchPanel.ts）与书签（bookmarks.ts）
 */

/** @codemirror/search 面板文案（默认英文，键名与库内 phrase() 调用一一对应） */
const SEARCH_PHRASES = {
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全选匹配",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "全词",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  // 读屏播报文案（$ 由库替换为数量 / 行号）
  "current match": "当前匹配",
  "on line": "位于行",
  "replaced $ matches": "已替换 $ 处",
  "replaced match on line $": "已替换第 $ 行",
};

export function searchExtensions(): Extension[] {
  return [
    search({ top: false }),
    keymap.of(searchKeymap),
    EditorState.phrases.of(SEARCH_PHRASES),
  ];
}
