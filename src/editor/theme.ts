import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

import type { EditorThemeSetting } from "../config/settings";

/**
 * 编辑器主题工厂（设置中心 B7，见设计文档 15.2）。
 * 应用 UI 主题走 CSS 变量（main.css :root[data-theme]），编辑器语法主题在此切换：
 * - dark：one-dark（默认）
 * - light：CM6 默认浅色高亮 + 浅色结构底
 * - high-contrast：one-dark 语法色 + 纯黑高对比结构底（黑底白字、强选区）
 *
 * 字号等布局项由 baseLayout 统一提供（随配置热更新）。
 */

/** 浅色结构底（置于语法主题之后，保证结构色覆盖） */
const lightBase = EditorView.theme(
  {
    "&": { color: "#1f2328", backgroundColor: "#ffffff" },
    ".cm-content": { caretColor: "#1f2328" },
    ".cm-gutters": { backgroundColor: "#f6f8fa", color: "#8c959f" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#cce5ff",
    },
    ".cm-activeLine": { backgroundColor: "#f6f8fa" },
    ".cm-activeLineGutter": { backgroundColor: "#f6f8fa" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#1f2328" },
  },
  { dark: false },
);

/** 高对比结构底：纯黑背景 + 白字 + 强选区（复用 one-dark 语法色，置于其后覆盖结构） */
const highContrastBase = EditorView.theme(
  {
    "&": { backgroundColor: "#000000" },
    ".cm-content": { caretColor: "#ffffff" },
    ".cm-gutters": { backgroundColor: "#000000", color: "#ffffff", borderRight: "1px solid #5a5a5a" },
    ".cm-activeLine": { backgroundColor: "#161616" },
    ".cm-activeLineGutter": { backgroundColor: "#161616" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#0e639c",
    },
  },
  { dark: true },
);

/** 布局底：字号 / 字体 / gutter / 空白字符 / 书签 gutter（与语法主题叠加） */
function baseLayout(fontSize: number): Extension {
  return EditorView.theme({
    // 不覆盖背景色：dark 用 one-dark 原生 #282c34；light/high-contrast 由各自结构底提供
    "&": { height: "100%", fontSize: `${fontSize}px` },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
      overflow: "auto",
    },
    ".cm-content": { padding: "8px 0", maxWidth: "100%" },
    ".cm-gutters": {
      borderRight: "1px solid var(--border)",
      // 背景色由各语法主题自带的 gutter 规则提供（dark=one-dark、light/hc=结构底）
    },
    // 空白字符显示（highlightWhitespace 的类，见 setup.ts）
    ".cm-highlightSpace": { background: "rgba(158, 168, 190, 0.25)" },
    ".cm-highlightTab": { background: "rgba(158, 168, 190, 0.35)" },
    // 书签 gutter
    "& .cm-bookmark-gutter": { width: "22px", minWidth: "22px" },
    ".cm-bookmark": { color: "#ffcc66", cursor: "pointer", fontSize: "12px" },
  });
}

/** 按语法主题类型生成编辑器扩展。
 *  顺序即 CM6 扩展优先级（靠前者高）：结构底在最前，确保背景/选区色覆盖语法主题。 */
export function editorThemeFor(kind: EditorThemeSetting, fontSize: number): Extension[] {
  switch (kind) {
    case "light":
      return [lightBase, baseLayout(fontSize), syntaxHighlighting(defaultHighlightStyle)];
    case "high-contrast":
      return [highContrastBase, baseLayout(fontSize), oneDark];
    default:
      return [baseLayout(fontSize), oneDark];
  }
}
