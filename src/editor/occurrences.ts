import { highlightSelectionMatches } from "@codemirror/search";
import type { Extension } from "@codemirror/state";

/**
 * 选中即高亮同名（设计文档 3.1）：
 * 选中文本后，文档内其余相同文本自动高亮。原生能力，零成本。
 */
export function occurrences(): Extension {
  return highlightSelectionMatches();
}
