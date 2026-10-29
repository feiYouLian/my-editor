/**
 * 大纲的行级解析（纯函数，无 CodeMirror 依赖，便于单测）。
 *
 * 只处理 Markdown 标题：`#`~`######` + 至少一个空白 + 标题文本。
 * 代码语言的符号提取要走 `syntaxTree`，留在 panels/outlineView.ts（依赖 CM6 状态）。
 */

/** 标题文本最大长度：侧栏一行放不下更多，超出反而撑宽 */
const MAX_LABEL_CHARS = 120;

export interface MarkdownHeading {
  /** 标题文字（已 trim 并截断） */
  label: string;
  /** 层级深度：`#` = 0 */
  depth: number;
}

/**
 * 解析单行是否为 Markdown 标题；不是返回 null。
 * 注意 `#######`（7 个）不是标题——GitHub 与 CommonMark 都只认 1–6 个。
 */
export function parseMarkdownHeading(text: string): MarkdownHeading | null {
  // 行尾可能有 \r（CRLF 文档按行切分后残留）
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  const match = /^(#{1,6})\s+(.+)$/.exec(line);
  if (!match) return null;
  const label = match[2].trim();
  if (!label) return null;
  return {
    label: label.slice(0, MAX_LABEL_CHARS),
    depth: match[1].length - 1,
  };
}
