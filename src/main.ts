import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** startResizeDragging 的方向参数（@tauri-apps/api 未导出该类型，本地声明） */
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";
import { createEditor, type EditorHandle } from "./editor/setup";
import { SearchResultsPanel } from "./editor/searchPanel";
import { languageDisplayNames, languageKeyFromPath } from "./editor/languages";
import { formatDocument, formatSelection } from "./editor/format";
import { openColumnEditor } from "./editor/columnEditor";
import { toggleBookmark, gotoBookmark } from "./editor/bookmarks";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { FileTree } from "./panels/fileTree";
import { CommandPalette } from "./panels/commandPalette";
import { MenuBar } from "./panels/menubar";
import { GlobalSearchPanel } from "./panels/globalSearch";
import {
  PreviewHost,
  buildStandaloneHtml,
  buildWordHtml,
  openPrintDialog,
  pathKindOf,
  type PreviewMode,
  type PreviewTab,
} from "./panels/preview";
import { tabStore, type Tab } from "./store/tabs";
import { confirmCloseDirty } from "./ui/dialogs";
import { showConfigReloaded, showSettingsHelp } from "./ui/settingsHelp";
import { placeMenu } from "./ui/menu";
import {
  loadWorkspace,
  saveWorkspaceDebounced,
  pickDirectory,
  type WorkspaceState,
} from "./services/workspace";
import {
  settings,
  getConfig,
  loadSettings,
  updateSettings,
  subscribeSettings,
  type AppConfig,
  type StatusBarFieldEntry,
} from "./config/settings";
import {
  registerKeyCommands,
  matchKeyCommand,
  setExtraReservedKeys,
} from "./config/keybindings";
import { SettingsPanel } from "./panels/settingsPanel";
import { DiffPanel, type DiffPayload } from "./panels/diffPanel";
import { LargeView, type LargeFileInfo } from "./panels/largeView";
import type { FileContent, SaveResult } from "./types/app";

// ---------------------------------------------------------------------------
// 多标签页 + 文件树/工作区 + 命令面板 + Prettier 格式化
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const tabsBar = $<HTMLDivElement>("tabs");
const modeBar = $<HTMLDivElement>("preview-modes");
const resultsContainer = $<HTMLDivElement>("search-results");
const fileTreeEl = $<HTMLDivElement>("file-tree");
const statusPath = $<HTMLSpanElement>("status-path");
const statusSize = $<HTMLSpanElement>("status-size");
const statusEncoding = $<HTMLSpanElement>("status-encoding");
const statusNewline = $<HTMLSpanElement>("status-newline");
const statusLanguage = $<HTMLSpanElement>("status-language");
const statusCursor = $<HTMLSpanElement>("status-cursor");
const statusLines = $<HTMLSpanElement>("status-lines");
const statusDirty = $<HTMLSpanElement>("status-dirty");
const statusMessage = $<HTMLSpanElement>("status-message");
const statusWhitespace = $<HTMLSpanElement>("status-whitespace");
const statusReadonly = $<HTMLSpanElement>("status-readonly");

/** 状态栏空白字符指示（与编辑器实际状态联动） */
function refreshWhitespace(): void {
  const on = editorHandle.isWhitespaceOn();
  statusWhitespace.textContent = `空白: ${on ? "显" : "隐"}`;
  statusWhitespace.classList.toggle("on", on);
}

/** 防抖写回 config.json（界面开关与配置文件保持联动） */
let configSaveTimer: ReturnType<typeof setTimeout> | null = null;
function persistConfig(patch: Partial<AppConfig>): void {
  if (configSaveTimer) clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(() => {
    configSaveTimer = null;
    void updateSettings(patch).catch((e) => console.warn("[config] 写回失败", e));
  }, 300);
}

/** 切换空白字符显示并写回配置 */
function toggleWhitespacePersisted(): void {
  editorHandle.toggleWhitespace();
  refreshWhitespace();
  persistConfig({
    editorEnhancements: {
      ...getConfig().editorEnhancements,
      showWhitespace: editorHandle.isWhitespaceOn(),
    },
  });
}

statusWhitespace.addEventListener("click", () => toggleWhitespacePersisted());

// ---- 状态栏换行符菜单（与编码菜单一致的「弹出列表 → 选择」交互）----

const NEWLINE_OPTIONS: { value: string; label: string }[] = [
  { value: "LF", label: "LF（Unix / macOS）" },
  { value: "CRLF", label: "CRLF（Windows）" },
  { value: "CR", label: "CR（老式 Mac）" },
];

let newlineMenu: HTMLElement | null = null;

function closeNewlineMenu(): void {
  newlineMenu?.remove();
  newlineMenu = null;
}

function showNewlineMenu(x: number, y: number): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    showMessage("当前文件不支持切换换行符");
    return;
  }
  closeNewlineMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  const header = document.createElement("div");
  header.className = "context-menu-item";
  header.style.opacity = "0.6";
  header.style.cursor = "default";
  header.textContent = `当前换行符：${tab.newline}`;
  menu.append(header);

  for (const option of NEWLINE_OPTIONS) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.textContent = option.value === tab.newline ? `${option.label} ✓` : option.label;
    el.addEventListener("click", () => {
      closeNewlineMenu();
      applyNewline(tab.id, option.value);
    });
    menu.append(el);
  }
  document.body.append(menu);
  placeMenu(menu, x, y);
  newlineMenu = menu;
}

/** 应用换行符：仅改内存状态并标脏，由用户手动保存落盘 */
function applyNewline(tabId: string, newline: string): void {
  tabStore.setNewline(tabId, newline);
  refreshStatus();
  showMessage(`换行符已切换为 ${newline}（未保存，Ctrl+S 保存）`);
}

statusNewline.title = "点击切换换行符（LF / CRLF / CR）";
statusNewline.style.cursor = "pointer";
statusNewline.addEventListener("click", (e) => {
  e.stopPropagation();
  showNewlineMenu(e.clientX, e.clientY);
});
document.addEventListener("click", () => closeNewlineMenu());

// ---- 状态栏编码菜单（「重新打开为」，只改解读方式、不写盘）----

const FALLBACK_ENCODINGS = ["UTF-8", "GBK", "GB18030", "UTF-16 LE", "UTF-16 BE", "Big5"];
let encodingMenu: HTMLElement | null = null;

function closeEncodingMenu(): void {
  encodingMenu?.remove();
  encodingMenu = null;
}

function showEncodingMenu(x: number, y: number): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    showMessage("当前文件不支持切换编码");
    return;
  }
  closeEncodingMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  const header = document.createElement("div");
  header.className = "context-menu-item";
  header.style.opacity = "0.6";
  header.style.cursor = "default";
  header.textContent = `当前编码：${tab.encoding}`;
  menu.append(header);

  const candidates = tab.encodingCandidates.length
    ? tab.encodingCandidates
    : FALLBACK_ENCODINGS;
  for (const enc of candidates) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.textContent = enc === tab.encoding ? `${enc} ✓` : enc;
    el.addEventListener("click", () => {
      closeEncodingMenu();
      void reopenWithEncoding(tab.id, enc);
    });
    menu.append(el);
  }
  document.body.append(menu);
  placeMenu(menu, x, y);
  encodingMenu = menu;
}

/** 「重新打开为」：按新编码重新解读磁盘字节（不写盘） */
async function reopenWithEncoding(tabId: string, encoding: string): Promise<void> {
  const tab = tabStore.findById(tabId);
  if (!tab || !tab.path) return;
  if (
    tab.dirty &&
    !window.confirm(`「${tab.name}」有未保存修改，重新打开将丢弃这些修改。是否继续？`)
  ) {
    return;
  }
  try {
    const data = await invoke<FileContent>("reopen_with_encoding", {
      path: tab.path,
      encoding,
      largeFileThreshold: settings.largeFileThreshold,
      logExtensions: getConfig().largeFile.logExtensions,
    });
    tabStore.reopenWith(tabId, data);
    if (tabStore.active()?.id === tabId) {
      await loadActiveTab();
    } else {
      refreshStatus();
    }
    showMessage(
      tabStore.findById(tabId)?.dirty
        ? `编码已切换为 ${data.encoding}（未保存，Ctrl+S 转码保存）`
        : `已重新打开为 ${data.encoding}`,
    );
  } catch (e) {
    showMessage(`重新打开失败: ${String(e).split("\n")[0]}`);
  }
}

