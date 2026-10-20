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
import {
  formatDocument,
  formatSelection,
  supportsFormatting,
} from "./editor/format";
import { openColumnEditor } from "./editor/columnEditor";
import { toggleBookmark, gotoBookmark } from "./editor/bookmarks";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { FileTree, createEntryIcon } from "./panels/fileTree";
import { CommandPalette } from "./panels/commandPalette";
import { MenuBar } from "./panels/menubar";
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
import { confirmAction, confirmCloseDirty } from "./ui/dialogs";
import { showConfigReloaded, showSettingsHelp } from "./ui/settingsHelp";
import { placeMenu } from "./ui/menu";
import {
  loadWorkspace,
  saveWorkspaceDebounced,
  pickDirectory,
  type WorkspaceState,
} from "./services/workspace";
import {
  loadSession,
  saveSessionDebounced,
  writeDraft,
  deleteDraft,
  listDrafts,
  readDraft,
  cleanupDrafts,
  type DraftInfo,
  type SessionFile,
} from "./services/session";
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
import {
  DiffPanel,
  type DiffAction,
  type DiffPayload,
  type DiffRow,
  type HunkAdopt,
} from "./panels/diffPanel";
import { LargeView, type LargeFileInfo } from "./panels/largeView";
import { CronPanel } from "./panels/cronPanel";
import { BatchEncodingPanel } from "./panels/batchEncoding";
import { RegexTesterPanel } from "./panels/regexTester";
import { MarkdownTableDialog } from "./panels/tableDialog";
import { RecentFilesDialog, pushRecentFile } from "./panels/recentFiles";
import { SaveEncodingDialog } from "./panels/saveEncoding";
import { RunPanel } from "./panels/runPanel";
import { applyCase, applyJson, CASE_LABELS, type CaseMode } from "./editor/transforms";
import { insertTable, toggleWrap } from "./editor/markdownTools";
import { onFileChanged, watchFiles } from "./services/fsWatch";
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
const breadcrumbEl = $<HTMLDivElement>("breadcrumb");
const runBtn = $<HTMLButtonElement>("btn-run");
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
const statusDraft = $<HTMLSpanElement>("status-draft");
const statusExternal = $<HTMLSpanElement>("status-external");

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

// ---- 状态栏语言菜单（手动覆盖高亮语言，交互与编码一致）----

let languageMenu: HTMLElement | null = null;

function closeLanguageMenu(): void {
  languageMenu?.remove();
  languageMenu = null;
}

/** 生效的语言：手动覆盖 > 扩展名映射 > 纯文本 */
function effectiveLanguage(tab: Tab): string | null {
  if (tab.languageOverride !== undefined) return tab.languageOverride;
  return tab.path ? languageKeyFromPath(tab.path) : null;
}

/** 状态栏语言文案（手动覆盖时加标注） */
function languageLabel(tab: Tab): string {
  const key = effectiveLanguage(tab);
  const name = key ? (languageDisplayNames[key] ?? key) : "纯文本";
  return tab.languageOverride !== undefined ? `${name}（手动）` : name;
}

function showLanguageMenu(x: number, y: number): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text") {
    showMessage("当前文件不支持切换语言");
    return;
  }
  if (tab.virtual) {
    showMessage("大文件只读视图不支持切换语言");
    return;
  }
  closeLanguageMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  const header = document.createElement("div");
  header.className = "context-menu-item";
  header.style.opacity = "0.6";
  header.style.cursor = "default";
  header.textContent = `当前语言：${languageLabel(tab)}`;
  menu.append(header);

  // 自动项 + 纯文本 + 全部已注册语言
  const auto = tab.path ? languageKeyFromPath(tab.path) : null;
  const entries: { value: string | null | undefined; label: string }[] = [
    { value: undefined, label: `自动（${auto ? (languageDisplayNames[auto] ?? auto) : "纯文本"}）` },
    { value: null, label: "纯文本" },
    ...Object.keys(languageDisplayNames)
      .filter((key) => key !== "plaintext")
      .map((key) => ({ value: key as string | null, label: languageDisplayNames[key] })),
  ];
  for (const entry of entries) {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.textContent = tab.languageOverride === entry.value ? `${entry.label} ✓` : entry.label;
    el.addEventListener("click", () => {
      closeLanguageMenu();
      void applyLanguageOverride(tab.id, entry.value);
    });
    menu.append(el);
  }

  document.body.append(menu);
  placeMenu(menu, x, y);
  languageMenu = menu;
}

/** 应用语言模式：更新标签状态 + 编辑器高亮（不重载内容） */
async function applyLanguageOverride(
  tabId: string,
  override: string | null | undefined,
): Promise<void> {
  tabStore.setLanguageOverride(tabId, override);
  const tab = tabStore.findById(tabId);
  if (!tab) return;
  if (tabStore.active()?.id === tabId) await editorHandle.setLanguage(override);
  refreshStatus();
  showMessage(`语言模式：${languageLabel(tab)}`);
}

statusLanguage.title = "点击切换高亮语言";
statusLanguage.style.cursor = "pointer";
statusLanguage.addEventListener("click", (e) => {
  e.stopPropagation();
  showLanguageMenu(e.clientX, e.clientY);
});
document.addEventListener("click", () => closeLanguageMenu());

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

/** 重新打开为：按新编码重新解读磁盘字节（不写盘） */
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
    // 编码已变更：旧结论失效，按新解读重新检测
    tabStore.setMojibake(tabId, "", "");
    if (tabStore.active()?.id === tabId) {
      await loadActiveTab();
      void checkMojibake(tabId);
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

// ---- 乱码检测（打开文件后自动诊断；只提示，不改文件、不自动切编码）----

/** 自动检测的文件体积上限（更大文件跳过，避免重复读盘） */
const MOJIBAKE_MAX_BYTES = 5 * 1024 * 1024;

interface MojibakeReport {
  suspicious: boolean;
  suggested: string;
  severity: number;
  reason: string;
}

/** 对标签做一次乱码检测并记录结论；只读标签同样适用（检测不改内容） */
async function checkMojibake(tabId: string): Promise<void> {
  const tab = tabStore.findById(tabId);
  if (!tab || tab.kind !== "text" || !tab.path || tab.pending || tab.virtual) return;
  if (tab.size > MOJIBAKE_MAX_BYTES) return;
  try {
    const report = await invoke<MojibakeReport>("detect_mojibake", {
      path: tab.path,
      text: tab.content,
      current: tab.encoding,
    });
    const current = tabStore.findById(tabId);
    if (!current) return;
    tabStore.setMojibake(
      tabId,
      report.suspicious ? report.suggested : "",
      report.suspicious ? report.reason : "",
    );
    if (report.suspicious && tabStore.active()?.id === tabId) {
      showMessage(report.reason);
    }
  } catch (e) {
    console.warn("[mojibake] 检测失败", e);
  }
}

/** 命令面板入口：对当前标签立即重检并给出可选建议 */
function detectMojibakeManually(): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    showMessage("请先打开一个磁盘上的文本文件");
    return;
  }
  if (tab.virtual) {
    showMessage("大文件只读视图不支持乱码检测");
    return;
  }
  void (async () => {
    await checkMojibake(tab.id);
    const fresh = tabStore.findById(tab.id);
    if (!fresh) return;
    if (!fresh.mojibakeReason) {
      showMessage("未检测到乱码");
      return;
    }
    if (fresh.mojibakeSuggested) {
      const ok = await confirmAction(
        `${fresh.mojibakeReason}。是否立即重新打开为 ${fresh.mojibakeSuggested}？`,
        "重新打开",
      );
      if (ok) await reopenWithEncoding(fresh.id, fresh.mojibakeSuggested);
    } else {
      showMessage(fresh.mojibakeReason);
    }
  })();
}

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

