import { invoke } from "@tauri-apps/api/core";
import { setLanguageOverrides } from "../editor/languages";

/**
 * 配置体系。
 * config.json 由 Rust 侧读写（config.rs），前端启动时 loadSettings() 载入，
 * 运行时改动经 updateSettings() 写回并热更新（编辑器项经 Compartment reconfigure）。
 *
 * `settings` 为编辑器实际消费的配置子集（可变对象，原地刷新，供 setup.ts 等直接读取）。
 */

export type ThemeSetting = "dark" | "light" | "high-contrast" | "system";
/** 编辑器语法主题（独立于应用 UI 主题，见 15.2） */
export type EditorThemeSetting = "dark" | "light" | "high-contrast";
export type ColumnModifier = "Alt" | "Control" | "Shift" | "Meta";

// ---------------------------------------------------------------------------
// AppConfig：与 Rust AppConfig（camelCase）一一对应
// ---------------------------------------------------------------------------

export interface EditorEnhancements {
  columnSelection: boolean;
  columnSelectionModifier: ColumnModifier;
  columnEditorKey: string;
  occurrenceHighlight: boolean;
  showWhitespace: boolean;
  bracketMatching: boolean;
  indentGuides: boolean;
  /** 彩虹括号：括号对按嵌套深度循环着色，便于区分配对 */
  rainbowBrackets: boolean;
  /** 自动换行：长行按编辑区宽度折行显示 */
  wordWrap: boolean;
}

export interface KeybindingEntry {
  command: string;
  key: string;
}

/** 状态栏字段（显隐与排序，见 15.4） */
export interface StatusBarFieldEntry {
  id: string;
  visible: boolean;
}

export interface LayoutSettings {
  sidebarVisible: boolean;
  splitRatio: number;
  defaultViewMode: "edit" | "preview" | "split";
  showLineNumbers: boolean;
  showActiveLine: boolean;
  /** 编辑器字号（px） */
  editorFontSize: number;
  /** 状态栏字段（数组顺序即展示顺序） */
  statusBarFields: StatusBarFieldEntry[];
}

export interface SessionSettings {
  restoreOnStartup: boolean;
  draftAutosave: boolean;
  draftDebounceMs: number;
  draftRetentionDays: number;
}

export interface WorkspaceSettings {
  rememberExpanded: boolean;
  lastDirectory: string;
}

export interface LargeFileSettings {
  logExtensions: string[];
  sparseIndexAnchorBytes: number;
  viewportPaddingLines: number;
}

export interface SearchSettings {
  parallelism: string;
  chunkSizeBytes: number;
}

/** 网页抓取设置 */
export interface FetchSettings {
  /** 允许抓取私网/本机地址（默认关，服务内网文档站时手动放开） */
  allowPrivateNetwork: boolean;
}

export interface GlobalReplaceSettings {
  backup: boolean;
}

export interface FormatterEntry {
  tool: string;
  args: string[];
}

export interface AiSettings {
  provider: string;
  model: string;
  enabled: boolean;
}

export interface LogSettings {
  level: string;
  dir: string;
  enabled: boolean;
}

export interface AppConfig {
  version: number;
  theme: ThemeSetting;
  /** 编辑器语法主题（dark / light / high-contrast） */
  editorTheme: EditorThemeSetting;
  tabSize: number;
  insertSpaces: boolean;
  formatOnSave: boolean;
  highlighterDisabledOver: number;
  largeFileThreshold: number;
  longLineSkipChars: number;
  languageExtensions: Record<string, string>;
  editorEnhancements: EditorEnhancements;
  keybindings: KeybindingEntry[];
  layout: LayoutSettings;
  session: SessionSettings;
  workspace: WorkspaceSettings;
  largeFile: LargeFileSettings;
  search: SearchSettings;
  fetch: FetchSettings;
  globalReplace: GlobalReplaceSettings;
  ignoreDirs: string[];
  fileEncodingMemory: Record<string, string>;
  formatters: Record<string, FormatterEntry>;
  ai: AiSettings;
  log: LogSettings;
}

/** 编辑器直接消费的配置子集（由 AppConfig 派生） */
export interface EditorSettings {
  theme: ThemeSetting;
  editorTheme: EditorThemeSetting;
  editorFontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  formatOnSave: boolean;
  highlighterDisabledOver: number;
  largeFileThreshold: number;
  longLineSkipChars: number;
  columnSelection: boolean;
  columnSelectionModifier: ColumnModifier;
  occurrenceHighlight: boolean;
  showWhitespace: boolean;
  bracketMatching: boolean;
  indentGuides: boolean;
  rainbowBrackets: boolean;
  columnEditorKey: string;
  showLineNumbers: boolean;
  showActiveLine: boolean;
  wordWrap: boolean;
}

/** 状态栏字段默认显隐顺序（与 index.html data-field 对应） */
export function defaultStatusBarFields(): StatusBarFieldEntry[] {
  return [
    { id: "path", visible: true },
    { id: "readonly", visible: true },
    { id: "size", visible: true },
    { id: "encoding", visible: true },
    { id: "newline", visible: true },
    { id: "language", visible: true },
    { id: "whitespace", visible: true },
    { id: "wrap", visible: true },
    { id: "cursor", visible: true },
    { id: "lines", visible: true },
    { id: "dirty", visible: true },
  ];
}

