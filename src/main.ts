import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { createEditor, type EditorHandle } from "./editor/setup";
import { SearchResultsPanel } from "./editor/searchPanel";
import { openSearchPanel } from "@codemirror/search";
import { FileTree } from "./panels/fileTree";
import { CommandPalette } from "./panels/commandPalette";
import { QuickOpen } from "./panels/quickOpen";
import { SearchView } from "./panels/searchView";
import { OutlineView } from "./panels/outlineView";
import { OpenEditorsView } from "./panels/openEditorsView";
import { SidebarViews } from "./ui/sidebar";
import { WelcomePanel } from "./panels/welcome";
import { showAboutDialog } from "./panels/aboutDialog";
import { showShortcutsDialog, type ShortcutRow } from "./panels/shortcutsDialog";
import { MenuBar } from "./panels/menubar";
import { pathKindOf } from "./panels/preview";
import { tabStore, type Tab } from "./store/tabs";
import { confirmAction, confirmCloseDirty } from "./ui/dialogs";
import { createStatusBar } from "./ui/statusBar";
import { TabsBar } from "./ui/tabsBar";
import { Breadcrumb } from "./ui/breadcrumb";
import { EditorContextMenu, type MenuEntry } from "./ui/editorMenu";
import { PreviewController } from "./app/previewHost";
import { LargeFileHost } from "./app/largeFileHost";
import { FileService, FALLBACK_ENCODINGS, readDiskAs } from "./app/fileService";
import { RunHost } from "./app/runHost";
import { TerminalHost } from "./app/terminalHost";
import { FetchHost } from "./app/fetchHost";
import { DiffService } from "./app/diffService";
import { SessionHost } from "./app/sessionHost";
import { TabSwitcher } from "./app/tabSwitcher";
import { WindowChrome } from "./app/windowChrome";
import { DropHost } from "./app/dropHost";
import { StatusActions } from "./app/statusActions";
import { FormatHost } from "./app/formatHost";
import { buildEditorMenu } from "./app/menuContent";
import { buildCommandTable } from "./app/commandTable";
import { LayoutPane } from "./app/layout";
import {
  loadWorkspace,
  saveWorkspaceDebounced,
  pickDirectory,
  type WorkspaceState,
} from "./services/workspace";
import { cleanupDrafts, loadSession } from "./services/session";
import {
  settings,
  getConfig,
  loadSettings,
  subscribeSettings,
} from "./config/settings";
import {
  matchKeyCommand,
  resolveKey,
  formatKey,
  setExtraReservedKeys,
} from "./config/keybindings";
import {
  allCommands,
  commandPaletteItems,
  getCommand,
  menuModel,
  registerCommands,
  type CommandDef,
} from "./core/commands";
import type { SettingsPanel } from "./panels/settingsPanel";
import { basenameOf } from "./core/paths";
import { effectiveLanguage, languageLabel } from "./editor/languages";

// ---------------------------------------------------------------------------
// 多标签页 + 文件树/工作区 + 命令面板 + Prettier 格式化
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

// 批量关闭确认由 UI 层注入（store 不反向依赖 ui）
tabStore.setConfirmHandler(confirmAction);

const breadcrumbEl = $<HTMLDivElement>("breadcrumb");
const editorArea = document.querySelector<HTMLElement>(".editor-area")!;
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
const statusWrap = $<HTMLSpanElement>("status-wrap");
const statusReadonly = $<HTMLSpanElement>("status-readonly");
const statusDraft = $<HTMLSpanElement>("status-draft");
const statusExternal = $<HTMLSpanElement>("status-external");

/** 状态栏（渲染 / 主题 / 字段显隐 / 分栏 / 消息 / 两个持久化开关） */
const statusBar = createStatusBar(
  {
    path: statusPath,
    size: statusSize,
    encoding: statusEncoding,
    newline: statusNewline,
    language: statusLanguage,
    cursor: statusCursor,
    lines: statusLines,
    dirty: statusDirty,
    message: statusMessage,
    whitespace: statusWhitespace,
    wrap: statusWrap,
    readonly: statusReadonly,
    draft: statusDraft,
    external: statusExternal,
  },
  {
    getActiveTab: activeTab,
    languageLabel,
    isWhitespaceOn: () => editorHandle.isWhitespaceOn(),
    toggleWhitespace: () => editorHandle.toggleWhitespace(),
    setWordWrap: (on) => editorHandle.setWordWrap(on),
  },
);

statusWhitespace.addEventListener("click", () => statusBar.toggleWhitespace());
statusWrap.addEventListener("click", () => statusBar.toggleWordWrap());

// ---- 状态栏弹出菜单（换行符 / 语言 / 编码）：领域动作见 app/statusActions.ts ----

const statusActions = new StatusActions({
  getActiveTab: activeTab,
  showMessage: statusBar.showMessage,
  refreshStatus: () => statusBar.refresh(),
  reloadActiveTab: () => tabSwitcher.load(),
  setEditorLanguage: (override) => editorHandle.setLanguage(override),
  saveAsWithEncoding: () => void fileService.saveAsWithEncoding(),
  readDiskAs,
  fallbackEncodings: FALLBACK_ENCODINGS,
});









statusActions.bind({
  newline: statusNewline,
  language: statusLanguage,
  encoding: statusEncoding,
});

// ---- 插入时间戳 / UUID：实现见 core/stamps.ts ----

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