/** 工作区根目录（root/expanded 由文件树维护并落 workspace.json） */
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
  statusEncoding.textContent = tab
    ? `${tab.encoding}${tab.mojibakeReason ? " ⚠" : ""}`
    : "UTF-8";
  statusEncoding.title = tab?.mojibakeReason
    ? `${tab.mojibakeReason}（点击切换编码）`
    : "点击切换编码（重新打开为…）";
  statusNewline.textContent = tab ? tab.newline : "—";
  statusLanguage.textContent = tab ? languageLabel(tab) : "纯文本";
  statusDirty.classList.toggle("hidden", !tab?.dirty);
  statusExternal.classList.toggle("hidden", tab?.externallyChanged !== true);
  statusReadonly.classList.toggle("hidden", tab?.readonly !== true);
  statusReadonly.title = tab?.readonly ? tab.readonlyReason : "";
  refreshWhitespace();
  refreshRunButton();
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
  // 标签过多溢出时，将激活标签滚入视野
  tabsBar
    .querySelector<HTMLElement>(".tab.active")
    ?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

// ---- 路径面包屑 ----

/** 磁盘根（如 "D:"）与根之后的各级 */
function splitAbsolutePath(path: string): { base: string; parts: string[] } {
  const p = path.replace(/\//g, "\\");
  const drive = /^([A-Za-z]:)(?:\\(.*))?$/.exec(p);
  if (drive) {
    return { base: drive[1], parts: drive[2] ? drive[2].split("\\").filter(Boolean) : [] };
  }
  if (p.startsWith("\\\\")) {
    const segs = p.slice(2).split("\\").filter(Boolean);
    return { base: `\\\\${segs.slice(0, 2).join("\\")}`, parts: segs.slice(2) };
  }
  return { base: "", parts: p.split("\\").filter(Boolean) };
}

/** 相对工作区根目录的层级；文件不在工作区内时返回 null */
function workspaceRelativeParts(path: string): string[] | null {
  if (!workspaceRoot) return null;
  const norm = (s: string) => s.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const root = norm(workspaceRoot);
  const target = norm(path);
  if (target === root) return [];
  if (!target.startsWith(`${root}\\`)) return null;
  const rootLen = workspaceRoot.replace(/[\\/]+$/, "").length;
  return path.slice(rootLen + 1).split(/[\\/]/).filter(Boolean);
}

/** 面包屑条目：dir 有值可下拉；无值为当前文件 */
interface Crumb {
  label: string;
  dir?: string;
}

function breadcrumbCrumbs(tab: Tab): Crumb[] {
  if (!tab.path) return [{ label: tab.name }];
  const rel = workspaceRelativeParts(tab.path);
  if (rel && rel.length > 0) {
    const root = workspaceRoot!.replace(/[\\/]+$/, "");
    const crumbs: Crumb[] = [];
    let acc = root;
    rel.forEach((label, i) => {
      acc = `${acc}\\${label}`;
      crumbs.push(i === rel.length - 1 ? { label } : { label, dir: acc });
    });
    return crumbs;
  }
  const { base, parts } = splitAbsolutePath(tab.path);
  const crumbs: Crumb[] = base ? [{ label: base, dir: base }] : [];
  let acc = base;
  parts.forEach((label, i) => {
    acc = acc ? `${acc}\\${label}` : label;
    crumbs.push(i === parts.length - 1 ? { label } : { label, dir: acc });
  });
  return crumbs;
}

let breadcrumbMenu: HTMLElement | null = null;
let breadcrumbMenuDir: string | null = null;

function closeBreadcrumbMenu(): void {
  breadcrumbMenu?.remove();
  breadcrumbMenu = null;
  breadcrumbMenuDir = null;
}

/** 展开目录内容预览；点击子目录继续下钻，点击文件快速打开 */
async function fillBreadcrumbMenu(
  menu: HTMLElement,
  dir: string,
  anchor: HTMLElement,
): Promise<void> {
  breadcrumbMenuDir = dir;
  menu.innerHTML = "";

  const title = document.createElement("div");
  title.className = "bc-title";
  title.textContent = dir;
  title.title = dir;
  menu.append(title);

  const place = (): void => {
    const rect = anchor.getBoundingClientRect();
    placeMenu(menu, rect.left, rect.bottom + 2);
  };
  place();

  let entries: { name: string; path: string; is_dir: boolean }[];
  try {
    entries = await invoke("list_dir", { path: dir });
  } catch (e) {
    const err = document.createElement("div");
    err.className = "bc-empty";
    err.textContent = `读取失败：${String(e).split("\n")[0]}`;
    menu.append(err);
    place();
    return;
  }

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "bc-empty";
    empty.textContent = "（空目录）";
    menu.append(empty);
    place();
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "bc-entry";
    const icon = document.createElement("span");
    icon.className = "bc-icon";
    icon.append(createEntryIcon(entry.name, entry.is_dir));
    const name = document.createElement("span");
    name.className = "bc-name";
    name.textContent = entry.name;
    row.append(icon, name);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (entry.is_dir) {
        void fillBreadcrumbMenu(menu, entry.path, anchor);
      } else {
        closeBreadcrumbMenu();
        void openFilePath(entry.path);
      }
    });
    menu.append(row);
  }
  place();
}

async function showBreadcrumbMenu(dir: string, anchor: HTMLElement): Promise<void> {
  // 再次点击同一层级＝收起
  if (breadcrumbMenu && breadcrumbMenuDir === dir) {
    closeBreadcrumbMenu();
    return;
  }
  closeBreadcrumbMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu breadcrumb-menu";
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(menu);
  breadcrumbMenu = menu;
  await fillBreadcrumbMenu(menu, dir, anchor);
}

/** 渲染当前标签的面包屑：工作区内从子目录开始，工作区外用绝对路径 */
function renderBreadcrumb(): void {
  closeBreadcrumbMenu();
  breadcrumbEl.innerHTML = "";
  const tab = activeTab();
  breadcrumbEl.classList.toggle("hidden", !tab);
  if (!tab) return;

  const crumbs = breadcrumbCrumbs(tab);
  crumbs.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = ">";
      breadcrumbEl.append(sep);
    }
    const el = document.createElement("span");
    el.className = crumb.dir ? "breadcrumb-item" : "breadcrumb-item current";
    el.textContent = crumb.label;
    el.title = crumb.dir ?? tab.path ?? tab.name;
    if (crumb.dir) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        void showBreadcrumbMenu(crumb.dir!, el);
      });
    }
    breadcrumbEl.append(el);
  });
}

document.addEventListener("click", () => closeBreadcrumbMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeBreadcrumbMenu();
});

// 标签过多时支持鼠标滚轮横向滚动
tabsBar.addEventListener(
  "wheel",
  (e) => {
    // 未溢出时不拦截滚动，交给默认行为
    if (e.deltaY === 0 || tabsBar.scrollWidth <= tabsBar.clientWidth) return;
    tabsBar.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false },
);

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
  // 关闭前把未保存内容落草稿，避免静默丢弃（已保存则顺带清除草稿）
  if (tab.dirty) await persistDraft(id);
  tabStore.close(id);
  previewModes.delete(id);
  cursorPos.delete(id);
  draftKeys.delete(id);
  const timer = draftTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    draftTimers.delete(id);
  }
  void releaseLargeSession(tab);
}