/** 前端默认值，须与 Rust AppConfig::default() 保持一致 */
export function defaultConfig(): AppConfig {
  return {
    version: 2,
    theme: "dark",
    editorTheme: "dark",
    tabSize: 2,
    insertSpaces: true,
    formatOnSave: false,
    highlighterDisabledOver: 50000,
    largeFileThreshold: 20 * 1024 * 1024,
    longLineSkipChars: 2000,
    languageExtensions: {
      ".js": "javascript",
      ".ts": "typescript",
      ".py": "python",
      ".rs": "rust",
      ".java": "java",
      ".md": "markdown",
      ".log": "plaintext",
    },
    editorEnhancements: {
      columnSelection: true,
      columnSelectionModifier: "Alt",
      columnEditorKey: "Alt+c",
      occurrenceHighlight: true,
      showWhitespace: false,
      bracketMatching: true,
      indentGuides: true,
      rainbowBrackets: true,
      wordWrap: false,
    },
    keybindings: [],
    layout: {
      sidebarVisible: true,
      splitRatio: 0.5,
      defaultViewMode: "split",
      showLineNumbers: true,
      showActiveLine: true,
      editorFontSize: 13,
      statusBarFields: defaultStatusBarFields(),
    },
    session: {
      restoreOnStartup: true,
      draftAutosave: true,
      draftDebounceMs: 1000,
      draftRetentionDays: 7,
    },
    workspace: { rememberExpanded: true, lastDirectory: "" },
    largeFile: {
      logExtensions: [".log"],
      sparseIndexAnchorBytes: 65536,
      viewportPaddingLines: 200,
    },
    search: { parallelism: "auto", chunkSizeBytes: 4 * 1024 * 1024 },
    fetch: { allowPrivateNetwork: false },
    globalReplace: { backup: true },
    ignoreDirs: ["node_modules", ".git", "dist"],
    fileEncodingMemory: {},
    formatters: {
      python: { tool: "black", args: ["-q", "-"] },
      go: { tool: "gofmt", args: [] },
      java: { tool: "google-java-format", args: ["--aosp"] },
      cpp: { tool: "clang-format", args: ["-style=file", "-assume-filename=__PLACEHOLDER__"] },
    },
    ai: { provider: "ollama", model: "qwen2.5-coder:7b", enabled: false },
    log: { level: "info", dir: "logs", enabled: true },
  };
}

/** 编辑器消费的配置子集：可原地刷新，保持引用稳定 */
export const settings: EditorSettings = deriveEditor(defaultConfig());

let current: AppConfig = defaultConfig();
const listeners = new Set<(cfg: AppConfig) => void>();

function deriveEditor(cfg: AppConfig): EditorSettings {
  const e = cfg.editorEnhancements;
  return {
    theme: cfg.theme,
    editorTheme: cfg.editorTheme,
    editorFontSize: cfg.layout.editorFontSize,
    tabSize: cfg.tabSize,
    insertSpaces: cfg.insertSpaces,
    formatOnSave: cfg.formatOnSave,
    highlighterDisabledOver: cfg.highlighterDisabledOver,
    largeFileThreshold: cfg.largeFileThreshold,
    longLineSkipChars: cfg.longLineSkipChars,
    columnSelection: e.columnSelection,
    columnSelectionModifier: e.columnSelectionModifier,
    occurrenceHighlight: e.occurrenceHighlight,
    showWhitespace: e.showWhitespace,
    bracketMatching: e.bracketMatching,
    indentGuides: e.indentGuides,
    rainbowBrackets: e.rainbowBrackets,
    columnEditorKey: e.columnEditorKey,
    showLineNumbers: cfg.layout.showLineNumbers,
    showActiveLine: cfg.layout.showActiveLine,
    wordWrap: e.wordWrap,
  };
}

/** 应用配置：原地刷新 settings + 语言映射覆盖 + 通知订阅者 */
function applyConfig(cfg: AppConfig): void {
  current = cfg;
  Object.assign(settings, deriveEditor(cfg));
  setLanguageOverrides(cfg.languageExtensions);
  listeners.forEach((fn) => fn(cfg));
}

/** 当前完整配置（只读快照，勿直接改；改动走 updateSettings） */
export function getConfig(): AppConfig {
  return current;
}

/** 订阅配置变更（供设置 UI 等刷新） */
export function subscribeSettings(fn: (cfg: AppConfig) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 启动时载入配置（Rust 侧缺省/迁移在 config.rs 处理） */
export async function loadSettings(): Promise<AppConfig> {
  let cfg: AppConfig;
  try {
    cfg = await invoke<AppConfig>("load_config");
  } catch (e) {
    console.warn("[config] 载入失败，回退默认值", e);
    cfg = defaultConfig();
  }
  applyConfig(cfg);
  return cfg;
}

/** 修改并持久化配置（写回 config.json 后热更新） */
export async function updateSettings(patch: Partial<AppConfig>): Promise<AppConfig> {
  const next: AppConfig = { ...current, ...patch };
  await invoke("save_config", { config: next });
  applyConfig(next);
  return next;
}