let editorHandle: EditorHandle;
let resultsPanel: SearchResultsPanel | null = null;
const palette = new CommandPalette();
/** 首屏引导（无标签时显示）；构造晚于文件服务/运行宿主，故延迟赋值 */
let welcomeView: WelcomePanel | null = null;

/** 工作区根目录（root/expanded 由文件树维护并落 workspace.json） */
let workspaceRoot: string | null = null;

function activeTab(): Tab | null {
  return tabStore.active();
}

/** 只读标签：统一拦截需要写盘或改内容的编辑入口 */
function blockIfReadonly(): boolean {
  const tab = activeTab();
  if (tab?.readonly) {
    statusBar.showMessage(`只读文件：${tab.readonlyReason || "不可编辑"}`);
    return true;
  }
  return false;
}

// ---- 应用主题 / 状态栏字段显隐 / 分栏比例：见 ui/statusBar.ts ----

// ---- 标签栏 / 面包屑（渲染与交互在 ui/，此处装配依赖）----

const tabsBarView = new TabsBar($<HTMLDivElement>("tabs"), {
  onActivate: (id) => tabStore.activate(id),
  onClose: (id) => void closeTab(id),
  onCompareWith: (id) => diffService.compareTabs(id),
  onBulkClose: (kind, id) =>
    void closeTabsBulk(() => {
      if (kind === "left") return tabStore.closeLeft(id);
      if (kind === "right") return tabStore.closeRight(id);
      if (kind === "others") return tabStore.closeOthers(id);
      return tabStore.closeAll();
    }),
  onNewTab: () => fileService.newUntitled(),
});

const breadcrumbView = new Breadcrumb(breadcrumbEl, {
  getWorkspaceRoot: () => workspaceRoot,
  getActiveTab: activeTab,
  onOpenFile: (path) => void fileService.openFilePath(path),
});

// 标签过多时支持鼠标滚轮横向滚动 / 双击空白新建：见 ui/tabsBar.ts

// ---- 标签关闭（确认 / 草稿落盘 / 统一清理）----

/** 正在关闭中的标签（防重入：确认对话框挂起期间禁止二次进入） */
const closingTabs = new Set<string>();

async function closeTab(id: string): Promise<void> {
  if (closingTabs.has(id)) return;
  const tab = tabStore.findById(id);
  if (!tab) return;
  if (tab.dirty) {
    closingTabs.add(id);
    try {
      // 三选确认：保存 / 不保存 / 取消
      const choice = await confirmCloseDirty(tab.name);
      if (choice === "cancel") return;
      if (choice === "save") {
        try {
          if (tab.path) {
            await fileService.writeTo(tab, tab.path);
          } else {
            const target = await save({ defaultPath: tab.name });
            if (typeof target !== "string") return; // 用户取消保存 → 不关闭
            await fileService.writeTo(tab, target);
          }
        } catch (e) {
          statusBar.showMessage(`保存失败: ${String(e).split("\n")[0]}`);
          return;
        }
      }
    } finally {
      closingTabs.delete(id);
    }
  }
  // 关闭前把未保存内容落草稿，避免静默丢弃（已保存则顺带清除草稿）
  if (tab.dirty) await sessionHost.persistDraft(id);
  // 编辑器状态缓存 / 光标 / 草稿键 / 大文件会话的清理统一走关闭订阅
  tabStore.close(id);
}

/** 标签移除后的统一清理（单条关闭与批量关闭共用） */
tabStore.onTabClosed((tab) => {
  rememberClosedTab(tab);
  editorHandle.forgetDocument(tab.id);
  preview.forget(tab.id);
  sessionHost.forgetDraft(tab.id);
  void largeHost.release(tab);
});

// ---- 最近关闭的标签（Ctrl+Shift+T 重开） ----

interface ClosedTabRecord {
  path: string;
  name: string;
}

const recentlyClosed: ClosedTabRecord[] = [];
const RECENT_CLOSED_LIMIT = 10;

/** 关闭前记一笔（仅磁盘上的可编辑文本；未命名/虚拟视图无法可靠重开） */
function rememberClosedTab(tab: Tab): void {
  if (!tab.path || tab.virtual || tab.kind !== "text") return;
  recentlyClosed.unshift({ path: tab.path, name: tab.name });
  if (recentlyClosed.length > RECENT_CLOSED_LIMIT) recentlyClosed.pop();
}

async function reopenClosedTab(): Promise<void> {
  const record = recentlyClosed.shift();
  if (!record) {
    statusBar.showMessage("没有可重新打开的标签");
    return;
  }
  await fileService.openFilePath(record.path, { silent: true });
}

// ---- 批量保存 / 重新载入 ----

/** 全部保存：只处理有磁盘路径的脏标签；未命名文档提示改用另存为 */
async function saveAllFiles(): Promise<void> {
  const dirty = tabStore
    .list()
    .filter((t) => t.dirty && t.kind === "text" && !t.virtual);
  const saved = dirty.filter((t): t is Tab & { path: string } => Boolean(t.path));
  const untitled = dirty.length - saved.length;
  if (saved.length === 0) {
    statusBar.showMessage(
      untitled > 0 ? "未命名文档请用「另存为」保存" : "没有需要保存的文件",
    );
    return;
  }
  let ok = 0;
  const failed: string[] = [];
  for (const tab of saved) {
    try {
      await fileService.writeTo(tab, tab.path);
      ok += 1;
    } catch {
      failed.push(tab.name);
    }
  }
  const extra = untitled > 0 ? `；另有 ${untitled} 个未命名文档未保存` : "";
  statusBar.showMessage(
    failed.length > 0
      ? `已保存 ${ok} 个，失败 ${failed.length} 个: ${failed.join("、")}${extra}`
      : `已保存 ${ok} 个文件${extra}`,
    failed.length > 0 ? 8000 : 3000,
  );
}