statusEncoding.title = "点击切换编码（重新打开为…）";
statusEncoding.style.cursor = "pointer";
statusEncoding.addEventListener("click", (e) => {
  e.stopPropagation();
  showEncodingMenu(e.clientX, e.clientY);
});
document.addEventListener("click", () => closeEncodingMenu());

// ---- 插入时间戳 / UUID ----

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 在光标处插入文本（替换选中内容） */
function insertAtCursor(text: string): void {
  if (blockIfReadonly()) return;
  const view = editorHandle.view;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
}

/** 常用时间戳格式 */
function localStamps(): {
  local: string;
  iso: string;
  unix: string;
  date: string;
  time: string;
} {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return {
    local: `${date} ${time}`,
    iso: d.toISOString().replace(/\.\d{3}Z$/, "Z"),
    unix: String(Math.floor(d.getTime() / 1000)),
    date,
    time,
  };
}

/** 生成 UUID v4 */
function newUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/** 状态栏瞬时消息（格式化结果等，3 秒后淡出） */
let messageTimer: ReturnType<typeof setTimeout> | null = null;
function showMessage(text: string): void {
  statusMessage.textContent = text;
  statusMessage.classList.remove("hidden");
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => statusMessage.classList.add("hidden"), 3000);
}

let editorHandle: EditorHandle;
let resultsPanel: SearchResultsPanel | null = null;
const palette = new CommandPalette();

/** 工作区状态（root/expanded 由文件树维护，open_files/active 由标签页维护） */
let workspaceRoot: string | null = null;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function activeTab(): Tab | null {
  return tabStore.active();
}

/** 只读标签：统一拦截需要写盘或改内容的编辑入口 */
function blockIfReadonly(): boolean {
  const tab = activeTab();
  if (tab?.readonly) {
    showMessage(`只读文件：${tab.readonlyReason || "不可编辑"}`);
    return true;
  }
  return false;
}

function refreshStatus(): void {
  const tab = activeTab();
  statusPath.textContent = tab ? tab.name : "未打开文件";
  statusPath.title = tab?.path ?? "";
  statusSize.textContent = tab ? formatSize(tab.size) : "—";
  statusEncoding.textContent = tab ? tab.encoding : "UTF-8";
  statusNewline.textContent = tab ? tab.newline : "—";
  const key = tab?.path ? languageKeyFromPath(tab.path) : null;
  statusLanguage.textContent = key ? (languageDisplayNames[key] ?? key) : "纯文本";
  statusDirty.classList.toggle("hidden", !tab?.dirty);
  statusReadonly.classList.toggle("hidden", tab?.readonly !== true);
  statusReadonly.title = tab?.readonly ? tab.readonlyReason : "";
  refreshWhitespace();
}

// ---- 应用主题：CSS 变量切换，system 跟随系统偏好 ----

const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** theme 配置 → 实际生效的深浅（system 时读系统偏好） */
function resolveAppTheme(theme: AppConfig["theme"]): "dark" | "light" | "high-contrast" {
  if (theme === "system") return systemDarkQuery.matches ? "dark" : "light";
  return theme;
}

function applyAppTheme(cfg: AppConfig): void {
  document.documentElement.dataset.theme = resolveAppTheme(cfg.theme);
}

systemDarkQuery.addEventListener("change", () => {
  if (getConfig().theme === "system") applyAppTheme(getConfig());
});

// ---- 状态栏字段显隐（15.4：数组顺序即展示顺序）----

function applyStatusBarFields(fields: StatusBarFieldEntry[]): void {
  const visible = new Map(fields.map((f) => [f.id, f.visible]));
  document.querySelectorAll<HTMLElement>(".statusbar [data-field]").forEach((el) => {
    const on = visible.get(el.dataset.field ?? "") ?? true;
    el.classList.toggle("field-hidden", !on);
    const next = el.nextElementSibling;
    if (next?.classList.contains("status-sep")) next.classList.toggle("field-hidden", !on);
  });
}

/** 应用分栏比例（设置中心滑杆 / 配置默认值共用） */
function applySplitRatio(ratio: number): void {
  const clamped = Math.min(0.85, Math.max(0.15, ratio));
  editorArea.style.setProperty("--split-ratio", `${(clamped * 100).toFixed(1)}%`);
  try {
    localStorage.setItem("my-editor.splitRatio", String(clamped));
  } catch {
    // localStorage 不可用时仅会话内生效
  }
}

// ---- 标签栏渲染 ----

function renderTabs(): void {
  tabsBar.innerHTML = "";
  for (const tab of tabStore.list()) {
    const el = document.createElement("div");
    el.className = `tab${tab.id === tabStore.active()?.id ? " active" : ""}`;

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = tab.dirty ? `● ${tab.name}` : tab.name;
    name.title = tab.path ?? "未命名";
    name.addEventListener("click", () => tabStore.activate(tab.id));

    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "关闭";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeTab(tab.id);
    });

    el.append(name, close);
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showTabMenu(e.clientX, e.clientY, tab.id);
    });
    tabsBar.append(el);
  }
  tabsBar.classList.toggle("hidden", tabStore.list().length === 0);
}

async function closeTab(id: string): Promise<void> {
  const tab = tabStore.findById(id);
  if (!tab) return;
  if (tab.dirty) {
    // 三选确认：保存 / 不保存 / 取消
    const choice = await confirmCloseDirty(tab.name);
    if (choice === "cancel") return;
    if (choice === "save") {
      try {
        if (tab.path) {
          await writeTo(tab, tab.path);
        } else {
          const target = await save({ defaultPath: tab.name });
          if (typeof target !== "string") return; // 用户取消保存 → 不关闭
          await writeTo(tab, target);
        }
      } catch (e) {
        window.alert(`保存失败: ${e}`);
        return;
      }
    }
  }
  tabStore.close(id);
  previewModes.delete(id);
  void releaseLargeSession(tab);
}

/** 标签页状态变化 → 重渲染 + 同步编辑器内容 + 持久化工作区 */
tabStore.subscribe(() => {
  const prevActiveId = currentLoadedTabId;
  renderTabs();
  refreshStatus();
  if (tabStore.active()?.id !== prevActiveId) {
    void loadActiveTab();
  }
  persistWorkspace();
});

let currentLoadedTabId: string | null = null;

async function loadActiveTab(): Promise<void> {
  const tab = activeTab();
  currentLoadedTabId = tab?.id ?? null;
  if (!tab) {
    // 无标签：清空编辑器、预览与结果面板，回到默认空态
    editorHandle.loadDocument("", "");
    editorColumn()?.classList.remove("virtual");
    largeView().close();
    refreshPreview();
    resultsPanel?.refresh();
    return;
  }
  if (tab.pending && tab.path) {
    // 会话恢复的占位标签：首次激活时才载入内容
    if (!(await loadPendingTab(tab))) return;
  }
  if (tab.virtual && tab.largeId) {
    // 大文件只读虚拟视图：隐藏编辑器与预览，行内容按窗口拉取
    editorColumn()?.classList.add("virtual");
    try {
      const info = await invoke<LargeFileInfo>("large_file_info", { id: tab.largeId });
      await largeView().open(info, getConfig().largeFile.viewportPaddingLines);
    } catch {
      // 会话已释放（例如应用重建）：退回编辑器路径
      tab.virtual = false;
      tab.largeId = undefined;
      editorColumn()?.classList.remove("virtual");
      await loadActiveTab();
    }
    return;
  }
  editorColumn()?.classList.remove("virtual");
  largeView().close();
  await editorHandle.loadDocument(tab.path ?? "", tab.content, tab.readonly);
  // 文件树联动：展开祖先目录并高亮当前文件
  if (tab.path) fileTree.revealPath(tab.path);
  // 预览联动：按标签类型应用 编辑/预览/双栏 或图片查看器
  refreshPreview();
  resultsPanel?.refresh();
}

