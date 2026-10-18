import { invoke } from "@tauri-apps/api/core";
import { setLanguageOverrides } from "../editor/languages";

/**
 * 配置体系。
 * config.json 由 Rust 侧读写（config.rs），前端启动时 loadSettings() 载入，
 * 运行时改动经 updateSettings() 写回并热更新（编辑器项经 Compartment reconfigure）。
 *
 * `settings` 为编辑器实际消费的配置子集（可变对象，原地刷新，供 setup.ts 等直接读取）。
 */

export type ThemeSetting = "dark" | "light" | "system";
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
}

export interface KeybindingEntry {
  command: string;
  key: string;
}

export interface LayoutSettings {
  sidebarVisible: boolean;
  splitRatio: number;
  defaultViewMode: "edit" | "preview" | "split";
  showLineNumbers: boolean;
  showActiveLine: boolean;
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
  columnEditorKey: string;
}

/** 前端默认值，须与 Rust AppConfig::default() 保持一致 */
export function defaultConfig(): AppConfig {
  return {
    version: 2,
    theme: "dark",
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
    },
    keybindings: [],
    layout: {
      sidebarVisible: true,
      splitRatio: 0.5,
      defaultViewMode: "split",
      showLineNumbers: true,
      showActiveLine: true,
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
    columnEditorKey: e.columnEditorKey,
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