/** 重新载入当前文件：丢弃未保存修改前先确认（复用会话宿主的磁盘重载） */
async function reloadCurrentFile(): Promise<void> {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    statusBar.showMessage("当前标签不是磁盘上的文本文件");
    return;
  }
  if (tab.virtual) {
    await reloadActiveTab();
    return;
  }
  await sessionHost.reloadFromDisk(tab);
}

/**
 * 批量关闭（关闭左侧/右侧/其他/全部）：先把脏标签的未保存内容落草稿，
 * 再执行批量关闭。用户取消确认时草稿内容与当前内容一致，无害；
 * 确认关闭后内容不丢失，可按正常草稿恢复流程找回。
 */
async function closeTabsBulk(fn: () => Promise<void>): Promise<void> {
  const dirty = tabStore.list().filter((t) => t.dirty);
  for (const tab of dirty) {
    await sessionHost.persistDraft(tab.id);
  }
  await fn();
}

/** 标签页状态变化 → 重渲染 + 同步编辑器内容 + 持久化会话 */
tabStore.subscribe((kind) => {
  const prevActiveId = tabSwitcher.currentId;
  tabsBarView.render();
  openEditors.refresh();
  welcomeView?.setVisible(tabStore.list().length === 0);
  if (sidebarViews.view === "outline") sidebarOutline.scheduleRefresh();
  breadcrumbView.render();
  statusBar.refresh();
  // 运行按钮依赖当前文档的语言与头部内容（cURL 识别）：
  // 结构帧立即刷新；内容帧合并到 300ms 后再算（cURL 识别要读 4KB 文档头，
  // 不能挂在每个按键帧上，但也不能只在结构帧算——输入 curl 后按钮应及时可用）
  if (kind === "structure") refreshRunButton();
  else scheduleRunButtonRefresh();
  sessionHost.refreshDraftBadge();
  if (tabStore.active()?.id !== prevActiveId) {
    void tabSwitcher.load();
  }
  if (sessionHost.structureChanged()) {
    sessionHost.persistSession();
  }
  sessionHost.syncWatchedDebounced();
});

// ---- 工作区持久化（根目录与展开状态） ----

function persistWorkspaceWithExpanded(expanded: string[]): void {
  saveWorkspaceDebounced({ root: workspaceRoot, expanded });
}

// ---- 会话与草稿持久化：见 app/sessionHost.ts ----

// ---- 文件树 ----

const wsName = $<HTMLSpanElement>("ws-name");
const btnOpenDir = $<HTMLButtonElement>("btn-open-dir");

const fileTree = new FileTree(fileTreeEl, {
  onOpenFile: (path) => void fileService.openFilePath(path),
  onCompareFile: (path) => void diffService.compareWithPath(path),
  // terminalHost 在下文构造：回调运行时才访问（闭包，无 TDZ 风险）
  onOpenTerminal: (dir) => void terminalHost.openAt(dir),
  onNotify: (message) => statusBar.showMessage(message),
  onWorkspaceStateChange: (state) => {
    workspaceRoot = state.root;
    wsName.textContent = state.root
      ? (basenameOf(state.root) || state.root)
      : "工作区";
    wsName.title = state.root ?? "";
    persistWorkspaceWithExpanded(state.expanded);
    breadcrumbView.render();
  },
});
fileTree.mountGlobalListeners();

// ---- 侧栏多视图：文件 / 搜索 / 大纲 ----
const sidebarSearch = new SearchView($("sidebar-search"), {
  getRoot: () => workspaceRoot,
  getIgnoreDirs: () => getConfig().ignoreDirs,
  onOpenLocation: (path, line) => void openFileAt(path, line),
  isDirtyPath: (path) => tabStore.findByPath(path)?.dirty === true,
  // 批量替换已写盘：重载已打开的标签 + 重建文件树（新增 .bak 也要可见）
  onFilesReplaced: async (paths) => {
    // Windows 路径大小写 / 分隔符不敏感：统一归一化后再与标签 path 比较
    const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
    const replaced = new Set(paths.map(norm));
    const affected = tabStore
      .list()
      .filter((t) => t.kind === "text" && !t.virtual && t.path !== null && replaced.has(norm(t.path)));
    for (const tab of affected) {
      const path = tab.path;
      // 替换前已筛掉脏标签；这里双保险，避免把未保存编辑盖掉
      if (!path || tab.dirty) continue;
      try {
        const data = await readDiskAs(path, tab.encoding);
        tabStore.reopenWith(tab.id, data);
        tabStore.setMojibake(tab.id, "", "");
        tabStore.markExternal(tab.id, false);
      } catch (e) {
        console.warn("[replace] 重新载入失败", e);
      }
    }
    if (affected.some((t) => t.id === activeTab()?.id)) await reloadActiveTab();
    fileTree.refresh();
    sessionHost.refreshWatched();
    statusBar.refresh();
  },
  showMessage: statusBar.showMessage,
});
const sidebarOutline = new OutlineView($("sidebar-outline"), {
  getView: () => editorHandle.view,
  getLanguage: () => {
    const tab = activeTab();
    return tab ? effectiveLanguage(tab) : null;
  },
  isAvailable: () => {
    const tab = activeTab();
    return !!tab && tab.kind === "text" && !tab.virtual;
  },
});
// 侧栏「正在打开的文件」：点击激活 / 关闭（含未保存确认）+ 右键菜单
const openEditors = new OpenEditorsView($("sidebar-open"), {
  onActivate: (id) => tabStore.activate(id),
  onClose: (id) => void closeTab(id),
  onCloseOthers: (id) => void closeTabsBulk(() => tabStore.closeOthers(id)),
  onCloseAll: () => void closeTabsBulk(() => tabStore.closeAll()),
  onCompare: (id) => diffService.compareTabs(id),
  onCopyPath: (path) => {
    void navigator.clipboard.writeText(path).then(
      () => statusBar.showMessage("已复制文件路径"),
      () => statusBar.showMessage("复制文件路径失败"),
    );
  },
  onReveal: (path) => void invoke("reveal_in_file_manager", { path }),
});
openEditors.refresh();
const sidebarViews = new SidebarViews(
  $("sidebar-sections"),
  {
    open: $("sidebar-open"),
    files: $("file-tree"),
    search: $("sidebar-search"),
    outline: $("sidebar-outline"),
  },
  {
    initial: "files",
    onChange: (view) => {
      statusBar.persistConfig({ layout: { ...getConfig().layout, sidebarView: view } });
      if (view === "open") openEditors.refresh();
      if (view === "search") sidebarSearch.focusInput();
      if (view === "outline") sidebarOutline.scheduleRefresh();
    },
  },
);