// ---- 工作区持久化 ----

function persistWorkspace(): void {
  const state: WorkspaceState = {
    root: workspaceRoot,
    expanded: [],
    open_files: tabStore.list().map((t) => t.path).filter((p): p is string => !!p),
    active_file: activeTab()?.path ?? null,
  };
  saveWorkspaceDebounced(state);
}

// ---- 文件树 ----

const wsName = $<HTMLSpanElement>("ws-name");
const btnOpenDir = $<HTMLButtonElement>("btn-open-dir");

const fileTree = new FileTree(fileTreeEl, {
  onOpenFile: (path) => void openFilePath(path),
  onCompareFile: (path) => void compareWithPath(path),
  onWorkspaceStateChange: (state) => {
    workspaceRoot = state.root;
    wsName.textContent = state.root
      ? (state.root.split(/[\\/]/).pop() || state.root)
      : "工作区";
    wsName.title = state.root ?? "";
    persistWorkspaceWithExpanded(state.expanded);
  },
});
fileTree.mountGlobalListeners();

btnOpenDir.addEventListener("click", () => void openWorkspaceDir());

// ---- 窗口控制（自定义标题栏，无边框窗口）----
const appWindow = getCurrentWindow();
const titlebar = document.querySelector<HTMLElement>(".titlebar");

$<HTMLButtonElement>("win-min").addEventListener("click", () => void appWindow.minimize());
$<HTMLButtonElement>("win-max").addEventListener("click", () => void appWindow.toggleMaximize());
$<HTMLButtonElement>("win-close").addEventListener("click", () => void appWindow.close());

// 注：双击标题栏最大化由 Tauri data-tauri-drag-region 内置处理（drag.js），无需自建
void titlebar;

// 无边框窗口缩放热区：左右下边缘 + 四角
document.querySelectorAll<HTMLElement>(".resize-zone").forEach((zone) => {
  zone.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const dir = zone.dataset.resize as ResizeDirection | undefined;
    if (dir) void appWindow.startResizeDragging(dir);
  });
});

// ---- 标签页右键菜单（关闭当前/左侧/右侧/其他/全部）----
let tabMenu: HTMLElement | null = null;

function closeTabMenu(): void {
  tabMenu?.remove();
  tabMenu = null;
}

function showTabMenu(x: number, y: number, tabId: string): void {
  closeTabMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items: { label: string; run: () => void }[] = [
    { label: "与当前标签比较", run: () => compareTabs(tabId) },
    { label: "关闭当前", run: () => void closeTab(tabId) },
    { label: "关闭左侧", run: () => void tabStore.closeLeft(tabId) },
    { label: "关闭右侧", run: () => void tabStore.closeRight(tabId) },
    { label: "关闭其他", run: () => void tabStore.closeOthers(tabId) },
    { label: "关闭全部", run: () => void tabStore.closeAll() },
  ];
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.textContent = item.label;
    el.addEventListener("click", () => {
      closeTabMenu();
      item.run();
    });
    menu.append(el);
  }
  document.body.append(menu);
  placeMenu(menu, x, y);
  tabMenu = menu;
}

document.addEventListener("click", () => closeTabMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTabMenu();
});

function persistWorkspaceWithExpanded(expanded: string[]): void {
  saveWorkspaceDebounced({
    root: workspaceRoot,
    expanded,
    open_files: tabStore.list().map((t) => t.path).filter((p): p is string => !!p),
    active_file: activeTab()?.path ?? null,
  });
}

// ---- 编辑器初始化（CM6 仅承载 <20MB 文档）----
editorHandle = createEditor($("editor"), {
  onDocChange: () => {
    const tab = activeTab();
    if (!tab) return;
    tabStore.setContent(tab.id, editorHandle.getContent());
    const t = tabStore.findById(tab.id);
    if (t) previewHost.scheduleRender(toPreviewTab(t));
  },
  onCursorChange: ({ line, col, totalLines }) => {
    statusCursor.textContent = `行 ${line}，列 ${col}`;
    statusLines.textContent = `共 ${totalLines} 行`;
  },
  onHighlightDisabled: (reason) => {
    console.info(`[editor] 高亮已禁用: ${reason}`);
    statusLanguage.textContent = "纯文本（高亮已禁用）";
  },
});

// 配置变更 → 热更新编辑器（缩进/括号/缩进线/同名高亮/列选择/键位/主题等 Compartment 重配）
// + 应用主题（CSS 变量）与状态栏字段显隐
subscribeSettings(() => {
  applyAppTheme(getConfig());
  applyStatusBarFields(getConfig().layout.statusBarFields);
  editorHandle.applySettings();
  refreshStatus();
  refreshWhitespace();
});

// ---- 预览宿主（md/html/image）----
const previewModes = new Map<string, PreviewMode>();
const editorArea = document.querySelector<HTMLElement>(".editor-area")!;

function toPreviewTab(tab: Tab): PreviewTab {
  return {
    id: tab.id,
    kind: tab.kind,
    path: tab.path,
    name: tab.name,
    content: tab.content,
    size: tab.size,
    dataUrl: tab.dataUrl,
  };
}

function currentPreviewMode(): PreviewMode {
  const tab = activeTab();
  if (!tab) return "edit";
  if (tab.kind === "image") return "preview";
  if (!pathKindOf(tab.path)) return "edit";
  // 默认视图模式来自配置（设置中心 ▸ 页面布局）
  return previewModes.get(tab.id) ?? getConfig().layout.defaultViewMode;
}

function refreshPreview(): void {
  const tab = activeTab();
  const mode = currentPreviewMode();
  const kind = pathKindOf(tab?.path ?? null);
  modeBar.classList.toggle("hidden", !kind);
  modeBar.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  previewHost.apply(tab ? toPreviewTab(tab) : null, mode);
}

const previewHost = new PreviewHost($("preview-pane"), editorArea, (line) => {
  // 预览滚动 → 编辑器滚动（双栏 Markdown）
  const view = editorHandle.view;
  const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines));
  const coords = view.coordsAtPos(lineInfo.from);
  const rect = view.scrollDOM.getBoundingClientRect();
  if (coords) view.scrollDOM.scrollTop += coords.top - (rect.top + 8);
});

// 编辑器滚动 → 预览联动
editorHandle.view.scrollDOM.addEventListener("scroll", () =>
  previewHost.syncFromEditor(editorHandle.view),
);

// ---- 侧栏搜索视图（文件树下方的 tab 区）----

const sidebarPanel = document.querySelector<HTMLElement>(".sidebar-panel")!;
const searchTab = $<HTMLButtonElement>("sp-tab-search");

const globalSearch = new GlobalSearchPanel($("sidebar-search"), {
  getRoot: () => workspaceRoot,
  onOpenHit: (path, line) => void openHit(path, line),
  onMessage: showMessage,
});
globalSearch.mount();

/** 打开 / 收起侧栏下方的搜索面板 */
function setSearchPanelOpen(open: boolean): void {
  sidebarPanel.classList.toggle("open", open);
  searchTab.classList.toggle("active", open);
  if (open) globalSearch.show();
  else globalSearch.hide();
}

searchTab.addEventListener("click", () =>
  setSearchPanelOpen(!sidebarPanel.classList.contains("open")),
);

