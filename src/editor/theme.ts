import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t, type Tag } from "@lezer/highlight";

import { findUserTheme, type EditorThemeSetting } from "../config/settings";
import {
  customThemeName,
  SYNTAX_KEYS,
  type SyntaxKey,
  type UserTheme,
} from "../config/userThemes";

/**
 * 编辑器主题工厂：按主题类别与字号组装编辑器扩展。
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
    // 底部留白（scrollPastEnd）：光标停在最后一行时也能滚到视口中部，
    // 否则写文档末尾会一直贴着底边。纯样式实现，不新增扩展。
    ".cm-content": { padding: "8px 0 40vh", maxWidth: "100%" },
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
    // 补全弹窗：CM 默认选中项用系统 Highlight 色，深色主题下常常几乎看不见，
    // 导致"不知道回车会插入哪一条"。改成强调色实底 + 白字，并把行高放宽。
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      padding: "3px 8px",
      lineHeight: "1.4",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--accent)",
      color: "#ffffff",
    },
    // 命中前缀再加粗，同一个候选里"为什么它排第一"也能看出来
    ".cm-completionMatchedText": {
      textDecoration: "none",
      fontWeight: "700",
    },
  });
}

/** 配色键名 → @lezer/highlight 的 tag（与 config/userThemes.ts 的 SYNTAX_KEYS 一一对应） */
const SYNTAX_TAGS: Record<SyntaxKey, Tag> = {
  keyword: t.keyword,
  string: t.string,
  number: t.number,
  comment: t.comment,
  variableName: t.variableName,
  function: t.function(t.variableName),
  typeName: t.typeName,
  propertyName: t.propertyName,
  operator: t.operator,
  bracket: t.bracket,
  tagName: t.tagName,
  attributeName: t.attributeName,
  heading: t.heading,
  link: t.link,
  invalid: t.invalid,
};

/**
 * 自定义主题（themes/<名字>.json）→ 编辑器扩展。
 * ui 省略的项沿用该主题 dark 标记决定的兜底色，不继承上一个主题（切主题不该藕断丝连）。
 */
export function customThemeExtensions(theme: UserTheme, fontSize: number): Extension[] {
  const ui = theme.ui;
  const fallbackText = theme.dark ? "#e6e6e6" : "#1f2328";
  const fallbackBack = theme.dark ? "#1e1e2e" : "#ffffff";
  const fallbackGutter = theme.dark ? "#181818" : "#f6f8fa";
  const text = ui.foreground ?? fallbackText;
  const back = ui.background ?? fallbackBack;
  const exts: Extension[] = [
    EditorView.theme(
      {
        "&": { color: text, backgroundColor: back },
        ".cm-content": { caretColor: ui.caret ?? text },
        ".cm-gutters": {
          backgroundColor: ui.gutterBackground ?? fallbackGutter,
          color: ui.gutterForeground ?? (theme.dark ? "#8a8a8a" : "#8c959f"),
          borderRight: "1px solid var(--border)",
        },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
          backgroundColor: ui.selection ?? (theme.dark ? "#264f78" : "#cce5ff"),
        },
        ".cm-activeLine": { backgroundColor: ui.activeLine ?? "transparent" },
        ".cm-activeLineGutter": { backgroundColor: ui.activeLine ?? "transparent" },
      },
      { dark: theme.dark },
    ),
    baseLayout(fontSize),
  ];

  const specs = SYNTAX_KEYS.filter((key) => theme.syntax[key]).map((key) => ({
    tag: SYNTAX_TAGS[key],
    color: theme.syntax[key] as string,
  }));
  exts.push(
    specs.length > 0
      ? syntaxHighlighting(HighlightStyle.define(specs))
      : syntaxHighlighting(defaultHighlightStyle),
  );
  return exts;
}

/** 按语法主题类型生成编辑器扩展。
 *  顺序即 CM6 扩展优先级（靠前者高）：结构底在最前，确保背景/选区色覆盖语法主题。 */
export function editorThemeFor(kind: EditorThemeSetting, fontSize: number): Extension[] {
  if (kind === "light") {
    return [lightBase, baseLayout(fontSize), syntaxHighlighting(defaultHighlightStyle)];
  }
  if (kind === "high-contrast") {
    return [highContrastBase, baseLayout(fontSize), oneDark];
  }
  const customName = customThemeName(kind);
  if (customName) {
    const theme = findUserTheme(customName);
    // 主题文件被删 / 改名：回退深色渲染，但**不复位配置值**——
    // 文件放回来后无需再设置一次；缺失原因在启动与设置页各自提示。
    if (theme) return customThemeExtensions(theme, fontSize);
  }
  return [baseLayout(fontSize), oneDark];
}