/** 菜单 / 快捷键：展开侧栏并切到指定视图 */
function showSidebarView(view: "open" | "files" | "search" | "outline"): void {
  layout.setSidebarVisible(true);
  sidebarViews.switch(view);
  if (view === "open") openEditors.refresh();
  if (view === "search") sidebarSearch.focusInput();
  if (view === "outline") sidebarOutline.scheduleRefresh();
}

/** 菜单 / 快捷键：展开侧栏并聚焦工作区搜索；编辑器有选区时带入关键词 */
function focusWorkspaceSearch(): void {
  showSidebarView("search");
  const selection = selectedSearchText();
  if (selection) sidebarSearch.setQuery(selection);
  else sidebarSearch.focusInput();
}

/**
 * 取编辑器当前选区作为搜索关键词：多行只取首行，超长截断 200 字符。
 * 无选区 / 非文本标签 / 大文件虚拟视图时返回 null（保持“仅聚焦”）。
 */
function selectedSearchText(): string | null {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || tab.virtual) return null;
  if (editorHandle.docId() !== tab.id) return null;
  const view = editorHandle.view;
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  const firstLine = view.state
    .sliceDoc(sel.from, sel.to)
    .split(/\r?\n/)[0]
    .trim();
  if (!firstLine) return null;
  return firstLine.slice(0, 200);
}

btnOpenDir.addEventListener("click", () => void openWorkspaceDir());

// ---- 窗口 chrome（标题栏 / 缩放热区 / 退出清理）：见 app/windowChrome.ts ----

// ---- 标签页右键菜单：见 ui/tabsBar.ts ----

// ---- 编辑器初始化（CM6 仅承载 <20MB 文档）----
editorHandle = createEditor($("editor"), {
  onDocChange: () => {
    const tab = activeTab();
    if (!tab) return;
    // 编辑器承载的文档必须仍是该标签：切换标签的异步窗口内视图里
    // 可能还是上一个文档，此时写入会把内容/草稿串到错误标签上
    if (editorHandle.docId() !== tab.id) return;
    // 只标记（O(1)）：全文快照与脏精算由 store 在读取时 / 停手后自行完成
    tabStore.markEdited(tab.id);
    const t = tabStore.findById(tab.id);
    if (t) preview.scheduleRender(t);
    // 结果面板存的是绝对偏移：编辑后防抖重枚举，否则双击跳错位置
    resultsPanel?.scheduleRefresh();
    // 未保存内容防抖写入草稿（配置关闭时不写）
    if (t) sessionHost.scheduleDraftSave(t);
    if (sidebarViews.view === "outline") sidebarOutline.scheduleRefresh();
  },
  onCursorChange: ({ line, col, totalLines, selectedChars }) => {
    statusCursor.textContent =
      selectedChars > 0
        ? `行 ${line}，列 ${col}（选中 ${selectedChars} 字符）`
        : `行 ${line}，列 ${col}`;
    statusLines.textContent = `共 ${totalLines} 行`;
    const tab = activeTab();
    // 同上：编辑器文档与激活标签不一致时丢弃，避免光标串台
    if (tab && editorHandle.docId() === tab.id) {
      // 只标记，不写盘：切标签 / 隐藏 / 定时器兜底时再落会话
      sessionHost.setCursor(tab.id, { line, col });
    }
  },
  onHighlightDisabled: (reason) => {
    console.info(`[editor] 高亮已禁用: ${reason}`);
    statusLanguage.textContent = "纯文本（高亮已禁用）";
  },
});

// 惰性快照：按键只标记内容已变，需要全文时经 snapshotOf 从编辑器拉取
tabStore.setContentProvider({
  docId: () => editorHandle.docId(),
  full: () => editorHandle.getContent(),
  head: (chars) => editorHandle.view.state.doc.sliceString(0, chars),
});

