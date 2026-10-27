/**
 * 设置中心共享层：回调接口、分类页上下文、选项常量、保存通道。
 * 三个分类页（theme/keybindings/layout）与面板骨架都依赖这里，
 * 它不依赖任何一方，避免循环 import。
 */

import {
  getConfig,
  updateSettings,
  type ColumnModifier,
  type EditorThemeSetting,
  type StatusBarFieldEntry,
  type ThemeSetting,
} from "../config/settings";

export type Category = "theme" | "keybindings" | "layout" | "files";

export type ViewMode = "edit" | "preview" | "split";

export interface SettingsPanelCallbacks {
  /** 侧栏显隐切换（立即应用到界面） */
  onSidebarVisible: (visible: boolean) => void;
  /** 双栏默认分栏比例（立即应用到界面） */
  onSplitRatio: (ratio: number) => void;
  /** 默认视图模式（应用到当前可预览标签） */
  onViewMode: (mode: ViewMode) => void;
  /** 状态栏消息 */
  onMessage: (text: string) => void;
}

/** 分类页上下文：由面板骨架（panels/settingsPanel.ts）创建并注入 */
export interface SettingsTabContext {
  callbacks: SettingsPanelCallbacks;
  /** 重渲染当前分类（保存后刷新列表/状态） */
  rerender: () => void;
  /** 取得当前录制中的清理函数（开始新录制前必须先取消上一段，否则监听泄漏） */
  getStopRecording: () => (() => void) | null;
  /** 注册/注销录制中的清理函数（Esc 关闭对话框前需先取消录制） */
  setStopRecording: (fn: (() => void) | null) => void;
}

/** 配置保存失败时的通知通道（面板打开时注册） */
let settingsNotify: ((text: string) => void) | null = null;

export function setSettingsNotify(fn: ((text: string) => void) | null): void {
  settingsNotify = fn;
}

/**
 * 保存配置并兜底错误。
 * 原实现用 `void updateSettings(...)` 丢弃 Promise：写盘失败时静默，
 * UI 却提示「已切换」，重启后丢失。这里统一 catch 并明确告知用户。
 */
export function saveSettings(patch: Parameters<typeof updateSettings>[0]): void {
  void updateSettings(patch).catch((e: unknown) => {
    console.error("[settings] 保存配置失败", e);
    settingsNotify?.(
      `配置保存失败: ${String(e instanceof Error ? e.message : e).split("\n")[0]}`,
    );
  });
}

export const CATEGORY_LABELS: { id: Category; label: string }[] = [
  { id: "theme", label: "外观主题" },
  { id: "layout", label: "编辑器与布局" },
  { id: "files", label: "文件与会话" },
  { id: "keybindings", label: "快捷键" },
];

export const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "high-contrast", label: "高对比度" },
  { value: "system", label: "跟随系统" },
];

export const EDITOR_THEME_OPTIONS: { value: EditorThemeSetting; label: string }[] = [
  { value: "dark", label: "深色（one-dark）" },
  { value: "light", label: "浅色" },
  { value: "high-contrast", label: "高对比度" },
];

export const VIEW_MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "edit", label: "编辑" },
  { value: "preview", label: "预览" },
  { value: "split", label: "双栏" },
];

export const COLUMN_MODIFIERS: ColumnModifier[] = ["Alt", "Control", "Shift", "Meta"];

export const STATUS_FIELD_LABELS: Record<string, string> = {
  path: "文件路径",
  readonly: "只读标记",
  size: "文件大小",
  encoding: "编码",
  newline: "换行符",
  language: "语言",
  indent: "缩进",
  whitespace: "空白字符开关",
  wrap: "自动换行开关",
  cursor: "光标位置",
  lines: "总行数",
  dirty: "未保存标记",
};

/** 状态栏字段：补齐新版本新增字段（旧配置缺省时插入默认位置） */
export function withAllFields(fields: StatusBarFieldEntry[]): StatusBarFieldEntry[] {
  const known = new Set(fields.map((f) => f.id));
  const merged = [...fields];
  for (const id of Object.keys(STATUS_FIELD_LABELS)) {
    if (!known.has(id)) merged.push({ id, visible: true });
  }
  return merged;
}

/** 列编辑器默认键（CM6 记法） */
export const DEFAULT_COLUMN_EDITOR_KEY = "Alt+c";

/** 编辑器增强项的当前快照（各页保存时都要基于最新值展开，避免兄弟项被覆盖） */
export function editorEnhancements() {
  return getConfig().editorEnhancements;
}

/** 布局配置的当前快照 */
export function layout() {
  return getConfig().layout;
}