/** 显示全局搜索（并确保侧栏可见） */
function showGlobalSearch(): void {
  sidebarVisible = true;
  document.querySelector(".main")?.classList.toggle("no-sidebar", false);
  setSearchPanelOpen(true);
}

/** 打开全局搜索命中项并跳转到对应行 */
async function openHit(path: string, line: number): Promise<void> {
  await openFilePath(path, { silent: true });
  const tab = tabStore.findByPath(path);
  if (!tab) return;
  if (tabStore.active()?.id !== tab.id) tabStore.activate(tab.id);
  await loadActiveTab();
  editorHandle.gotoLine(line);
}

// ---- 双栏分割线拖动（比例记忆于 localStorage，双击复位）----
const splitResizer = $("split-resizer");
let resizing = false;

splitResizer.addEventListener("mousedown", (e) => {
  if (currentPreviewMode() !== "split") return;
  resizing = true;
  splitResizer.classList.add("dragging");
  document.body.classList.add("dragging-split");
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const rect = editorArea.getBoundingClientRect();
  const ratio = Math.min(0.85, Math.max(0.15, (e.clientX - rect.left) / rect.width));
  editorArea.style.setProperty("--split-ratio", `${(ratio * 100).toFixed(1)}%`);
  try {
    localStorage.setItem("my-editor.splitRatio", String(ratio));
  } catch {
    // localStorage 不可用时静默降级为会话内记忆
  }
});
window.addEventListener("mouseup", () => {
  if (!resizing) return;
  resizing = false;
  splitResizer.classList.remove("dragging");
  document.body.classList.remove("dragging-split");
});
splitResizer.addEventListener("dblclick", () => {
  editorArea.style.setProperty("--split-ratio", "50%");
  try {
    localStorage.removeItem("my-editor.splitRatio");
  } catch {
    // 同上
  }
});
// 恢复上次的分栏比例
try {
  const saved = localStorage.getItem("my-editor.splitRatio");
  if (saved) editorArea.style.setProperty("--split-ratio", `${(Number(saved) * 100).toFixed(1)}%`);
} catch {
  // 同上
}

// ---- 预览右键导出（HTML / Word / PDF）----
let previewMenu: HTMLElement | null = null;

function closePreviewMenu(): void {
  previewMenu?.remove();
  previewMenu = null;
}

function showPreviewMenu(x: number, y: number, tab: Tab): void {
  closePreviewMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items: { label: string; run: () => void }[] = [
    { label: "导出 HTML…", run: () => void exportPreview(tab, "html") },
    { label: "导出 Word…（.doc）", run: () => void exportPreview(tab, "word") },
    { label: "导出 PDF…（系统打印对话框）", run: () => void exportPreview(tab, "pdf") },
  ];
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.textContent = item.label;
    el.addEventListener("click", () => {
      closePreviewMenu();
      item.run();
    });
    menu.append(el);
  }
  document.body.append(menu);
  placeMenu(menu, x, y);
  previewMenu = menu;
}

function previewPaneTitle(tab: Tab): string {
  return tab.name.replace(/\.(md|markdown|html?)$/i, "");
}

async function exportPreview(
  tab: Tab,
  format: "html" | "word" | "pdf",
): Promise<void> {
  try {
    const body = await previewHost.getExportBody(toPreviewTab(tab));
    const title = previewPaneTitle(tab);

    if (format === "pdf") {
      // 经系统打印对话框另存为 PDF
      openPrintDialog(buildStandaloneHtml(title, body));
      return;
    }

    const ext = format === "html" ? "html" : "doc";
    const target = await save({ defaultPath: `${title}.${ext}` });
    if (typeof target !== "string") return;
    const content =
      format === "html" ? buildStandaloneHtml(title, body) : buildWordHtml(title, body);
    const result = await invoke<SaveResult>("save_file", {
      path: target,
      content,
      newline: "LF",
      hasBom: false,
      encoding: "UTF-8",
    });
    showMessage(`已导出: ${result.path}`);
  } catch (e) {
    showMessage(`导出失败: ${String(e).split("\n")[0]}`);
    console.error("[export]", e);
  }
}

$("preview-pane").addEventListener("contextmenu", (e) => {
  const tab = activeTab();
  // 仅 md/html 文件可导出（图片查看器无导出意义）
  if (!tab || tab.kind !== "text" || !pathKindOf(tab.path)) return;
  e.preventDefault();
  showPreviewMenu(e.clientX, e.clientY, tab);
});
document.addEventListener("click", () => closePreviewMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePreviewMenu();
});

modeBar.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    previewModes.set(tab.id, btn.dataset.mode as PreviewMode);
    refreshPreview();
  });
});

// ---- 文件操作 ----

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]);
function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

/** 从路径打开（文件树点击 / 工作区恢复 / 对话框共用） */
async function openFilePath(
  path: string,
  opts: { silent?: boolean; forceEditor?: boolean } = {},
): Promise<void> {
  const existing = tabStore.findByPath(path);
  if (existing) {
    tabStore.activate(existing.id);
    return;
  }
  try {
    if (isImagePath(path)) {
      // 图片：base64 读取 → 只读查看器
      const img = await invoke<{
        path: string;
        name: string;
        size: number;
        data_url: string;
      }>("read_image_file", { path });
      tabStore.openImage(img.path, img.name, img.size, img.data_url);
      return;
    }
    // 文本：先探测体积与扩展名——命中分流规则则进入只读虚拟视图（不全量载入内存）
    if (!opts.forceEditor) {
      try {
        const probe = await invoke<{ size: number; extension: string }>("probe_file", { path });
        if (needVirtualView(probe.size, probe.extension)) {
          const info = await invoke<LargeFileInfo>("open_large_file", {
            path,
            anchorBytes: getConfig().largeFile.sparseIndexAnchorBytes,
          });
          tabStore.openVirtual(info);
          if (!opts.silent) {
            showMessage(`${info.name}：${info.totalLines} 行，已进入只读虚拟视图`);
          }
          return;
        }
      } catch (e) {
        // 虚拟视图不可用（如 UTF-16）时回退编辑器路径
        console.warn("[large] 回退编辑器打开:", e);
      }
    }
    // 编辑器路径：经只读守卫——命中阈值或日志扩展名时仍载入但标记只读
    const data = await invoke<FileContent>("open_text_file", {
      path,
      largeFileThreshold: settings.largeFileThreshold,
      logExtensions: getConfig().largeFile.logExtensions,
    });
    const tab = tabStore.open(data);
    if (opts.silent) return;
    if (tab.readonly) {
      showMessage(`${tab.readonlyReason}，已以只读方式打开`);
    } else if (data.encoding_confidence === "low") {
      showMessage(`已按 ${data.encoding} 解码（置信度低，可点击状态栏编码切换）`);
    }
  } catch (e) {
    if (!opts.silent) window.alert(`打开失败: ${e}`);
  }
}

/** 工具栏打开按钮：对话框选择 */
async function openFileDialog(): Promise<void> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "所有文件", extensions: ["*"] }],
  });
  if (typeof selected !== "string") return;
  await openFilePath(selected);
}

async function saveFile(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  if (blockIfReadonly()) return;
  if (!tab.path) {
    await saveFileAs();
    return;
  }
  await writeTo(tab, tab.path);
}

async function saveFileAs(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  if (blockIfReadonly()) return;
  const target = await save({ defaultPath: tab.name });
  if (typeof target !== "string") return;
  await writeTo(tab, target);
}

/** 调 Rust 保存命令：保留换行符与 BOM（原子替换在 Rust 侧） */
async function writeTo(tab: Tab, path: string): Promise<void> {
  // 用 tab.content 而非编辑器内容：非激活标签的编辑只存在于缓存中，
  // 且激活标签的每次输入都会实时同步进 tab.content（onDocChange → setContent）
  const result = await invoke<SaveResult>("save_file", {
    path,
    content: tab.content,
    newline: tab.newline,
    hasBom: tab.has_bom,
    encoding: tab.encoding,
  });
  if (path !== tab.path) {
    tabStore.setPath(tab.id, result.path, result.path.split(/[\\/]/).pop() ?? result.path);
  }
  const current = tabStore.findById(tab.id);
  if (current) {
    current.size = result.size;
  }
  tabStore.markSaved(tab.id);
  refreshStatus();
}