// 配置变更 → 热更新编辑器（缩进/括号/缩进线/同名高亮/列选择/键位/主题等 Compartment 重配）
// + 应用主题（CSS 变量）与状态栏字段显隐
subscribeSettings(() => {
  statusBar.applyTheme(getConfig());
  statusBar.applyFields(getConfig().layout.statusBarFields);
  editorHandle.applySettings();
  statusBar.refresh();
  statusBar.refreshWhitespace();
  // 语言映射 / 只读阈值等配置会影响可运行性判断
  refreshRunButton();
});

// 编辑器右键菜单（条目由 buildEditorMenu 按当前状态构建）
new EditorContextMenu(editorHandle.view.dom, editorMenuEntryPoint);

// 预览编排（模式 / 联动 / 导出）
const preview = new PreviewController($("preview-pane"), modeBar, editorArea, {
  getActiveTab: activeTab,
  getView: () => editorHandle.view,
  showMessage: statusBar.showMessage,
});

/**
 * 运行按钮刷新的迟绑定入口：createStatusBar / tabStore 订阅都早于 RunHost 构造，
 * 运行期统一走这里，避免在初始化完成前访问未初始化的常量（TDZ）。
 */
let refreshRunButton: () => void = () => {};

/** 内容帧合并刷新的定时器（已有待执行任务时不重复排程） */
let runButtonTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRunButtonRefresh(): void {
  if (runButtonTimer !== null) return;
  runButtonTimer = setTimeout(() => {
    runButtonTimer = null;
    refreshRunButton();
  }, 300);
}

/**
 * 「重载当前标签」的迟绑定入口。
 * largeHost / diffService / sessionHost 构造时 tabSwitcher 还不存在
 * （它的依赖又包含这些宿主，构成构造环）；装配完成后由下方赋值，
 * 运行期所有调用都走这里，不再有模块级可变状态散落各处。
 */
let reloadActiveTab: () => Promise<void> = async () => {};

// 大文件只读虚拟视图宿主（分流 / 会话 / 逃生门）
const largeHost = new LargeFileHost({
  showMessage: statusBar.showMessage,
  onCheckMojibake: (tabId) => void statusActions.checkMojibake(tabId),
  onReloadActiveTab: () => reloadActiveTab(),
});

// 格式化编排（文档级 / 选中级 / 保存前自动格式化）
const formatHost = new FormatHost({
  getActiveTab: activeTab,
  getView: () => editorHandle.view,
  getDocId: () => editorHandle.docId(),
  blockIfReadonly,
  showMessage: statusBar.showMessage,
  refreshStatus: () => statusBar.refresh(),
});

// 文件操作服务（打开 / 保存 / 另存 / 插入图片 / 配置）
const fileService = new FileService({
  getActiveTab: activeTab,
  blockIfReadonly,
  showMessage: statusBar.showMessage,
  onCheckMojibake: (tabId) => void statusActions.checkMojibake(tabId),
  onDiscardDraft: (tabId) => void sessionHost.discardDraft(tabId),
  onPersistDraft: (tabId) => void sessionHost.persistDraft(tabId),
  insertAtCursor,
  syncWatchedFiles: () => sessionHost.syncWatchedDebounced(),
  refreshStatus: () => statusBar.refresh(),
  pickEncoding: (encodings, current, onPick, note) =>
    runHost.pickEncoding(encodings, current, onPick, note),
  largeHost,
  // 保存前格式化：单编辑器实例，只处理激活标签；失败不阻塞保存
  formatBeforeSave: (tab) => formatHost.beforeSave(tab),
});

// 快速打开（Ctrl+P）：工作区文件模糊过滤 → 打开（含大文件分流）
const quickOpen = new QuickOpen({
  getRoot: () => workspaceRoot,
  getIgnoreDirs: () => getConfig().ignoreDirs,
  onOpen: (path) => void fileService.openFilePath(path),
  showMessage: statusBar.showMessage,
});

// 内置终端编排（懒加载 xterm；打开时让出底部区域给运行输出）
let runHostRef: RunHost | null = null;
const terminalHost = new TerminalHost({
  getActiveTab: activeTab,
  getWorkspaceRoot: () => workspaceRoot,
  showMessage: statusBar.showMessage,
  onBeforeOpen: () => runHostRef?.hideOutputPanel(),
});

// 运行与工具面板宿主（Code Run / Cron / 批量编码 / 正则 / 表格 / 最近打开）
const runHost = new RunHost(runBtn, {
  getActiveTab: activeTab,
  blockIfReadonly,
  showMessage: statusBar.showMessage,
  getView: () => editorHandle.view,
  onOpenFile: (path) => void fileService.openFilePath(path),
  insertAsTab: (text, name, language) => fileService.openGeneratedTab(name, text, language),
  runInTerminal: (path, runner) => void terminalHost.runFile(path, runner),
  runCurlInTerminal: (script) => void terminalHost.runCurlScript(script),
  onOpenLocation: (path, line) => void openFileAt(path, line),
  onBeforeRun: () => terminalHost.hide(),
  // F5 / 在终端运行：未保存时先落盘（writeTo 负责脏标记与草稿语义）
  onSaveTab: async (tab) => {
    if (!tab.path) return false;
    try {
      await fileService.writeTo(tab, tab.path);
      return true;
    } catch (e) {
      statusBar.showMessage(`保存失败: ${String(e).split("\n")[0]}`);
      return false;
    }
  },
});
runHostRef = runHost;
refreshRunButton = () => runHost.refreshRunButton();