/** 标签页状态变化 → 重渲染 + 同步编辑器内容 + 持久化会话 */
tabStore.subscribe(() => {
  const prevActiveId = currentLoadedTabId;
  renderTabs();
  renderBreadcrumb();
  refreshStatus();
  refreshDraftBadge();
  if (tabStore.active()?.id !== prevActiveId) {
    void loadActiveTab();
  }
  persistSession();
  syncWatchedFilesDebounced();
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
  await editorHandle.loadDocument(tab.path ?? "", tab.content, tab.readonly, tab.languageOverride);
  applyRestoredCursor(tab);
  // 文件树联动：展开祖先目录并高亮当前文件
  if (tab.path) fileTree.revealPath(tab.path);
  // 预览联动：按标签类型应用 编辑/预览/双栏 或图片查看器
  refreshPreview();
  resultsPanel?.refresh();
}

// ---- 工作区持久化（根目录与展开状态） ----

function persistWorkspaceWithExpanded(expanded: string[]): void {
  saveWorkspaceDebounced({ root: workspaceRoot, expanded });
}

// ---- 会话与草稿持久化 ----

/** 各标签最近光标位置（会话恢复用） */
const cursorPos = new Map<string, { line: number; col: number }>();

/** 会话恢复待应用的光标位置：文件路径 → 位置（标签首次载入后消费） */
const restoredCursors = new Map<string, { line: number; col: number }>();

/** 标签载入后应用会话恢复的光标位置 */
function applyRestoredCursor(tab: Tab | null): void {
  if (!tab?.path) return;
  const pos = restoredCursors.get(tab.path);
  if (!pos) return;
  restoredCursors.delete(tab.path);
  cursorPos.set(tab.id, { line: pos.line, col: pos.col });
  const view = editorHandle.view;
  const line = view.state.doc.line(Math.min(Math.max(1, pos.line), view.state.doc.lines));
  const anchor = Math.min(line.from + Math.max(0, pos.col - 1), line.to);
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
}

/** 当前存在草稿的标签 id → 草稿 key */
const draftKeys = new Map<string, string>();

/** 每标签的草稿写入防抖定时器 */
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();

function currentSplitRatio(): number | null {
  try {
    const v = localStorage.getItem("my-editor.splitRatio");
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

/** 落 session.json：打开文件列表（含光标）+ 激活文件 + 分栏比例 */
function persistSession(): void {
  const openFiles: SessionFile[] = [];
  for (const tab of tabStore.list()) {
    if (tab.kind !== "text" || !tab.path) continue;
    const pos = cursorPos.get(tab.id);
    openFiles.push({ path: tab.path, line: pos?.line ?? 1, col: pos?.col ?? 1 });
  }
  saveSessionDebounced({
    openFiles,
    activeFile: activeTab()?.path ?? null,
    splitRatio: currentSplitRatio(),
  });
}

/** 草稿只针对可编辑的普通文本标签（大文件虚拟视图 / 只读 / 占位标签不写） */
function draftable(tab: Tab): boolean {
  return tab.kind === "text" && !tab.virtual && !tab.pending && !tab.readonly;
}

/** 草稿标识：文件路径；未命名标签用其标签 id */
function draftKeyFor(tab: Tab): string {
  return tab.path || `untitled:${tab.id}`;
}

/** 输入后防抖写草稿（配置关闭时不写） */
function scheduleDraftSave(tab: Tab): void {
  if (!getConfig().session.draftAutosave || !draftable(tab)) return;
  const pending = draftTimers.get(tab.id);
  if (pending) clearTimeout(pending);
  draftTimers.set(
    tab.id,
    setTimeout(() => {
      draftTimers.delete(tab.id);
      void persistDraft(tab.id);
    }, getConfig().session.draftDebounceMs),
  );
}

/** 写草稿：内容与磁盘一致时清除，否则写入并标记「草稿已存」 */
async function persistDraft(tabId: string): Promise<void> {
  const tab = tabStore.findById(tabId);
  if (!tab || !draftable(tab)) return;
  if (!tab.dirty) {
    await discardDraft(tabId);
    return;
  }
  const key = draftKeyFor(tab);
  try {
    await writeDraft({
      key,
      path: tab.path,
      name: tab.name,
      content: tab.content,
      encoding: tab.encoding,
      newline: tab.newline,
      hasBom: tab.has_bom,
    });
    draftKeys.set(tabId, key);
    refreshDraftBadge();
  } catch (e) {
    console.warn("[draft] 写入失败", e);
  }
}

/** 删除草稿（保存成功 / 用户丢弃 / 内容回到基线时） */
async function discardDraft(tabId: string): Promise<void> {
  const timer = draftTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    draftTimers.delete(tabId);
  }
  const tab = tabStore.findById(tabId);
  const key = draftKeys.get(tabId) ?? (tab ? draftKeyFor(tab) : null);
  draftKeys.delete(tabId);
  if (!key) return;
  try {
    await deleteDraft(key);
  } catch {
    // 草稿不存在或删除失败：忽略
  }
  refreshDraftBadge();
}

/** 状态栏「草稿已存」标记：仅激活标签存在草稿时显示 */
function refreshDraftBadge(): void {
  const tab = activeTab();
  statusDraft.classList.toggle("hidden", !tab || !draftKeys.has(tab.id));
}

/** 草稿时间展示（YYYY-MM-DD HH:mm） */
function draftTime(secs: number): string {
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 找到/新建草稿对应的标签：有路径则打开（占位标签先载入），未命名则新建 */
async function ensureTabForDraft(draft: DraftInfo): Promise<Tab | null> {
  if (!draft.path) return newUntitled(draft.name);
  let tab = tabStore.findByPath(draft.path);
  if (!tab) {
    await openFilePath(draft.path, { silent: true });
    tab = tabStore.findByPath(draft.path);
  }
  if (!tab) return null;
  // 大文件虚拟视图 / 占位标签尚未载入时草稿不适用
  if (tab.virtual) return null;
  if (tab.pending && !(await loadPendingTab(tab))) return null;
  return tab;
}

/** 启动时处理草稿：原文件未变 →「恢复 / 丢弃」；原文件已变 →「另存为」 */
async function offerDraftRecovery(): Promise<void> {
  let drafts: DraftInfo[];
  try {
    drafts = await listDrafts();
  } catch {
    return;
  }
  let applied = false;
  for (const draft of drafts) {
    const payload = await readDraft(draft.key).catch(() => null);
    if (draft.stale) {
      const ok = await confirmAction(
        `「${draft.name}」的原文件已被修改，草稿（${draftTime(draft.savedAt)}）已过期。是否另存为新的未命名文档？`,
        "另存为",
      );
      if (!ok || !payload?.content) {
        await deleteDraft(draft.key).catch(() => {});
        continue;
      }
      const tab = newUntitled(draft.name);
      tabStore.applyDraft(tab.id, payload.content);
      applied = true;
    } else {
      const ok = await confirmAction(
        `「${draft.name}」存在未保存的草稿（${draftTime(draft.savedAt)}），是否恢复？`,
        "恢复",
      );
      if (!ok || !payload?.content) {
        await deleteDraft(draft.key).catch(() => {});
        continue;
      }
      const tab = await ensureTabForDraft(draft);
      if (!tab) continue;
      tabStore.applyDraft(tab.id, payload.content);
      applied = true;
      // 内容已接管：以新 key 立即重落草稿，避免中途丢失
      void persistDraft(tab.id);
    }
    // 原草稿已消费，删除以免下次启动重复提示
    await deleteDraft(draft.key).catch(() => {});
  }
  if (applied) {
    if (activeTab()) await loadActiveTab();
    showMessage("已恢复草稿内容（未保存，Ctrl+S 保存）");
  }
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
    renderBreadcrumb();
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

// ---- 编辑器初始化（CM6 仅承载 <20MB 文档）----
editorHandle = createEditor($("editor"), {
  onDocChange: () => {
    const tab = activeTab();
    if (!tab) return;
    tabStore.setContent(tab.id, editorHandle.getContent());
    const t = tabStore.findById(tab.id);
    if (t) previewHost.scheduleRender(toPreviewTab(t));
    // 未保存内容防抖写入草稿（配置关闭时不写）
    if (t) scheduleDraftSave(t);
  },
  onCursorChange: ({ line, col, totalLines }) => {
    statusCursor.textContent = `行 ${line}，列 ${col}`;
    statusLines.textContent = `共 ${totalLines} 行`;
    const tab = activeTab();
    if (tab) {
      cursorPos.set(tab.id, { line, col });
      persistSession();
    }
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

// ---- 当前文档查找 / 替换面板（菜单与右键菜单共用）----

/** 打开当前文档的查找面板（只读文档也可用，仅查找） */
function openFindInDoc(): void {
  if (activeTab()?.kind !== "text") return;
  editorHandle.view.focus();
  openSearchPanel(editorHandle.view);
}

/** 打开当前文档的替换面板并聚焦替换框 */
function openReplaceInDoc(): void {
  if (activeTab()?.kind !== "text") return;
  editorHandle.view.focus();
  openSearchPanel(editorHandle.view);
  editorHandle.view.dom.querySelector<HTMLInputElement>('input[name="replace"]')?.focus();
}

// ---- 剪贴板（编辑器右键菜单的剪切 / 复制 / 粘贴）----

/** 将选区写入系统剪贴板；cut 为真时同时删除选区 */
async function clipboardCopy(cut: boolean): Promise<void> {
  const view = editorHandle.view;
  const { ranges } = view.state.selection;
  if (ranges.every((r) => r.empty)) return;
  const text = ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    showMessage(`写入剪贴板失败：${String(e).split("\n")[0]}`);
    return;
  }
  if (cut && !view.state.readOnly) {
    const changes = ranges.map((r) => ({ from: r.from, to: r.to, insert: "" }));
    view.dispatch({ changes, selection: { anchor: changes[0].from } });
  }
  view.focus();
}

/** 将系统剪贴板文本粘贴到当前选区 */
async function clipboardPaste(): Promise<void> {
  const view = editorHandle.view;
  if (view.state.readOnly) return;
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    showMessage(`读取剪贴板失败：${String(e).split("\n")[0]}`);
    return;
  }
  if (!text) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

// ---- 编辑器右键菜单（对齐常用编辑器：编辑 + 剪贴板 + 查找 + 格式化）----

let editorMenu: HTMLElement | null = null;
let editorSubmenu: HTMLElement | null = null;
let submenuTimer: number | null = null;

interface MenuEntry {
  label?: string;
  shortcut?: string;
  run?: () => void;
  separator?: boolean;
  submenu?: MenuEntry[];
}

function closeEditorSubmenu(): void {
  if (submenuTimer !== null) {
    window.clearTimeout(submenuTimer);
    submenuTimer = null;
  }
  editorSubmenu?.remove();
  editorSubmenu = null;
}

/** 鼠标离开菜单区域时延迟关闭；指针仍停在任一层菜单上则不关闭 */
function scheduleSubmenuClose(): void {
  if (submenuTimer !== null) window.clearTimeout(submenuTimer);
  submenuTimer = window.setTimeout(() => {
    submenuTimer = null;
    if (editorSubmenu?.matches(":hover") || editorMenu?.matches(":hover")) return;
    closeEditorSubmenu();
  }, 300);
}

function closeEditorMenu(): void {
  closeEditorSubmenu();
  editorMenu?.remove();
  editorMenu = null;
}

/**
 * 渲染菜单项。nested=true 表示正在渲染二级菜单：
 * 此时条目自身的悬停不能再关闭所在子菜单。
 */
function appendMenuEntries(container: HTMLElement, entries: MenuEntry[], nested = false): void {
  for (const item of entries) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      container.append(sep);
      continue;
    }
    const el = document.createElement("div");
    el.className = "context-menu-item";
    const label = document.createElement("span");
    label.textContent = item.label ?? "";
    el.append(label);

    if (item.submenu) {
      el.classList.add("has-submenu");
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "›";
      el.append(arrow);
      el.addEventListener("mouseenter", () => {
        if (submenuTimer !== null) {
          window.clearTimeout(submenuTimer);
          submenuTimer = null;
        }
        openEditorSubmenu(el, item.submenu!);
      });
    } else {
      if (item.shortcut) {
        const sc = document.createElement("span");
        sc.className = "shortcut";
        sc.textContent = item.shortcut;
        el.append(sc);
      }
      if (!nested) {
        // 主菜单内悬停到普通条目时收起已展开的子菜单
        el.addEventListener("mouseenter", () => closeEditorSubmenu());
      }
      el.addEventListener("click", () => {
        closeEditorMenu();
        item.run?.();
      });
    }
    container.append(el);
  }
}

function openEditorSubmenu(parent: HTMLElement, entries: MenuEntry[]): void {
  closeEditorSubmenu();
  const sub = document.createElement("div");
  sub.className = "context-menu editor-submenu";
  appendMenuEntries(sub, entries, true);
  sub.addEventListener("mouseenter", () => {
    if (submenuTimer !== null) {
      window.clearTimeout(submenuTimer);
      submenuTimer = null;
    }
  });
  sub.addEventListener("mouseleave", () => scheduleSubmenuClose());
  document.body.append(sub);
  // 紧贴父项定位：与父项重叠 4px，保证指针移动时没有可落空的缝隙；
  // 右侧空间不足时翻到父项左侧
  const rect = parent.getBoundingClientRect();
  const overlap = 4;
  let left = rect.right - overlap;
  if (left + sub.offsetWidth > window.innerWidth - 4) {
    left = rect.left - sub.offsetWidth + overlap;
  }
  left = Math.max(4, Math.min(left, window.innerWidth - sub.offsetWidth - 4));
  const top = Math.max(4, Math.min(rect.top - 4, window.innerHeight - sub.offsetHeight - 4));
  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
  editorSubmenu = sub;
}

function showEditorMenu(x: number, y: number): void {
  closeEditorMenu();
  const view = editorHandle.view;
  const readonly = view.state.readOnly;
  const tab = activeTab();
  const lang = tab ? effectiveLanguage(tab) : null;
  const hasSelection = !view.state.selection.main.empty;
  const canFormat = supportsFormatting(lang);
  const canRun =
    tab !== null && tab.kind === "text" && Boolean(tab.path) && runnerFor(tab) !== null;

  // 顶层保持短小：常用编辑命令平铺，其余收进二级菜单
  const top: MenuEntry[] = [];
  if (!readonly) {
    top.push({ label: "撤销", shortcut: "Ctrl+Z", run: () => void undo(view) });
    top.push({ label: "重做", shortcut: "Ctrl+Shift+Z", run: () => void redo(view) });
    top.push({ separator: true });
    top.push({ label: "剪切", shortcut: "Ctrl+X", run: () => void clipboardCopy(true) });
  }
  top.push({ label: "复制", shortcut: "Ctrl+C", run: () => void clipboardCopy(false) });
  if (!readonly) top.push({ label: "粘贴", shortcut: "Ctrl+V", run: () => void clipboardPaste() });
  top.push({
    label: "全选",
    shortcut: "Ctrl+A",
    run: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }),
  });

  // 查找与书签（二级菜单）
  const find: MenuEntry[] = [
    { label: "查找…", shortcut: "Ctrl+F", run: () => openFindInDoc() },
  ];
  if (!readonly) find.push({ label: "替换…", shortcut: "Ctrl+H", run: () => openReplaceInDoc() });
  find.push({ label: "查找结果面板", run: () => toggleResultsPanel() });
  if (!readonly) {
    find.push({ separator: true });
    find.push({ label: "切换书签", shortcut: "Ctrl+F2", run: () => toggleBookmark(view) });
    find.push({ label: "下一个书签", shortcut: "F2", run: () => gotoBookmark(view, 1) });
  }
  top.push({ separator: true });
  top.push({ label: "查找与书签", submenu: find });

  // 代码：格式化 / 运行 / 列编辑
  const code: MenuEntry[] = [];
  if (!readonly && canFormat) {
    code.push({ label: "格式化文档", shortcut: "Shift+Alt+F", run: () => void formatCurrent() });
    if (hasSelection) {
      code.push({ label: "格式化选中内容", run: () => void formatSelectionCurrent() });
    }
  }
  if (canRun) code.push({ label: "运行当前文件", shortcut: "F5", run: () => runCurrentFile() });
  if (runActive) code.push({ label: "停止运行", run: () => runPanel.stop() });
  if (!readonly) {
    if (code.length > 0) code.push({ separator: true });
    code.push({ label: "列编辑器", shortcut: "Alt+C", run: () => openColumnEditor(view) });
  }
  if (code.length > 0) top.push({ label: "代码", submenu: code });
  // 语言专属：仅 JSON / Markdown
  if (!readonly && lang === "json") {
    top.push({
      label: "JSON",
      submenu: [
        { label: "JSON 美化", run: () => runJson(false) },
        { label: "JSON 压缩", run: () => runJson(true) },
      ],
    });
  } else if (!readonly && lang === "markdown") {
    top.push({
      label: "Markdown",
      submenu: [
        { label: "加粗", run: () => runWrap("**", "加粗：") },
        { label: "斜体", run: () => runWrap("*", "斜体：") },
        { label: "高亮", run: () => runWrap("==", "高亮：") },
        { label: "插入表格…", run: () => tableDialog.toggle() },
      ],
    });
  }

  // 文本转换（子菜单，需选中文本）
  if (!readonly && hasSelection) {
    top.push({
      label: "文本转换",
      submenu: (Object.keys(CASE_LABELS) as CaseMode[]).map((mode) => ({
        label: CASE_LABELS[mode],
        run: () => runCase(mode),
      })),
    });
  }

  // 插入（二级菜单）
  if (!readonly) {
    const insert: MenuEntry[] = [
      { label: "本地时间", run: () => insertAtCursor(localStamps().local) },
      { label: "ISO 时间戳", run: () => insertAtCursor(localStamps().iso) },
      { label: "Unix 时间戳", run: () => insertAtCursor(localStamps().unix) },
      { label: "日期", run: () => insertAtCursor(localStamps().date) },
      { label: "时间", run: () => insertAtCursor(localStamps().time) },
      { label: "UUID（v4）", run: () => insertAtCursor(newUuid()) },
    ];
    if (tab?.path) {
      insert.push({ separator: true });
      insert.push({ label: "剪贴板图片", run: () => void insertClipboardImage() });
    }
    top.push({ label: "插入", submenu: insert });
  }

  // 比较：仅有未保存改动时提供
  if (tab?.path && tab.dirty && !tab.virtual) {
    top.push({ separator: true });
    top.push({ label: "与磁盘内容比较（未保存改动）", run: () => void diffUnsaved() });
  }

  const menu = document.createElement("div");
  menu.className = "context-menu";
  // 指针离开整个主菜单后才开始收起子菜单；移入子菜单会取消该计时
  menu.addEventListener("mouseleave", () => {
    if (editorSubmenu) scheduleSubmenuClose();
  });
  appendMenuEntries(menu, top);
  document.body.append(menu);
  placeMenu(menu, x, y);
  editorMenu = menu;
}

editorHandle.view.dom.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showEditorMenu(e.clientX, e.clientY);
});
document.addEventListener("click", () => closeEditorMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeEditorMenu();
});