/** 新建未命名文档 */
function newUntitled(): void {
  const content: FileContent = {
    path: "",
    name: "未命名",
    size: 0,
    content: "",
    encoding: "UTF-8",
    encoding_confidence: "high",
    encoding_candidates: [],
    newline: "NONE",
    has_bom: false,
    readonly: false,
    readonly_reason: "",
  };
  tabStore.open(content);
}

/** 打开 config.json（便于查看/编辑配置） */
async function openConfigFile(): Promise<void> {
  try {
    const path = await invoke<string>("config_path");
    await openFilePath(path);
  } catch (e) {
    showMessage(`打开配置失败: ${String(e).split("\n")[0]}`);
  }
}

/** 配置关键值摘要（重新加载后的反馈内容） */
function configSummary(cfg: AppConfig): string[] {
  const e = cfg.editorEnhancements;
  return [
    `theme = ${cfg.theme}`,
    `tabSize = ${cfg.tabSize}　insertSpaces = ${cfg.insertSpaces}　formatOnSave = ${cfg.formatOnSave}`,
    `highlighterDisabledOver = ${cfg.highlighterDisabledOver} 行　longLineSkipChars = ${cfg.longLineSkipChars}`,
    `largeFileThreshold = ${cfg.largeFileThreshold} 字节`,
    `languageExtensions = ${Object.keys(cfg.languageExtensions).length} 条映射`,
    `showWhitespace = ${e.showWhitespace}　bracketMatching = ${e.bracketMatching}　indentGuides = ${e.indentGuides}`,
    `occurrenceHighlight = ${e.occurrenceHighlight}　columnSelection = ${e.columnSelection}`,
    `columnEditorKey = ${e.columnEditorKey}　columnSelectionModifier = ${e.columnSelectionModifier}`,
    `layout.sidebarVisible = ${cfg.layout.sidebarVisible}`,
  ];
}

/** 重新加载 config.json（改完配置免重启生效） */
async function reloadConfig(): Promise<void> {
  try {
    let cfgPath: string | null = null;
    try {
      cfgPath = await invoke<string>("config_path");
    } catch {
      cfgPath = null;
    }
    // 配置若在编辑器标签中改过但未保存，先落盘——否则重新读到的仍是旧值
    if (cfgPath) {
      const tab = tabStore.findByPath(cfgPath);
      if (tab?.dirty) await writeTo(tab, cfgPath);
    }
    const cfg = await loadSettings();
    showMessage("配置已重新加载");
    showConfigReloaded(cfgPath ?? "（未能获取配置路径）", configSummary(cfg));
  } catch (e) {
    window.alert(`重新加载配置失败: ${String(e).split("\n")[0]}`);
  }
}

// ---- 格式化（双通道 + 大文件确认 + 选中级）----

/** 超过此行数，格式化前弹确认 */
const FORMAT_CONFIRM_LINES = 10000;

async function formatCurrent(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  if (blockIfReadonly()) return;
  const key = tab.path ? languageKeyFromPath(tab.path) : null;
  if (editorHandle.view.state.doc.lines > FORMAT_CONFIRM_LINES) {
    const ok = window.confirm(
      `文档超过 ${FORMAT_CONFIRM_LINES} 行，格式化可能耗时较久，继续？`,
    );
    if (!ok) return;
  }
  const result = await formatDocument(editorHandle.view, key, tab.path);
  if (!result.ok) {
    // 不走 window.alert（依赖 dialog 权限且打断流程）：状态栏显示首行 + 控制台完整输出
    showMessage(result.message.split("\n")[0] || "格式化失败");
    console.error("[format]", result.message);
    return;
  }
  showMessage(result.message);
  refreshStatus();
}

async function formatSelectionCurrent(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  if (blockIfReadonly()) return;
  const key = tab.path ? languageKeyFromPath(tab.path) : null;
  const result = await formatSelection(editorHandle.view, key, tab.path);
  if (!result.ok) {
    showMessage(result.message.split("\n")[0] || "格式化失败");
    console.error("[format]", result.message);
    return;
  }
  showMessage(result.message);
  refreshStatus();
}

// ---- 查找结果面板开关（菜单/命令面板共用）----
function toggleResultsPanel(): void {
  if (resultsPanel) {
    resultsPanel.destroy();
    resultsPanel = null;
    return;
  }
  resultsPanel = new SearchResultsPanel(resultsContainer, editorHandle.view);
}

// ---- 大文件只读虚拟视图 ----

/** 延迟构造：工作区恢复可能早于本模块初始化完成，避免取不到 DOM 或触发 TDZ */
let largeViewInstance: LargeView | null = null;

function largeView(): LargeView {
  if (!largeViewInstance) {
    largeViewInstance = new LargeView($("large-view"), {
      onMessage: showMessage,
      onOpenInEditor: (info) => void openLargeInEditor(info),
    });
  }
  return largeViewInstance;
}

function editorColumn(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".editor-column");
}

/** 是否走只读虚拟视图：体积超阈值，或扩展名命中日志列表 */
function needVirtualView(size: number, extension: string): boolean {
  if (size >= settings.largeFileThreshold) return true;
  return extension !== "" && getConfig().largeFile.logExtensions.includes(extension);
}

/** 占位标签首次激活：按分流规则载入内容；返回 false 表示已改走其它路径 */
async function loadPendingTab(tab: Tab): Promise<boolean> {
  const path = tab.path;
  if (!path) return false;
  try {
    const probe = await invoke<{ size: number; extension: string }>("probe_file", { path });
    if (needVirtualView(probe.size, probe.extension)) {
      const info = await invoke<LargeFileInfo>("open_large_file", {
        path,
        anchorBytes: getConfig().largeFile.sparseIndexAnchorBytes,
      });
      tabStore.close(tab.id);
      tabStore.openVirtual(info);
      return false;
    }
    const data = await invoke<FileContent>("open_text_file", {
      path,
      largeFileThreshold: settings.largeFileThreshold,
      logExtensions: getConfig().largeFile.logExtensions,
    });
    tabStore.fillPending(tab.id, data);
    return true;
  } catch (e) {
    tabStore.close(tab.id);
    showMessage(`载入失败：${String(e).split("\n")[0]}`);
    return false;
  }
}

/** 释放大文件会话（标签关闭时调用） */
async function releaseLargeSession(tab: Tab): Promise<void> {
  if (!tab.largeId) return;
  await largeView().cancel();
  try {
    await invoke("close_large_file", { id: tab.largeId });
  } catch {
    // 会话已释放
  }
}

/** 逃生门：改用编辑器打开（超阈值时二次确认） */
async function openLargeInEditor(info: LargeFileInfo): Promise<void> {
  const tab = tabStore.findByPath(info.path);
  if (!tab) return;
  if (info.size >= settings.largeFileThreshold) {
    const mb = Math.round(info.size / 1024 / 1024);
    const ok = window.confirm(
      `文件约 ${mb} MB，以编辑器打开会全量载入内存，可能影响性能。确定继续吗？`,
    );
    if (!ok) return;
  }
  try {
    await invoke("close_large_file", { id: info.id });
    const data = await invoke<FileContent>("open_text_file", {
      path: info.path,
      largeFileThreshold: settings.largeFileThreshold,
      logExtensions: getConfig().largeFile.logExtensions,
    });
    tabStore.convertVirtual(tab.id, data);
    await loadActiveTab();
    showMessage(data.readonly ? `${data.readonly_reason}，已以只读方式打开` : "已在编辑器中打开");
  } catch (e) {
    showMessage(`打开失败：${String(e).split("\n")[0]}`);
  }
}

