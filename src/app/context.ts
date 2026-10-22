/**
 * AppContext：应用级共享状态的显式容器。
 *
 * 背景：main.ts 长期以模块级可变变量持有共享状态（editorHandle、resultsPanel、
 * workspaceRoot、loadToken…），这是 main.ts 无法按域拆分的根因。本文件把这些
 * 状态收敛为一个显式对象，Phase 3 拆出的 app/ 模块经构造函数只取自己声明的字段。
 *
 * 使用规则（见 CODEBUDDY.md）：
 * - 禁止新增模块级可变单例，新共享状态一律进本容器
 * - 字段随拆分演进；某字段连续两个 Phase 无人使用即删除，防止腐烂
 * - 定时器句柄统一由持有方负责 clear，退出路径见 app/windowChrome.ts 的 flushOnExit
 */

import type { EditorHandle } from "../editor/setup";
import type { SearchResultsPanel } from "../editor/searchPanel";
import type { CommandPalette } from "../panels/commandPalette";
import type { PreviewHost } from "../panels/preview";
import type { LargeView, LargeFileInfo } from "../panels/largeView";
import type { DiffPanel, DiffPayload, DiffSession } from "../panels/diffPanel";
import type { SettingsPanel } from "../panels/settingsPanel";
import type { RunPanel } from "../panels/runPanel";
import type { Tab } from "../store/tabs";

/** 光标位置（会话恢复用） */
export interface CursorPos {
  line: number;
  col: number;
}

/** 标签切换代际控制：每个 await 后校验 token，防止过期加载覆盖当前标签 */
export interface SwitchGuard {
  token: number;
  /** 编辑器回调抑制窗口（标签切换的异步区间内不响应 onDocChange/onCursorChange） */
  switching: boolean;
  /** 当前已载入编辑器的标签 id（编辑器实际文档所属，非 tabStore.active()） */
  currentLoadedTabId: string | null;
}

/** 各面板的单例句柄（懒构造，见 main.ts ensureXxx 模式） */
export interface PanelHosts {
  results: SearchResultsPanel | null;
  preview: PreviewHost | null;
  largeView: LargeView | null;
  diff: DiffPanel | null;
  settings: SettingsPanel | null;
  run: RunPanel | null;
  palette: CommandPalette | null;
}

/** 工具面板句柄（命令面板入口打开的一次性对话框） */
export interface ToolPanelHosts {
  cron: unknown;
  batch: unknown;
  regex: unknown;
  table: unknown;
  recent: unknown;
  saveEncoding: unknown;
}

/** 持久化防抖定时器（键为标签 id） */
export type DebounceTimers = Map<string, ReturnType<typeof setTimeout>>;

export interface AppContext {
  // ---- 编辑器（全局唯一 CM6 实例）----
  editor: EditorHandle;

  // ---- 标签切换代际控制 ----
  switchGuard: SwitchGuard;

  // ---- 面板句柄 ----
  panels: PanelHosts;
  tools: ToolPanelHosts;

  // ---- 工作区 ----
  workspaceRoot: string | null;

  // ---- 会话/草稿状态 ----
  /** 各标签最近光标位置 */
  cursorPos: Map<string, CursorPos>;
  /** 会话恢复待应用的光标（路径 → 位置，标签首次载入后消费） */
  restoredCursors: Map<string, CursorPos>;
  /** 草稿防抖定时器（标签 id → timer） */
  draftTimers: DebounceTimers;
  /** 会话是否需要写盘 */
  sessionDirty: boolean;
  sessionTimer: ReturnType<typeof setTimeout> | null;

  // ---- 配置写盘防抖 ----
  configSaveTimer: ReturnType<typeof setTimeout> | null;

  // ---- 文件监视登记 ----
  /** 已登记的监听键（去重用） */
  watchedKey: string;
  watchTimer: ReturnType<typeof setTimeout> | null;

  // ---- 互斥/退出标志 ----
  /** 格式化进行中（防连按启动两个格式化器） */
  formatting: boolean;
  /** 退出流程已启动（防 onCloseRequested 重入） */
  exiting: boolean;

  // ---- 差异会话（面板关闭后置空，释放大载荷）----
  diffSession: DiffSession | null;
}

export function createAppContext(editor: EditorHandle): AppContext {
  return {
    editor,
    switchGuard: { token: 0, switching: false, currentLoadedTabId: null },
    panels: {
      results: null,
      preview: null,
      largeView: null,
      diff: null,
      settings: null,
      run: null,
      palette: null,
    },
    tools: { cron: null, batch: null, regex: null, table: null, recent: null, saveEncoding: null },
    workspaceRoot: null,
    cursorPos: new Map(),
    restoredCursors: new Map(),
    draftTimers: new Map(),
    sessionDirty: false,
    sessionTimer: null,
    configSaveTimer: null,
    watchedKey: "",
    watchTimer: null,
    formatting: false,
    exiting: false,
    diffSession: null,
  };
}

/** 差异面板打开参数（供 app/diffService.ts 使用） */
export interface DiffOpenRequest {
  session: DiffSession;
  hunkIndex?: number;
}

/** 大文件视图打开参数（供 app/largeFileHost.ts 使用） */
export interface LargeViewOpenRequest {
  info: LargeFileInfo;
  tab: Tab;
}

export type { DiffPayload };