// ---- 外部修改检测（Rust 侧监听，前端仅提示、不自动重载）----

/** 已登记监听的路径集合（用于跳过重复登记） */
let watchedKey = "";
let watchTimer: ReturnType<typeof setTimeout> | null = null;

/** 需要监听的标签：可编辑的磁盘文本标签 */
function watchedPaths(): string[] {
  return tabStore
    .list()
    .filter((t) => t.kind === "text" && !!t.path && !t.virtual)
    .map((t) => t.path as string);
}

/** 立即重新登记（打开 / 保存 / 重载后调用：刷新指纹并开启自身写入的静默窗口） */
function refreshWatchedFiles(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  const paths = watchedPaths();
  watchedKey = paths.join("|");
  void watchFiles(paths).catch((e) => console.warn("[watch] 登记失败", e));
}

/** 标签集变化时的防抖登记（路径集合未变则跳过） */
function syncWatchedFilesDebounced(): void {
  const paths = watchedPaths();
  const key = paths.join("|");
  if (key === watchedKey) return;
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    watchedKey = key;
    void watchFiles(paths).catch((e) => console.warn("[watch] 登记失败", e));
  }, 600);
}

void onFileChanged((path) => {
  const tab = tabStore.findByPath(path);
  if (!tab || tab.externallyChanged) return;
  tabStore.markExternal(tab.id, true);
  refreshStatus();
  showMessage(`「${tab.name}」已被外部修改（点击状态栏「外部修改」可重新载入）`);
}).catch((e) => console.warn("[watch] 订阅失败", e));