// ---- 差异比较：未保存改动 / 与另一文件 / 与 Git ----

const diffPanel = new DiffPanel();

/** 导出统一 diff 补丁到 <path>.patch */
async function exportPatch(basePath: string, patch: string): Promise<void> {
  try {
    const written = await invoke<string>("export_patch", { path: basePath, content: patch });
    showMessage(`补丁已导出：${written}`);
  } catch (e) {
    showMessage(`导出失败：${String(e).split("\n")[0]}`);
  }
}

/** 以当前标签为左侧、给定路径为右侧做文件比较 */
async function compareWithPath(rightPath: string): Promise<void> {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    showMessage("请先打开一个磁盘上的文本文件作为比较基准");
    return;
  }
  if (tab.path === rightPath) {
    showMessage("两侧是同一个文件，无需比较");
    return;
  }
  const leftPath = tab.path;
  try {
    const payload = await invoke<DiffPayload>("diff_files", { leftPath, rightPath });
    diffPanel.open(payload, [
      { label: "导出补丁", run: () => void exportPatch(leftPath, payload.patch) },
    ]);
  } catch (e) {
    showMessage(`比较失败：${String(e).split("\n")[0]}`);
  }
}

/** 与系统文件选择器挑选的文件比较 */
async function compareWithPickedFile(): Promise<void> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "所有文件", extensions: ["*"] }],
  });
  if (typeof selected !== "string") return;
  await compareWithPath(selected);
}

/** 以当前激活标签为左侧，与右键点击的标签比较 */
function compareTabs(otherTabId: string): void {
  if (otherTabId === activeTab()?.id) {
    showMessage("请先切换到另一侧标签，或使用「比较 ▸ 与文件…比较」");
    return;
  }
  const other = tabStore.findById(otherTabId);
  if (!other?.path) {
    showMessage("该标签不是磁盘上的文本文件");
    return;
  }
  void compareWithPath(other.path);
}

/** 场景一：当前文件 磁盘内容 ⇄ 编辑中内容 */
async function diffUnsaved(): Promise<void> {
  const tab = activeTab();
  if (!tab || tab.kind !== "text") {
    showMessage("请先打开一个文本文件");
    return;
  }
  if (!tab.dirty) {
    showMessage("当前文件没有未保存改动");
    return;
  }
  try {
    const payload = await invoke<DiffPayload>("diff_texts", {
      leftText: tab.savedContent,
      rightText: tab.content,
      leftLabel: `磁盘 · ${tab.name}`,
      rightLabel: `编辑中 · ${tab.name}`,
    });
    diffPanel.open(payload, [
      {
        label: "还原改动",
        title: "放弃编辑中的内容，回到磁盘版本",
        run: async () => {
          tabStore.setContent(tab.id, tab.savedContent);
          await loadActiveTab();
          diffPanel.close();
          showMessage("已还原为磁盘内容");
        },
      },
      { label: "导出补丁", run: () => void exportPatch(tab.path ?? tab.name, payload.patch) },
    ]);
  } catch (e) {
    showMessage(`比较失败：${String(e).split("\n")[0]}`);
  }
}

/** 场景三：与 Git 比较（scope = worktree 工作区 | index 暂存区） */
async function diffWithGit(scope: "worktree" | "index"): Promise<void> {
  const tab = activeTab();
  if (!tab?.path || tab.kind !== "text") {
    showMessage("请先打开一个磁盘上的文本文件");
    return;
  }
  const path = tab.path;
  try {
    const available = await invoke<boolean>("git_available", { path });
    if (!available) {
      showMessage("当前文件不在 Git 仓库中，无法比较");
      return;
    }
    const payload = await invoke<DiffPayload>("git_diff", { path, scope });
    diffPanel.open(payload, [
      { label: "导出补丁", run: () => void exportPatch(path, payload.patch) },
    ]);
  } catch (e) {
    showMessage(`Git 比较失败：${String(e).split("\n")[0]}`);
  }
}

// ---- 设置中心（Ctrl+, / 菜单 / 命令面板）----
const settingsPanel = new SettingsPanel({
  onSidebarVisible: (visible) => {
    // 仅应用到界面；持久化由 updateSettings 完成
    sidebarVisible = visible;
    document.querySelector(".main")?.classList.toggle("no-sidebar", !visible);
  },
  onSplitRatio: (ratio) => applySplitRatio(ratio),
  onViewMode: (mode) => {
    const tab = activeTab();
    if (tab && pathKindOf(tab.path)) {
      previewModes.set(tab.id, mode);
      refreshPreview();
    }
  },
  onMessage: showMessage,
});

function openSettings(category: "theme" | "keybindings" | "layout" = "theme"): void {
  settingsPanel.open(category);
}

// ---- 侧栏显隐 ----
let sidebarVisible = true;
function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible;
  document.querySelector(".main")?.classList.toggle("no-sidebar", !sidebarVisible);
  persistConfig({ layout: { ...getConfig().layout, sidebarVisible } });
}

// ---- 侧栏宽度拖拽（比例记忆于 localStorage，双击复位）----
const DEFAULT_SIDEBAR_WIDTH = 240;
let sidebarResizing = false;

function setSidebarWidth(px: number): void {
  const clamped = Math.min(640, Math.max(150, px));
  document
    .querySelector<HTMLElement>(".main")
    ?.style.setProperty("--sidebar-width", `${clamped}px`);
  try {
    localStorage.setItem("my-editor.sidebarWidth", String(clamped));
  } catch {
    // localStorage 不可用时仅会话内生效
  }
}

const sidebarResizerEl = document.getElementById("sidebar-resizer");
sidebarResizerEl?.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  sidebarResizing = true;
  sidebarResizerEl.classList.add("dragging");
  document.body.classList.add("dragging-split");
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!sidebarResizing) return;
  const main = document.querySelector(".main");
  if (!main) return;
  setSidebarWidth(e.clientX - main.getBoundingClientRect().left);
});
window.addEventListener("mouseup", () => {
  if (!sidebarResizing) return;
  sidebarResizing = false;
  sidebarResizerEl?.classList.remove("dragging");
  document.body.classList.remove("dragging-split");
});
sidebarResizerEl?.addEventListener("dblclick", () =>
  setSidebarWidth(DEFAULT_SIDEBAR_WIDTH),
);
try {
  const savedSidebar = localStorage.getItem("my-editor.sidebarWidth");
  if (savedSidebar) setSidebarWidth(Number(savedSidebar));
} catch {
  // 同上
}

// ---- 标签页导航（上一个/下一个）----
function switchTab(delta: number): void {
  const tabs = tabStore.list();
  if (tabs.length === 0) return;
  const idx = tabs.findIndex((t) => t.id === tabStore.active()?.id);
  const next = tabs[(idx + delta + tabs.length) % tabs.length];
  if (next) tabStore.activate(next.id);
}

$<HTMLButtonElement>("nav-prev").addEventListener("click", () => switchTab(-1));
$<HTMLButtonElement>("nav-next").addEventListener("click", () => switchTab(1));
$<HTMLButtonElement>("search-box").addEventListener("click", () => palette.open());
$<HTMLButtonElement>("btn-sidebar-toggle").addEventListener("click", () => toggleSidebar());

// 调试面板开关（免去按 F12；命令属 core webview 插件而非 window，且仅 debug 构建存在）
const devtoolsBtn = $<HTMLButtonElement>("btn-devtools");
if (import.meta.env.DEV) {
  devtoolsBtn.addEventListener("click", () => {
    void invoke("plugin:webview|internal_toggle_devtools").catch((e) =>
      console.error("[devtools] 切换失败", e),
    );
  });
} else {
  devtoolsBtn.hidden = true;
}