// 首屏引导（无标签时显示）：入口全部转发到已有动作
welcomeView = new WelcomePanel($("welcome"), {
  onOpenFile: () => void fileService.openFileDialog(),
  onNewFile: () => fileService.newUntitled(),
  onOpenDirectory: () => void openWorkspaceDir(),
  onRecent: () => runHost.toggleRecentFiles(),
});
welcomeView.setVisible(tabStore.list().length === 0);

// 网页抓取编排（默认目录 / PathGuard 登记 / 抓取后打开）
const fetchHost = new FetchHost({
  getActiveTab: activeTab,
  getWorkspaceRoot: () => workspaceRoot,
  onOpenFile: (path) => void fileService.openFilePath(path),
  showMessage: statusBar.showMessage,
});

// 差异比较编排（未保存 / 与文件 / 与 Git）
const diffService = new DiffService({
  getActiveTab: activeTab,
  showMessage: statusBar.showMessage,
  onReloadActiveTab: () => reloadActiveTab(),
});

// 窗口 chrome（标题栏按钮 / 缩放热区 / 退出清理）
const windowChrome = new WindowChrome({
  onBeforeExit: async () => {
    await sessionHost.flush();
    try {
      await invoke("stop_run");
    } catch {
      // 没有进程在跑时 stop_run 返回 false 或报错，均可忽略
    }
    for (const tab of tabStore.list()) {
      if (tab.virtual && tab.largeId) {
        try {
          await invoke("close_large_file", { id: tab.largeId });
        } catch {
          // 会话可能已释放，忽略
        }
      }
    }
    await terminalHost.dispose();
  },
});

// ---- 窗口拖放：文件直接打开，目录询问后设为工作区 ----
const dropHost = new DropHost({
  onHover: (active) =>
    document.getElementById("app")?.classList.toggle("drag-active", active),
  showMessage: statusBar.showMessage,
  onPaths: async (paths) => {
    for (const path of paths) {
      let kind: "file" | "dir";
      try {
        kind = await invoke<"file" | "dir">("path_kind", { path });
      } catch (e) {
        statusBar.showMessage(`无法读取路径: ${String(e).split("\n")[0]}`);
        continue;
      }
      if (kind === "dir") {
        const ok = await confirmAction(`将「${basenameOf(path)}」设为工作区？`);
        if (ok) fileTree.setRoot(path);
        continue;
      }
      await fileService.openFilePath(path);
    }
  },
});
void dropHost.mount();

// 布局（侧栏显隐 / 侧栏宽度 / 双栏分割线）
const layout = new LayoutPane({
  isSplitMode: () => preview.currentMode() === "split",
  persistSidebarVisible: (visible) =>
    statusBar.persistConfig({ layout: { ...getConfig().layout, sidebarVisible: visible } }),
});

// 会话与草稿宿主（session.json / 草稿自动保存与恢复 / 外部修改监听）
const sessionHost = new SessionHost(
  {
    getActiveTab: activeTab,
    getView: () => editorHandle.view,
    showMessage: statusBar.showMessage,
    refreshStatus: () => statusBar.refresh(),
    onReloadActiveTab: () => reloadActiveTab(),
    onOpenFile: (path) => fileService.openFilePath(path, { silent: true }),
    onNewUntitled: (name) => fileService.newUntitled(name),
    onLoadPendingTab: (tab) => largeHost.loadPendingTab(tab),
    onDiffDisk: () => void diffService.diffUnsaved({ allowClean: true }),
  },
  statusDraft,
  statusExternal,
);

// 标签切换状态机（编辑器/预览/文件树/大文件视图同步 + 代际校验）
const tabSwitcher = new TabSwitcher({
  getActiveTab: activeTab,
  getEditor: () => editorHandle,
  largeHost,
  preview,
  fileTree,
  sessionHost,
  getResultsPanel: () => resultsPanel,
});
// 构造环收口：此后各宿主的「重载当前标签」都走 tabSwitcher
reloadActiveTab = () => tabSwitcher.load();

// ---- 预览宿主（编排在 app/previewHost.ts，渲染在 panels/preview.ts）----

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

// ---- 剪贴板（编辑器右键菜单的剪切 / 复制 / 粘贴）：见 editor/clipboard.ts ----

// ---- 编辑器右键菜单内容：见 app/menuContent.ts ----

/** 每次右键时构建条目（可见性依赖只读 / 选区 / 语言等实时状态） */
function editorMenuEntryPoint(): MenuEntry[] {
  return buildEditorMenu({
    getView: () => editorHandle.view,
    getActiveTab: activeTab,
    showMessage: statusBar.showMessage,
    insertAtCursor,
    openFind: openFindInDoc,
    openReplace: openReplaceInDoc,
    toggleResults: toggleResultsPanel,
    formatDocument: () => void formatHost.formatCurrent(),
    formatSelection: () => void formatHost.formatSelectionCurrent(),
    insertClipboardImage: () => void fileService.insertClipboardImage(),
    diffUnsaved: () => void diffService.diffUnsaved(),
    runHost,
  });
}

// ---- 外部修改检测（Rust 侧监听，前端仅提示、不自动重载）：见 app/sessionHost.ts ----

// ---- 双栏分割线拖动 / 侧栏宽度：见 app/layout.ts ----

// ---- 文件操作（打开/保存/另存/插入图片/配置）：见 app/fileService.ts ----

// ---- 格式化编排：见 app/formatHost.ts ----