/** 从磁盘重新载入标签（外部修改后由状态栏触发） */
async function reloadFromDisk(tab: Tab): Promise<void> {
  if (tab.kind !== "text" || !tab.path) return;
  if (tab.dirty) {
    const ok = await confirmAction(
      `「${tab.name}」有未保存的修改，重新载入将丢弃这些修改。继续？`,
      "丢弃并重载",
    );
    if (!ok) return;
  }
  try {
    const data = await invoke<FileContent>("open_text_file", {
      path: tab.path,
      largeFileThreshold: settings.largeFileThreshold,
      logExtensions: getConfig().largeFile.logExtensions,
    });
    tabStore.reopenWith(tab.id, data);
    tabStore.markExternal(tab.id, false);
    if (tabStore.active()?.id === tab.id) await loadActiveTab();
    refreshStatus();
    refreshWatchedFiles();
    showMessage(`已重新载入：${tab.name}`);
  } catch (e) {
    showMessage(`重新载入失败：${String(e).split("\n")[0]}`);
  }
}

statusExternal.addEventListener("click", () => {
  const tab = activeTab();
  if (tab) void reloadFromDisk(tab);
});

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
      pushRecentFile(img.path);
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
          pushRecentFile(path);
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
    pushRecentFile(data.path);
    void checkMojibake(tab.id);
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

// ---- 另存为指定编码（单文件）----

/** 打开编码选择对话框，确认后走系统保存对话框 */
function saveAsWithEncoding(): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text") {
    showMessage("请先打开一个文本文件");
    return;
  }
  if (blockIfReadonly()) return;
  if (tab.virtual) {
    showMessage("大文件只读视图不支持另存为");
    return;
  }
  const encodings = tab.encodingCandidates.length ? tab.encodingCandidates : FALLBACK_ENCODINGS;
  saveEncodingDialog.open(encodings, tab.encoding, (encoding) => {
    void (async () => {
      const current = tabStore.findById(tab.id);
      if (!current) return;
      const target = await save({ defaultPath: current.name });
      if (typeof target !== "string") return;
      try {
        await writeTo(current, target, encoding);
        const name = target.split(/[\\/]/).pop() ?? target;
        showMessage(`已按 ${encoding} 另存为：${name}`);
      } catch (e) {
        window.alert(`另存为失败: ${e}`);
      }
    })();
  }, `当前标签：${tab.name}`);
}