// ---- 菜单栏（参考布局：文件/编辑/选择/查看/转到）----
new MenuBar($("menubar"), [
  {
    id: "file",
    label: "文件(F)",
    items: [
      { label: "打开文件…", shortcut: "Ctrl+O", run: () => void openFileDialog() },
      { label: "新建", shortcut: "Ctrl+N", run: () => newUntitled() },
      { label: "保存", shortcut: "Ctrl+S", run: () => void saveFile() },
      { label: "另存为…", shortcut: "Ctrl+Shift+S", run: () => void saveFileAs() },
      { separator: true },
      { label: "打开目录（工作区）…", run: () => void openWorkspaceDir() },
      { separator: true },
      {
        label: "关闭标签",
        shortcut: "Ctrl+W",
        run: () => {
          const tab = activeTab();
          if (tab) void closeTab(tab.id);
        },
      },
      { label: "退出", shortcut: "Ctrl+Q", run: () => void appWindow.close() },
    ],
  },
  {
    id: "edit",
    label: "编辑(E)",
    items: [
      { label: "撤销", shortcut: "Ctrl+Z", run: () => void undo(editorHandle.view) },
      { label: "重做", shortcut: "Ctrl+Shift+Z", run: () => void redo(editorHandle.view) },
      { separator: true },
      { label: "格式化文档", shortcut: "Shift+Alt+F", run: () => void formatCurrent() },
      { label: "格式化选中内容", run: () => void formatSelectionCurrent() },
      { separator: true },
      { label: "全局查找…", shortcut: "Ctrl+Shift+F", run: () => showGlobalSearch() },
      { separator: true },
      { label: "列编辑器", shortcut: "Alt+C", run: () => { if (!blockIfReadonly()) openColumnEditor(editorHandle.view); } },
      { label: "命令面板", shortcut: "Ctrl+Shift+P", run: () => palette.open() },
    ],
  },
  {
    id: "select",
    label: "选择(S)",
    items: [
      {
        label: "全选",
        shortcut: "Ctrl+A",
        run: () => {
          const len = editorHandle.view.state.doc.length;
          editorHandle.view.dispatch({ selection: { anchor: 0, head: len } });
        },
      },
    ],
  },
  {
    id: "view",
    label: "查看(V)",
    items: [
      {
        label: "切换空白字符显示",
        run: () => toggleWhitespacePersisted(),
      },
      { label: "查找结果面板", run: () => toggleResultsPanel() },
      { separator: true },
      { label: "切换侧栏", shortcut: "Ctrl+B", run: () => toggleSidebar() },
    ],
  },
  {
    id: "go",
    label: "转到(G)",
    items: [
      { label: "上一个标签", shortcut: "Ctrl+PageUp", run: () => switchTab(-1) },
      { label: "下一个标签", shortcut: "Ctrl+PageDown", run: () => switchTab(1) },
      { separator: true },
      { label: "下一个书签", shortcut: "F2", run: () => gotoBookmark(editorHandle.view, 1) },
      { label: "上一个书签", shortcut: "Shift+F2", run: () => gotoBookmark(editorHandle.view, -1) },
    ],
  },
  {
    id: "compare",
    label: "比较",
    items: [
      { label: "与磁盘内容比较（未保存改动）", run: () => void diffUnsaved() },
      { label: "与文件…比较", run: () => void compareWithPickedFile() },
      { separator: true },
      { label: "与 Git HEAD 比较", run: () => void diffWithGit("worktree") },
      { label: "与 Git 暂存区比较", run: () => void diffWithGit("index") },
    ],
  },
  {
    id: "settings",
    label: "设置",
    items: [
      { label: "设置…", shortcut: "Ctrl+,", run: () => openSettings() },
      { separator: true },
      { label: "配置说明", run: () => showSettingsHelp() },
      { label: "打开配置文件（config.json）", run: () => void openConfigFile() },
      { label: "重新加载配置", run: () => void reloadConfig() },
    ],
  },
]);

// ---- 命令面板 ----

palette.registerAll([
  { id: "file.open", title: "打开文件…", section: "文件", run: () => void openFileDialog() },
  { id: "file.new", title: "新建未命名文档", section: "文件", run: () => newUntitled() },
  { id: "file.save", title: "保存", section: "文件", run: () => void saveFile() },
  { id: "file.saveAs", title: "另存为…", section: "文件", run: () => void saveFileAs() },
  { id: "file.closeTab", title: "关闭当前标签", section: "文件", run: () => {
      const tab = activeTab();
      if (tab) void closeTab(tab.id);
    } },
  { id: "workspace.openDir", title: "打开目录（工作区）", section: "工作区", run: () => void openWorkspaceDir() },
  { id: "diff.unsaved", title: "比较：与磁盘内容（未保存改动）", section: "比较", run: () => void diffUnsaved() },
  { id: "diff.pickFile", title: "比较：与文件…", section: "比较", run: () => void compareWithPickedFile() },
  { id: "diff.gitHead", title: "比较：与 Git HEAD", section: "比较", run: () => void diffWithGit("worktree") },
  { id: "diff.gitIndex", title: "比较：与 Git 暂存区", section: "比较", run: () => void diffWithGit("index") },
  { id: "settings.open", title: "打开设置…", section: "设置", run: () => openSettings() },
  { id: "settings.openKeybindings", title: "设置：快捷键", section: "设置", run: () => openSettings("keybindings") },
  { id: "settings.openLayout", title: "设置：页面布局", section: "设置", run: () => openSettings("layout") },
  { id: "config.openFile", title: "打开配置文件（config.json）", section: "设置", run: () => void openConfigFile() },
  { id: "config.reload", title: "重新加载配置（config.json）", section: "设置", run: () => void reloadConfig() },
  { id: "help.settings", title: "配置说明（字段含义与生效方式）", section: "设置", run: () => showSettingsHelp() },
  { id: "edit.format", title: "格式化文档（Shift+Alt+F）", section: "编辑", run: () => void formatCurrent() },
  { id: "edit.formatSelection", title: "格式化选中内容", section: "编辑", run: () => void formatSelectionCurrent() },
  { id: "edit.columnEditor", title: "列编辑器（Alt+C）", section: "编辑", run: () => { if (!blockIfReadonly()) openColumnEditor(editorHandle.view); } },
  { id: "edit.toggleWhitespace", title: "切换空白字符显示", section: "编辑", run: () => toggleWhitespacePersisted() },
  { id: "search.results", title: "查找结果面板", section: "查找", run: () => toggleResultsPanel() },
  { id: "search.global", title: "全局查找…（Ctrl+Shift+F）", section: "查找", run: () => showGlobalSearch() },
  { id: "search.toggleBookmark", title: "切换书签（Ctrl+F2）", section: "查找", run: () => toggleBookmark(editorHandle.view) },
  { id: "search.nextBookmark", title: "下一个书签（F2）", section: "查找", run: () => gotoBookmark(editorHandle.view, 1) },
  { id: "insert.localTime", title: "插入本地时间（YYYY-MM-DD HH:mm:ss）", section: "插入", run: () => insertAtCursor(localStamps().local) },
  { id: "insert.isoTime", title: "插入 ISO 时间戳", section: "插入", run: () => insertAtCursor(localStamps().iso) },
  { id: "insert.unixTime", title: "插入 Unix 时间戳", section: "插入", run: () => insertAtCursor(localStamps().unix) },
  { id: "insert.date", title: "插入日期（YYYY-MM-DD）", section: "插入", run: () => insertAtCursor(localStamps().date) },
  { id: "insert.time", title: "插入时间（HH:mm:ss）", section: "插入", run: () => insertAtCursor(localStamps().time) },
  { id: "insert.uuid", title: "插入 UUID（v4）", section: "插入", run: () => insertAtCursor(newUuid()) },
]);

async function openWorkspaceDir(): Promise<void> {
  const dir = await pickDirectory();
  if (!dir) return;
  workspaceRoot = dir;
  fileTree.setRoot(dir);
  persistWorkspaceWithExpanded([]);
}

