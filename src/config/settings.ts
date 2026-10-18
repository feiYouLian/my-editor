/**
 * 阶段 1 硬编码默认值（与 config.json 字段一一对应）。
 * 配置后端（Rust 侧读取应用配置目录 config.json）在后续阶段接入，
 * 接入前所有编辑器模块从这里取配置。
 */

export type ColumnModifier = "Alt" | "Control" | "Shift" | "Meta";

export interface EditorSettings {
  theme: "dark";
  tabSize: number;
  insertSpaces: boolean;
  formatOnSave: boolean;
  /** 超过此行数禁用语法高亮并降级纯文本（设计文档 3.1） */
  highlighterDisabledOver: number;
  /** 大文件阈值（3.3）：≥20MB 或 .log 走只读虚拟视图，编辑器模式上限 */
  largeFileThreshold: number;
  /** 超过此长度的行跳过 tokenization（3.1；简化实现为整篇降级纯文本） */
  longLineSkipChars: number;
  /** 列选择修饰键（Alt 拖选；部分 Linux WM 会劫持 Alt，可配置） */
  columnSelectionModifier: ColumnModifier;
  occurrenceHighlight: boolean;
  showWhitespace: boolean;
  bracketMatching: boolean;
  indentGuides: boolean;
  /** 列编辑器对话框快捷键（CM6 keymap 语法） */
  columnEditorKey: string;
}

export const settings: EditorSettings = {
  theme: "dark",
  tabSize: 2,
  insertSpaces: true,
  formatOnSave: false,
  highlighterDisabledOver: 50000,
  largeFileThreshold: 20 * 1024 * 1024,
  longLineSkipChars: 2000,
  columnSelectionModifier: "Alt",
  occurrenceHighlight: true,
  showWhitespace: false,
  bracketMatching: true,
  indentGuides: true,
  columnEditorKey: "Alt+c",
};