// ---- 插入剪贴板图片（复制/截图后直接插入）----

/** Blob → base64（去掉 data URL 前缀） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 读取剪贴板中的图片，存到文档同级的 `<文档名>.assets/` 目录，并在光标处插入引用。
 * Markdown 插入 `![](相对路径)`，其他语言插入相对路径文本。
 */
async function insertClipboardImage(): Promise<void> {
  const tab = activeTab();
  if (!tab || tab.kind !== "text") {
    showMessage("请先打开一个文本文件");
    return;
  }
  if (blockIfReadonly()) return;
  if (!tab.path) {
    showMessage("请先保存文档，再插入剪贴板图片");
    return;
  }
  if (!navigator.clipboard?.read) {
    showMessage("当前环境不支持读取剪贴板图片");
    return;
  }

  let blob: Blob | null = null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) {
        blob = await item.getType(type);
        break;
      }
    }
  } catch (e) {
    showMessage(`读取剪贴板失败：${String(e).split("\n")[0]}`);
    return;
  }
  if (!blob) {
    showMessage("剪贴板中没有图片（请先截图或复制图片）");
    return;
  }

  const ext = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/gif" ? "gif" : "png";
  const dir = tab.path.replace(/[\\/][^\\/]+$/, "");
  const base = tab.name.replace(/\.[^.]+$/, "") || "assets";
  const stamp = localStamps().local.replace(/[-: ]/g, "");
  const fileName = `image-${stamp}.${ext}`;
  const rel = `${base}.assets/${fileName}`;
  const absolute = `${dir}/${rel}`;

  try {
    const bytes = await blobToBase64(blob);
    await invoke<number>("write_binary_file", { path: absolute, base64Data: bytes });
  } catch (e) {
    showMessage(`图片写入失败：${String(e).split("\n")[0]}`);
    return;
  }

  insertAtCursor(effectiveLanguage(tab) === "markdown" ? `![](${rel})` : rel);
  showMessage(`已插入图片：${rel}`);
}

/** 调 Rust 保存命令：保留换行符与 BOM（原子替换在 Rust 侧） */
async function writeTo(tab: Tab, path: string, encodingOverride?: string): Promise<void> {
  // 用 tab.content 而非编辑器内容：非激活标签的编辑只存在于缓存中，
  // 且激活标签的每次输入都会实时同步进 tab.content（onDocChange → setContent）
  const encoding = encodingOverride ?? tab.encoding;
  const result = await invoke<SaveResult>("save_file", {
    path,
    content: tab.content,
    newline: tab.newline,
    hasBom: tab.has_bom,
    encoding,
  });
  // 指定编码另存：标签编码与基线一并切到新编码，避免残留脏标记
  if (encodingOverride) tabStore.applySavedEncoding(tab.id, encodingOverride);
  if (path !== tab.path) {
    tabStore.setPath(tab.id, result.path, result.path.split(/[\\/]/).pop() ?? result.path);
  }
  const current = tabStore.findById(tab.id);
  if (current) {
    current.size = result.size;
  }
  tabStore.markSaved(tab.id);
  // 内容已落盘：草稿不再需要；自身写入的抑制由 Rust 保存在写盘前后处理，
  // 这里只需同步标签集（另存为改变了路径）与外部修改标记
  void discardDraft(tab.id);
  tabStore.markExternal(tab.id, false);
  syncWatchedFilesDebounced();
  refreshStatus();
}

/** 未命名文档编号：取当前最小的空闲序号，保证同名标签可并存 */
function nextUntitledName(): string {
  const used = new Set<number>();
  for (const tab of tabStore.list()) {
    if (tab.path) continue;
    const m = /^未命名(?:-(\d+))?$/.exec(tab.name);
    if (m) used.add(m[1] ? Number(m[1]) : 1);
  }
  let n = 1;
  while (used.has(n)) n++;
  return `未命名-${n}`;
}