// ---- 快捷键（注册表驱动；设置中心可重绑定，见 config/keybindings.ts）----
// 捕获阶段 + e.code（物理键位）：
// 1) CM6 在冒泡链上游消费按键，挂 window 冒泡会收不到；
// 2) 中文 IME / 不同键盘布局下 e.key 不可靠，e.code 稳定。
// 记法："Mod-Shift-P" / "Alt-C" / "Mod-,"；用户覆盖存 config.json 的 keybindings 段。
registerKeyCommands([
  // 文件
  { id: "file.save", title: "保存", section: "文件", defaultKey: "Mod-S", run: () => void saveFile() },
  { id: "file.saveAs", title: "另存为…", section: "文件", defaultKey: "Mod-Shift-S", run: () => void saveFileAs() },
  { id: "file.open", title: "打开文件…", section: "文件", defaultKey: "Mod-O", run: () => void openFileDialog() },
  { id: "file.new", title: "新建", section: "文件", defaultKey: "Mod-N", run: () => newUntitled() },
  { id: "file.closeTab", title: "关闭标签", section: "文件", defaultKey: "Mod-W", run: () => {
      const tab = activeTab();
      if (tab) void closeTab(tab.id);
    } },
  { id: "file.quit", title: "退出", section: "文件", defaultKey: "Mod-Q", run: () => void appWindow.close() },
  // 编辑
  { id: "edit.format", title: "格式化文档", section: "编辑", defaultKey: "Shift-Alt-F",
    // 备用键：中文 Windows 下 Alt+Shift 常被输入法/系统热键吞掉
    altKeys: ["Mod-Shift-L"],
    run: () => void formatCurrent() },
  // 查找
  { id: "search.find", title: "查找（当前文档）", section: "查找", defaultKey: "Mod-F", run: () => {
      // 只读文档的编辑器 DOM 不可聚焦，CM6 自身键位收不到按键，故全局兜底放行
      if (activeTab()?.kind !== "text") return;
      openSearchPanel(editorHandle.view);
    } },
  { id: "search.replace", title: "替换（当前文档）", section: "查找", defaultKey: "Mod-H", run: () => {
      const tab = activeTab();
      if (tab?.kind !== "text") return;
      openSearchPanel(editorHandle.view);
      // 面板内替换框（只读文档不渲染替换框，退化为仅查找）
      editorHandle.view.dom.querySelector<HTMLInputElement>('input[name="replace"]')?.focus();
    } },
  { id: "search.global", title: "全局查找…", section: "查找", defaultKey: "Mod-Shift-F", run: () => showGlobalSearch() },
  { id: "search.results", title: "查找结果面板", section: "查找", defaultKey: "", run: () => toggleResultsPanel() },
  // 视图
  { id: "view.commandPalette", title: "命令面板", section: "视图", defaultKey: "Mod-Shift-P", run: () => palette.toggle() },
  { id: "view.toggleSidebar", title: "切换侧栏", section: "视图", defaultKey: "Mod-B", run: () => toggleSidebar() },
  { id: "view.settings", title: "打开设置…", section: "视图", defaultKey: "Mod-,", run: () => openSettings() },
  { id: "view.toggleWhitespace", title: "切换空白字符显示", section: "视图", defaultKey: "", run: () => toggleWhitespacePersisted() },
  { id: "view.prevTab", title: "上一个标签", section: "视图", defaultKey: "Mod-PageUp", run: () => switchTab(-1) },
  { id: "view.nextTab", title: "下一个标签", section: "视图", defaultKey: "Mod-PageDown", run: () => switchTab(1) },
  // ---- 以下为编辑器内置（CM6）绑定，仅展示不可重绑 ----
  { id: "edit.undo", title: "撤销", section: "编辑", defaultKey: "Mod-Z", fixed: true, run: () => void undo(editorHandle.view) },
  { id: "edit.redo", title: "重做", section: "编辑", defaultKey: "Mod-Shift-Z", fixed: true, run: () => void redo(editorHandle.view) },
  { id: "edit.comment", title: "切换注释", section: "编辑", defaultKey: "Mod-/", fixed: true, run: () => {} },
  { id: "edit.deleteLine", title: "删除当前行", section: "编辑", defaultKey: "Mod-D", fixed: true, run: () => {} },
  { id: "edit.copyLineUp", title: "复制行到上方", section: "编辑", defaultKey: "Mod-Alt-Up", fixed: true, run: () => {} },
  { id: "edit.copyLineDown", title: "复制行到下方", section: "编辑", defaultKey: "Mod-Alt-Down", fixed: true, run: () => {} },
  { id: "edit.moveLineUp", title: "上移当前行", section: "编辑", defaultKey: "Alt-Up", fixed: true, run: () => {} },
  { id: "edit.moveLineDown", title: "下移当前行", section: "编辑", defaultKey: "Alt-Down", fixed: true, run: () => {} },
  { id: "edit.columnEditor", title: "列编辑器", section: "编辑", defaultKey: "Alt-C", fixed: true, run: () => {
      if (!blockIfReadonly()) openColumnEditor(editorHandle.view);
    } },
  { id: "search.toggleBookmark", title: "切换书签", section: "查找", defaultKey: "Mod-F2", fixed: true, run: () => toggleBookmark(editorHandle.view) },
  { id: "search.nextBookmark", title: "下一个书签", section: "查找", defaultKey: "F2", fixed: true, run: () => gotoBookmark(editorHandle.view, 1) },
  { id: "search.prevBookmark", title: "上一个书签", section: "查找", defaultKey: "Shift-F2", fixed: true, run: () => gotoBookmark(editorHandle.view, -1) },
]);

// 列编辑器当前键位加入保留集：全局命令不得抢占（其自身经 editorEnhancements.columnEditorKey 改绑）
setExtraReservedKeys([settings.columnEditorKey]);

window.addEventListener(
  "keydown",
  (e) => {
    const cmd = matchKeyCommand(e, getConfig());
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    cmd.run();
  },
  true,
);

// ---- 启动：恢复工作区 ----

async function bootstrap(): Promise<void> {
  // 1) 载入配置：编辑器扩展与语言映射依赖它（订阅回调会热更新编辑器 + 应用主题/状态栏）
  await loadSettings();
  // 2) 布局项：侧栏显隐按 config.layout 恢复
  sidebarVisible = getConfig().layout.sidebarVisible;
  document.querySelector(".main")?.classList.toggle("no-sidebar", !sidebarVisible);
  // 3) 分栏默认比例：localStorage 无记录时按配置（不写回，留给用户拖动/设置时落盘）
  if (!localStorage.getItem("my-editor.splitRatio")) {
    editorArea.style.setProperty(
      "--split-ratio",
      `${Math.round(getConfig().layout.splitRatio * 100)}%`,
    );
  }
  // 4) 列编辑器键位随配置刷新保留集
  setExtraReservedKeys([settings.columnEditorKey]);

  let state: WorkspaceState;
  try {
    state = await loadWorkspace();
  } catch {
    state = { root: null, expanded: [], open_files: [], active_file: null };
  }
  workspaceRoot = state.root;
  if (state.root) {
    fileTree.setRoot(state.root, state.expanded);
    wsName.textContent = state.root.split(/[\\/]/).pop() || state.root;
    wsName.title = state.root;
  }
  // 恢复打开的文件：当前文件即时载入，其余先建占位标签（首次激活时才读盘）
  if (state.active_file) {
    await openFilePath(state.active_file, { silent: true });
  }
  for (const path of state.open_files) {
    if (path === state.active_file) continue;
    tabStore.openPending(path, path.split(/[\\/]/).pop() ?? path);
  }
  const target = state.active_file
    ? tabStore.findByPath(state.active_file)
    : tabStore.list()[0];
  if (target) tabStore.activate(target.id);
}

void bootstrap();