// ---- 查找结果面板开关（菜单/命令面板共用）----
function toggleResultsPanel(): void {
  if (resultsPanel) {
    resultsPanel.destroy();
    resultsPanel = null;
    return;
  }
  resultsPanel = new SearchResultsPanel(resultsContainer, editorHandle.view);
}

// ---- 大文件只读虚拟视图：见 app/largeFileHost.ts ----

// ---- 差异比较（未保存改动 / 与另一文件 / 与 Git）：见 app/diffService.ts ----

// ---- 设置中心（Ctrl+, / 菜单 / 命令面板）----

/** 设置面板按需加载：只在打开设置时引入 */
let settingsPanelInstance: SettingsPanel | null = null;
let settingsPanelPromise: Promise<SettingsPanel> | null = null;

function ensureSettingsPanel(): Promise<SettingsPanel> {
  if (!settingsPanelPromise) {
    settingsPanelPromise = import("./panels/settingsPanel").then(({ SettingsPanel }) => {
      settingsPanelInstance = new SettingsPanel({
        onSidebarVisible: (visible) => {
          // 仅应用到界面；持久化由 updateSettings 完成
          layout.setSidebarVisible(visible);
        },
        onSplitRatio: (ratio) => statusBar.setSplitRatio(ratio),
        onViewMode: (mode) => {
          const tab = activeTab();
          if (tab && pathKindOf(tab.path)) {
            preview.setMode(mode);
          }
        },
        onMessage: statusBar.showMessage,
      });
      return settingsPanelInstance;
    });
  }
  return settingsPanelPromise;
}

function openSettings(category: "theme" | "keybindings" | "layout" = "theme"): void {
  void ensureSettingsPanel().then((panel) => panel.open(category));
}

// ---- 侧栏显隐 / 侧栏宽度拖拽：见 app/layout.ts ----

$<HTMLButtonElement>("search-box").addEventListener("click", () => palette.open());
// 侧栏开关两处入口：侧栏头部（收起）、标签栏左端（展开，侧栏收起时才显示）
for (const id of ["btn-sidebar-toggle", "btn-sidebar-show"]) {
  document.getElementById(id)?.addEventListener("click", () => layout.toggleSidebar());
}
$<HTMLButtonElement>("btn-terminal").addEventListener("click", () => void terminalHost.toggle());

// 调试面板开关（免去按 F12）；命令属 core webview 插件而非 window。
// 发布构建同样可用：Cargo.toml 已开启 tauri 的 devtools 特性，否则该命令不存在。
$<HTMLButtonElement>("btn-devtools").addEventListener("click", () => {
  void invoke("plugin:webview|internal_toggle_devtools").catch((e) =>
    console.error("[devtools] 切换失败", e),
  );
});

// ---- 菜单栏 ----
// 菜单数据由命令注册表派生（core/commands.ts 的 menuModel），
// 与命令面板、快捷键、设置中心键位页同源。构造见下方命令注册之后。

// ---- 运行与工具面板（Code Run / Cron / 批量编码 / 正则 / 表格 / 最近打开）：见 app/runHost.ts ----

// ---- 命令面板 ----

// ---- 命令注册表（唯一命令来源）----
// 菜单栏 / 命令面板 / 快捷键 / 设置中心键位页全部由本表派生。
// 字段语义见 core/commands.ts：menu* 控制菜单栏，defaultKey 控制快捷键，
// hidden 控制是否进命令面板，menuOrder 控制菜单内顺序。
// ---- 命令注册表（唯一命令来源）：数据见 app/commandTable.ts ----
// 菜单栏 / 命令面板 / 快捷键 / 设置中心键位页全部由本表派生。
registerCommands(
  buildCommandTable({
    fileService,
    quickOpen,
    fetchHost,
    preview,
    diffService,
    runHost,
    terminalHost,
    windowChrome,
    layout,
    palette,
    tabSwitcher,
    formatHost,
    statusActions,
    statusBar,
    getActiveTab: activeTab,
    getView: () => editorHandle.view,
    openSettings,
    openWorkspaceDir,
    closeTab,
    saveAllFiles,
    reloadCurrentFile,
    reopenClosedTab,
    blockIfReadonly,
    insertAtCursor,
    toggleResultsPanel,
    focusWorkspaceSearch,
    showSidebarView,
    showShortcuts: () => showShortcutsDialog(shortcutRows()),
    showAbout: () =>
      void showAboutDialog({ onShowShortcuts: () => showShortcutsDialog(shortcutRows()) }),
  }),
);

// 命令面板与菜单栏由同一注册表派生，快捷键展示也走同一解析
function shortcutText(cmd: CommandDef): string {
  const raw =
    cmd.menuShortcut ??
    (cmd.defaultKey !== undefined ? resolveKey(cmd, getConfig()) : "");
  return raw ? formatKey(raw) : "";
}

/** 快捷键速查数据：只取已绑定键位的命令（含 fixed 展示项） */
function shortcutRows(): ShortcutRow[] {
  return allCommands()
    .filter((c) => c.defaultKey !== undefined)
    .map((c) => ({ section: c.section, title: c.title, shortcut: shortcutText(c) }))
    .filter((row) => row.shortcut !== "");
}

palette.registerAll(
  commandPaletteItems().map((item) => ({
    ...item,
    // 函数形式：每次渲染时按当前配置解析，改键位后无需重新注册
    shortcut: () => {
      const def = getCommand(item.id);
      return def ? shortcutText(def) : "";
    },
  })),
);
new MenuBar($("menubar"), menuModel((cmd) => shortcutText(cmd)));