/** 新建未命名文档（可指定初始名称，用于草稿恢复） */
function newUntitled(name = nextUntitledName()): Tab {
  const content: FileContent = {
    path: "",
    name,
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
  return tabStore.open(content);
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
    // 配置若在编辑器标签中改过但未保存，先询问是否落盘——否则重新读到的仍是旧值
    if (cfgPath) {
      const tab = tabStore.findByPath(cfgPath);
      if (tab?.dirty) {
        const ok = await confirmAction(
          "config.json 有未保存的修改，是否保存后再重新加载？",
          "保存并重新加载",
        );
        if (!ok) return; // 取消：不做任何改动，避免误丢编辑中的修改
        await writeTo(tab, cfgPath);
      }
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
  const key = effectiveLanguage(tab);
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
  const key = effectiveLanguage(tab);
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
    void checkMojibake(tab.id);
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

/** 一次差异会话：采用差异块后可重新计算并刷新面板 */
interface DiffSession {
  /** 重新计算差异（采用后左侧基线可能已变，必须重新调用） */
  load: () => Promise<DiffPayload>;
  actions: DiffAction[];
  /** 可采用的差异块动作；返回 null 表示当前场景不提供 */
  adopt: () => HunkAdopt | null;
  /** 合并结果是否保留结尾换行：按编辑器内容 / 磁盘基线判断 */
  trailingFrom: "content" | "saved";
}

let diffSession: DiffSession | null = null;

async function openDiff(session: DiffSession, hunkIndex?: number): Promise<void> {
  diffSession = session;
  try {
    const payload = await session.load();
    diffPanel.open(payload, session.actions, session.adopt() ?? undefined, hunkIndex);
  } catch (e) {
    showMessage(`比较失败：${String(e).split("\n")[0]}`);
  }
}

/**
 * 差异块合并：块内取 applySide、块外取 baseSide；该侧无对应行的行被丢弃。
 * 差异行由 Rust 对齐输出，两侧单元格可拼回原文，故无需重新读取文件。
 */
function mergeHunk(
  payload: DiffPayload,
  hunkIndex: number,
  baseSide: "left" | "right",
  applySide: "left" | "right",
  trailingNewline: boolean,
): string {
  const start = payload.hunks[hunkIndex]?.row;
  let end = payload.rows.length;
  if (start !== undefined) {
    end = start;
    while (end < payload.rows.length && payload.rows[end].kind !== "equal") end += 1;
  }
  const cell = (row: DiffRow, side: "left" | "right"): string | null => {
    if (side === "left") return row.oldNo === null ? null : row.left;
    return row.newNo === null ? null : row.right;
  };

  const lines: string[] = [];
  payload.rows.forEach((row, i) => {
    const side = start !== undefined && i >= start && i < end ? applySide : baseSide;
    const text = cell(row, side);
    if (text !== null) lines.push(text);
  });
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  return trailingNewline ? `${joined}\n` : joined;
}

/** 采用当前差异块：写回编辑器并重新计算差异，保持所在差异块位置 */
async function adoptHunk(hunkIndex: number): Promise<void> {
  const session = diffSession;
  const payload = diffPanel.getPayload();
  const adopt = session?.adopt();
  if (!session || !payload || !adopt || !adopt.enabled()) return;
  const tab = activeTab();
  if (!tab || tab.kind !== "text") return;
  if (tab.readonly) {
    showMessage("只读文件不支持差异块合并");
    return;
  }
  // 文档基线侧：可采用侧的对侧
  const baseSide: "left" | "right" = adopt.side === "left" ? "right" : "left";
  const trailing =
    session.trailingFrom === "content"
      ? tab.content.endsWith("\n")
      : tab.savedContent.endsWith("\n");
  const merged = mergeHunk(payload, hunkIndex, baseSide, adopt.side, trailing);
  if (merged === tab.content) {
    showMessage("该处内容已与所选侧一致，无需改动");
    return;
  }
  tabStore.setContent(tab.id, merged);
  await loadActiveTab();
  await openDiff(session, hunkIndex);
  showMessage(`已采用第 ${hunkIndex + 1} 处差异块（未保存，Ctrl+S 生效）`);
}

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
  const tabId = tab.id;
  await openDiff({
    load: () => invoke<DiffPayload>("diff_files", { leftPath, rightPath }),
    actions: [
      {
        label: "导出补丁",
        run: () => {
          const p = diffPanel.getPayload();
          if (p) void exportPatch(leftPath, p.patch);
        },
      },
    ],
    // 文档基线为左侧（当前文件磁盘内容）；仅当标签无未保存改动时两侧内容才对齐
    adopt: () => ({
      side: "right",
      enabled: () => {
        const t = tabStore.findById(tabId);
        return !!t && !t.dirty && !t.readonly;
      },
      title: "采用右侧：把当前差异块替换为另一文件的内容（需先保存当前标签的改动）",
      run: (i) => void adoptHunk(i),
    }),
    trailingFrom: "saved",
  });
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
  const tabId = tab.id;
  const name = tab.name;
  await openDiff({
    load: () => {
      const t = tabStore.findById(tabId);
      return invoke<DiffPayload>("diff_texts", {
        leftText: t?.savedContent ?? "",
        rightText: t?.content ?? "",
        leftLabel: `磁盘 · ${name}`,
        rightLabel: `编辑中 · ${name}`,
      });
    },
    actions: [
      {
        label: "还原改动",
        title: "放弃编辑中的内容，回到磁盘版本",
        run: async () => {
          const t = tabStore.findById(tabId);
          if (!t) return;
          tabStore.setContent(tabId, t.savedContent);
          await loadActiveTab();
          diffPanel.close();
          showMessage("已还原为磁盘内容");
        },
      },
      {
        label: "导出补丁",
        run: () => {
          const p = diffPanel.getPayload();
          if (p) void exportPatch(tabStore.findById(tabId)?.path ?? name, p.patch);
        },
      },
    ],
    // 文档基线为右侧（编辑中）；可采用左侧把该处还原为磁盘内容
    adopt: () => ({
      side: "left",
      enabled: () => !activeTab()?.readonly,
      title: "采用左侧：把当前差异块还原为磁盘内容（写回编辑器，需手动保存）",
      run: (i) => void adoptHunk(i),
    }),
    trailingFrom: "content",
  });
}

/** 场景三：与 Git 比较（scope = worktree 工作区 | index 暂存区） */
async function diffWithGit(scope: "worktree" | "index"): Promise<void> {
  const tab = activeTab();
  if (!tab?.path || tab.kind !== "text") {
    showMessage("请先打开一个磁盘上的文本文件");
    return;
  }
  const path = tab.path;
  const tabId = tab.id;
  let available: boolean;
  try {
    available = await invoke<boolean>("git_available", { path });
  } catch (e) {
    showMessage(`Git 比较失败：${String(e).split("\n")[0]}`);
    return;
  }
  if (!available) {
    showMessage("当前文件不在 Git 仓库中，无法比较");
    return;
  }
  await openDiff({
    load: () => invoke<DiffPayload>("git_diff", { path, scope }),
    actions: [
      {
        label: "导出补丁",
        run: () => {
          const p = diffPanel.getPayload();
          if (p) void exportPatch(path, p.patch);
        },
      },
    ],
    // worktree：文档基线为右侧（工作区磁盘内容），可采用左侧还原为 Git 版本；
    // index：右侧是暂存区，与编辑器内容不对应，故不提供差异块采用
    adopt: () =>
      scope === "index"
        ? null
        : {
            side: "left",
            enabled: () => {
              const t = tabStore.findById(tabId);
              return !!t && !t.dirty && !t.readonly;
            },
            title: "采用左侧：把当前差异块还原为 Git 版本（需先保存当前标签的改动）",
            run: (i) => void adoptHunk(i),
          },
    trailingFrom: "saved",
  });
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

// ---- 菜单栏 ----
new MenuBar($("menubar"), [
  {
    id: "file",
    label: "文件",
    items: [
      { label: "新建", shortcut: "Ctrl+N", run: () => newUntitled() },
      { label: "打开文件…", shortcut: "Ctrl+O", run: () => void openFileDialog() },
      { label: "打开目录（工作区）…", run: () => void openWorkspaceDir() },
      { label: "最近打开…", run: () => recentFiles.toggle() },
      { separator: true },
      { label: "保存", shortcut: "Ctrl+S", run: () => void saveFile() },
      { label: "另存为…", shortcut: "Ctrl+Shift+S", run: () => void saveFileAs() },
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
    label: "编辑",
    items: [
      { label: "撤销", shortcut: "Ctrl+Z", run: () => void undo(editorHandle.view) },
      { label: "重做", shortcut: "Ctrl+Shift+Z", run: () => void redo(editorHandle.view) },
      { separator: true },
      { label: "剪切", shortcut: "Ctrl+X", run: () => void clipboardCopy(true) },
      { label: "复制", shortcut: "Ctrl+C", run: () => void clipboardCopy(false) },
      { label: "粘贴", shortcut: "Ctrl+V", run: () => void clipboardPaste() },
      { separator: true },
      { label: "查找…", shortcut: "Ctrl+F", run: () => openFindInDoc() },
      { label: "替换…", shortcut: "Ctrl+H", run: () => openReplaceInDoc() },
      { label: "查找结果面板", run: () => toggleResultsPanel() },
      { separator: true },
      { label: "格式化文档", shortcut: "Shift+Alt+F", run: () => void formatCurrent() },
      { label: "格式化选中内容", run: () => void formatSelectionCurrent() },
      { label: "列编辑器", shortcut: "Alt+C", run: () => { if (!blockIfReadonly()) openColumnEditor(editorHandle.view); } },
      { separator: true },
      { label: "命令面板", shortcut: "Ctrl+Shift+P", run: () => palette.open() },
    ],
  },
  {
    id: "select",
    label: "选择",
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
    id: "go",
    label: "转到",
    items: [
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
      { label: "设置中心…", shortcut: "Ctrl+,", run: () => openSettings() },
      { separator: true },
      { label: "配置说明", run: () => showSettingsHelp() },
      { label: "打开配置文件（config.json）", run: () => void openConfigFile() },
      { label: "重新加载配置", run: () => void reloadConfig() },
    ],
  },
]);

// ---- 工具面板（Cron 解析 / 批量另存编码 / 正则测试器；命令面板入口）----

const cronPanel = new CronPanel();
const batchEncodingPanel = new BatchEncodingPanel();
const regexTester = new RegexTesterPanel();

/** Markdown 表格对话框：确认后在光标处插入表格 */
const tableDialog = new MarkdownTableDialog((cols, rows) => {
  if (!activeTab() || blockIfReadonly()) return;
  const result = insertTable(editorHandle.view, cols, rows);
  showMessage(result.message);
});

/** 最近打开：点击后走统一的打开流程（含大文件分流） */
const recentFiles = new RecentFilesDialog((path) => void openFilePath(path));

/** 另存为指定编码对话框 */
const saveEncodingDialog = new SaveEncodingDialog();

/** Code Run 输出面板 */
let runActive = false;
const runPanel = new RunPanel($("run-output"), () => {
  runActive = runPanel.isRunning;
  refreshRunButton();
});
runPanel.mount();

/** 标签栏右侧的运行快捷按钮状态 */
function refreshRunButton(): void {
  if (runActive) {
    runBtn.disabled = false;
    runBtn.classList.add("running");
    runBtn.textContent = "■ 停止";
    runBtn.title = "停止运行（F5）";
    return;
  }
  const tab = activeTab();
  const canRun =
    tab !== null &&
    tab.kind === "text" &&
    !!tab.path &&
    !tab.virtual &&
    runnerFor(tab) !== null;
  runBtn.classList.remove("running");
  runBtn.textContent = "▶ 运行";
  runBtn.disabled = !canRun || tab?.dirty === true;
  runBtn.title = !canRun
    ? "当前文件不支持运行（支持 Python / JS / Java / cURL，且需已保存为磁盘文件）"
    : tab?.dirty
      ? "有未保存改动：运行时执行的是磁盘内容，请先保存（Ctrl+S）"
      : `运行 ${tab?.name ?? ""}（F5）`;
}

runBtn.addEventListener("click", () => {
  if (runActive) runPanel.stop();
  else runCurrentFile();
});

/** 按生效语言选择 Code Run 运行器（仅 Python / Node / Java / cURL） */
function runnerFor(tab: Tab): string | null {
  const lang = effectiveLanguage(tab);
  if (lang === "python") return "python";
  if (lang === "javascript" || lang === "jsx") return "node";
  if (lang === "java") return "java";
  // 内容以 curl 开头即按 cURL 参数脚本处理
  if (/^\s*curl\b/m.test(tab.content)) return "curl";
  return null;
}

/** 运行当前文件（执行的是磁盘内容，故要求无未保存改动） */
function runCurrentFile(): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    showMessage("请先保存为磁盘文件再运行");
    return;
  }
  if (tab.virtual) {
    showMessage("大文件只读视图不支持运行");
    return;
  }
  if (tab.dirty) {
    showMessage("有未保存改动：运行时执行的是磁盘内容，请先保存（Ctrl+S）");
    return;
  }
  const runner = runnerFor(tab);
  if (!runner) {
    showMessage("当前语言不支持运行（支持 Python / JS / Java / cURL）");
    return;
  }
  void runPanel.start(tab.path, runner);
}

/** Markdown 选中包裹切换（加粗 / 斜体 / 高亮） */
function runWrap(marker: string, label: string): void {
  if (!activeTab() || blockIfReadonly()) return;
  const result = toggleWrap(editorHandle.view, marker);
  showMessage(result.ok ? `${label}${result.message}` : result.message);
}

/** 文本变换入口：只读拦截 + 结果提示 */
function runCase(mode: CaseMode): void {
  if (!activeTab() || blockIfReadonly()) return;
  const result = applyCase(editorHandle.view, mode);
  showMessage(result.message);
}

function runJson(minify: boolean): void {
  if (!activeTab() || blockIfReadonly()) return;
  const cfg = getConfig();
  const indent = cfg.insertSpaces ? " ".repeat(cfg.tabSize) : "\t";
  const result = applyJson(editorHandle.view, minify, indent);
  showMessage(result.message);
}

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
  { id: "tools.cron", title: "Cron 表达式解析 / 生成", section: "工具", run: () => cronPanel.toggle() },
  { id: "tools.batchEncoding", title: "批量另存为编码…", section: "工具", run: () => batchEncodingPanel.toggle() },
  { id: "tools.regex", title: "正则测试器", section: "工具", run: () => regexTester.toggle() },
  // 文本变换（作用于选区）
  ...(Object.keys(CASE_LABELS) as CaseMode[]).map((mode) => ({
    id: `text.case.${mode}`,
    title: `转换大小写：${CASE_LABELS[mode]}`,
    section: "文本",
    run: () => runCase(mode),
  })),
  { id: "text.json.pretty", title: "JSON 美化", section: "文本", run: () => runJson(false) },
  { id: "text.json.minify", title: "JSON 压缩", section: "文本", run: () => runJson(true) },
  // Markdown 增强（作用于选区；表格为对话框）
  { id: "md.bold", title: "Markdown：加粗（包裹 ** **）", section: "Markdown", run: () => runWrap("**", "加粗：") },
  { id: "md.italic", title: "Markdown：斜体（包裹 * *）", section: "Markdown", run: () => runWrap("*", "斜体：") },
  { id: "md.highlight", title: "Markdown：高亮（包裹 == ==）", section: "Markdown", run: () => runWrap("==", "高亮：") },
  { id: "md.table", title: "Markdown：插入表格…", section: "Markdown", run: () => tableDialog.toggle() },
  { id: "file.recent", title: "最近打开的文件…", section: "文件", run: () => recentFiles.toggle() },
  { id: "file.saveAsEncoding", title: "另存为指定编码…", section: "文件", run: () => saveAsWithEncoding() },
  { id: "insert.clipboardImage", title: "插入剪贴板图片（存为 .assets 并插入引用）", section: "插入", run: () => void insertClipboardImage() },
  { id: "encoding.detectMojibake", title: "检测乱码并建议编码", section: "编码", run: () => detectMojibakeManually() },
  { id: "code.run", title: "运行当前文件（Code Run）", section: "运行", run: () => runCurrentFile() },
  { id: "code.stop", title: "停止运行", section: "运行", run: () => runPanel.stop() },
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
  // setRoot 会经 onWorkspaceStateChange 同步 workspaceRoot、侧栏标题与持久化
  fileTree.setRoot(dir);
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
  // 运行
  { id: "code.run", title: "运行当前文件（Code Run）", section: "运行", defaultKey: "F5", run: () => runCurrentFile() },
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
    state = { root: null, expanded: [] };
  }
  workspaceRoot = state.root;
  if (state.root) {
    fileTree.setRoot(state.root, state.expanded);
    wsName.textContent = state.root.split(/[\\/]/).pop() || state.root;
    wsName.title = state.root;
  }

  // 过期草稿清理（保留天数取自配置，0 表示不清理）
  void cleanupDrafts(getConfig().session.draftRetentionDays).catch(() => {});

  // 恢复会话：打开文件列表 + 光标位置 + 分栏比例（可在配置中关闭）
  if (getConfig().session.restoreOnStartup) {
    try {
      const sess = await loadSession();
      if (sess.splitRatio != null) applySplitRatio(sess.splitRatio);
      for (const f of sess.openFiles) {
        restoredCursors.set(f.path, { line: f.line, col: f.col });
      }
      if (sess.activeFile) await openFilePath(sess.activeFile, { silent: true });
      for (const f of sess.openFiles) {
        if (f.path === sess.activeFile) continue;
        tabStore.openPending(f.path, f.path.split(/[\\/]/).pop() ?? f.path);
      }
      const target = sess.activeFile
        ? tabStore.findByPath(sess.activeFile)
        : tabStore.list()[0];
      if (target) tabStore.activate(target.id);
    } catch (e) {
      console.warn("[session] 恢复失败", e);
    }
  }

  // 草稿恢复提示（在会话恢复之后：原文件未变可恢复，已变则提示另存为）
  await offerDraftRecovery();

  // 登记外部修改监听（会话恢复出的标签一并纳入）
  refreshWatchedFiles();
}

void bootstrap();
