import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** 主题：one-dark 打底 + 布局微调（撑满编辑区、等宽字体、与整体暗色 UI 一致） */
export const editorTheme: Extension[] = [
  oneDark,
  EditorView.theme({
    // 不覆盖背景色：使用 one-dark 原生 #282c34（更明亮，且保证语法色对比度）
    "&": { height: "100%", fontSize: "13px" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
      overflow: "auto",
    },
    ".cm-content": { padding: "8px 0", maxWidth: "100%" },
    ".cm-gutters": {
      borderRight: "1px solid var(--border)",
      backgroundColor: "var(--bg-panel)",
    },
    // 空白字符显示（highlightWhitespace 的类，见 setup.ts）
    ".cm-highlightSpace": { background: "rgba(158, 168, 190, 0.25)" },
    ".cm-highlightTab": { background: "rgba(158, 168, 190, 0.35)" },
    // 书签 gutter
    "& .cm-bookmark-gutter": { width: "22px", minWidth: "22px" },
    ".cm-bookmark": { color: "#ffcc66", cursor: "pointer", fontSize: "12px" },
  }),
];