async function openWorkspaceDir(): Promise<void> {
  const dir = await pickDirectory();
  if (!dir) return;
  // setRoot 会经 onWorkspaceStateChange 同步 workspaceRoot、侧栏标题与持久化
  fileTree.setRoot(dir);
}

/** 打开运行输出中的文件位置（堆栈点击）：打开文件并跳到指定行 */
async function openFileAt(path: string, line: number): Promise<void> {
  await fileService.openFilePath(path);
  // openFilePath 的标签加载是异步的：等 tabSwitcher 把文档真正装进编辑器
  await tabSwitcher.load();
  if (activeTab()?.virtual) {
    statusBar.showMessage("大文件只读视图不支持跳转到指定行");
    return;
  }
  editorHandle.gotoLine(line);
}

// ---- 快捷键分发（注册表驱动；用户覆盖存 config.json 的 keybindings 段）----
// 捕获阶段 + e.code（物理键位）：
// 1) CM6 在冒泡链上游消费按键，挂 window 冒泡会收不到；
// 2) 中文 IME / 不同键盘布局下 e.key 不可靠，e.code 稳定。
// 命令定义见上方 registerCommands（唯一来源），此处仅挂分发器。

// 列编辑器当前键位加入保留集：全局命令不得抢占（其自身经 editorEnhancements.columnEditorKey 改绑）
setExtraReservedKeys([settings.columnEditorKey]);

/**
 * 是否处于模态状态（任何对话框 / 差异视图 / 命令面板打开中）。
 * 模态期间屏蔽全局快捷键：否则会在模态背后关标签、启动子进程等。
 */
const MODAL_SELECTORS =
  ".dialog-backdrop, .settings-backdrop, .diff-backdrop, .palette-overlay";

function isModalOpen(): boolean {
  return document.querySelector(MODAL_SELECTORS) !== null;
}

/**
 * WebView2 默认会处理的“编辑无关”快捷键（Ctrl+S 保存网页 / Ctrl+P 打印等）。
 * 命令未消费时必须主动阻止默认行为，否则会弹出与编辑器无关的系统对话框。
 * 注意：只 preventDefault、不 stopPropagation——模态内部（如键位录制）仍需收到按键。
 */
const BROWSER_DEFAULT_KEYS = new Set(["KeyS", "KeyP", "KeyO", "KeyN", "KeyF", "KeyG"]);

function blockBrowserDefault(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && BROWSER_DEFAULT_KEYS.has(e.code)) {
    e.preventDefault();
  }
}

/**
 * 模态关闭后恢复焦点。
 * 对话框被移除后焦点会落到 body，用户再按 Ctrl+S / Ctrl+F 等依赖编辑器
 * 焦点的快捷键全部失效，必须手动点回编辑区。
 * 这里全局统一处理：记住最后一个「模态外」焦点元素，全部模态关闭时恢复。
 */
let lastNonModalFocus: HTMLElement | null = null;
document.addEventListener("focusin", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.closest(MODAL_SELECTORS)) return; // 模态内部的焦点变迁不记录
  lastNonModalFocus = t;
});
new MutationObserver(() => {
  if (isModalOpen()) return;
  const prev = lastNonModalFocus;
  if (prev?.isConnected) prev.focus();
}).observe(document.body, { childList: true, subtree: true });

window.addEventListener(
  "keydown",
  (e) => {
    // 模态 / 面板打开期间不派发全局命令（仅放行 Esc 由各面板自行处理）；
    // 但仍要阻止 WebView2 的默认快捷键，否则 Ctrl+S 会弹“保存网页”对话框
    if (isModalOpen()) {
      blockBrowserDefault(e);
      return;
    }
    const cmd = matchKeyCommand(e, getConfig());
    if (!cmd) {
      // 未被命令占用（用户改键位 / 无激活标签等）：不让它落到浏览器默认行为
      blockBrowserDefault(e);
      return;
    }
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
  layout.applyConfiguredSidebar();
  // 2.1) 侧栏视图（文件 / 搜索 / 大纲）按配置恢复
  sidebarViews.restore(getConfig().layout.sidebarView ?? "files");
  // 3) 分栏默认比例：localStorage 无记录时按配置（不写回，留给用户拖动/设置时落盘）
  layout.applyConfiguredSplitRatio();
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
    wsName.textContent = basenameOf(state.root) || state.root;
    wsName.title = state.root;
  }

  // 过期草稿清理（保留天数取自配置，0 表示不清理）
  void cleanupDrafts(getConfig().session.draftRetentionDays).catch(() => {});
  // 过期替换历史清理（保留最近 10 批 / 7 天；历史存于应用配置目录）
  void invoke("cleanup_replace_history", { keep: 10, days: 7 }).catch(() => {});

  // 恢复会话：打开文件列表 + 光标位置 + 分栏比例（可在配置中关闭）
  if (getConfig().session.restoreOnStartup) {
    try {
      const sess = await loadSession();
      if (sess.splitRatio != null) statusBar.setSplitRatio(sess.splitRatio);
      sessionHost.primeRestoredCursors(sess.openFiles);
      if (sess.activeFile) await fileService.openFilePath(sess.activeFile, { silent: true });
      for (const f of sess.openFiles) {
        if (f.path === sess.activeFile) continue;
        tabStore.openPending(f.path, basenameOf(f.path));
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
  await sessionHost.offerDraftRecovery();

  // 登记外部修改监听（会话恢复出的标签一并纳入）
  sessionHost.refreshWatched();
}

void bootstrap();
