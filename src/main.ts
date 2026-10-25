import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
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
import { FileTree } from "./panels/fileTree";
import { CommandPalette } from "./panels/commandPalette";
import { WelcomePanel } from "./panels/welcome";
import { MenuBar } from "./panels/menubar";
import { pathKindOf } from "./panels/preview";
import { tabStore, type Tab } from "./store/tabs";
import { confirmAction, confirmCloseDirty } from "./ui/dialogs";
import { showSettingsHelp } from "./ui/settingsHelp";
import { openStatusMenu } from "./ui/statusMenu";
import { createStatusBar } from "./ui/statusBar";
import { TabsBar } from "./ui/tabsBar";
import { Breadcrumb } from "./ui/breadcrumb";
import { EditorContextMenu, type MenuEntry } from "./ui/editorMenu";
import { copyFromEditor, pasteIntoEditor } from "./editor/clipboard";
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
  commandPaletteItems,
  getCommand,
  menuModel,
  registerCommands,
  type CommandDef,
} from "./core/commands";
import { CONVERT_TARGET_LABELS, type ConvertTarget } from "./core/convert";
import type { SettingsPanel } from "./panels/settingsPanel";
import { CASE_LABELS, type CaseMode } from "./editor/transforms";
import { localStamps, newUuid } from "./core/stamps";
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

/** 格式转换目标（按源格式分组：JSON / YAML / Properties / Java） */
const CONVERT_TARGETS: ConvertTarget[] = [
  "json2yaml",
  "json2java",
  "yaml2json",
  "yaml2properties",
  "properties2yaml",
  "java2json",
];

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

// ---- 状态栏弹出菜单（换行符 / 语言 / 编码：统一工厂，见 ui/statusMenu.ts）----

const NEWLINE_OPTIONS: { value: string; label: string }[] = [
  { value: "LF", label: "LF（Unix / macOS）" },
  { value: "CRLF", label: "CRLF（Windows）" },
  { value: "CR", label: "CR（老式 Mac）" },
];

function showNewlineMenu(x: number, y: number): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    statusBar.showMessage("当前文件不支持切换换行符");
    return;
  }
  openStatusMenu({
    anchor: { x, y },
    header: `当前换行符：${tab.newline}`,
    options: NEWLINE_OPTIONS,
    current: tab.newline,
    tabId: tab.id,
    onMessage: statusBar.showMessage,
    onPick: (value) => applyNewline(tab.id, value),
  });
}

/** 应用换行符：仅改内存状态并标脏，由用户手动保存落盘 */
function applyNewline(tabId: string, newline: string): void {
  tabStore.setNewline(tabId, newline);
  statusBar.refresh();
  statusBar.showMessage(`换行符已切换为 ${newline}（未保存，Ctrl+S 保存）`);
}

statusNewline.title = "点击切换换行符（LF / CRLF / CR）";
statusNewline.style.cursor = "pointer";
statusNewline.addEventListener("click", (e) => {
  e.stopPropagation();
  showNewlineMenu(e.clientX, e.clientY);
});

// ---- 状态栏语言菜单（手动覆盖高亮语言）----
// effectiveLanguage / languageLabel 实现见 editor/languages.ts

function showLanguageMenu(x: number, y: number): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text") {
    statusBar.showMessage("当前文件不支持切换语言");
    return;
  }
  if (tab.virtual) {
    statusBar.showMessage("大文件只读视图不支持切换语言");
    return;
  }
  // 自动项 + 纯文本 + 全部已注册语言
  const auto = tab.path ? languageKeyFromPath(tab.path) : null;
  openStatusMenu({
    anchor: { x, y },
    header: `当前语言：${languageLabel(tab)}`,
    options: [
      { value: undefined, label: `自动（${auto ? (languageDisplayNames[auto] ?? auto) : "纯文本"}）` },
      { value: null, label: "纯文本" },
      ...Object.keys(languageDisplayNames)
        .filter((key) => key !== "plaintext")
        .map((key) => ({ value: key as string | null, label: languageDisplayNames[key] })),
    ],
    current: tab.languageOverride,
    tabId: tab.id,
    onMessage: statusBar.showMessage,
    onPick: (value) => void applyLanguageOverride(tab.id, value),
  });
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
  statusBar.refresh();
  statusBar.showMessage(`语言模式：${languageLabel(tab)}`);
}

statusLanguage.title = "点击切换高亮语言";
statusLanguage.style.cursor = "pointer";
statusLanguage.addEventListener("click", (e) => {
  e.stopPropagation();
  showLanguageMenu(e.clientX, e.clientY);
});

// ---- 状态栏编码菜单（「重新打开为」，只改解读方式、不写盘）----
// FALLBACK_ENCODINGS 见 app/fileService.ts（与另存为编码共用）

function showEncodingMenu(x: number, y: number): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    statusBar.showMessage("当前文件不支持切换编码");
    return;
  }
  openStatusMenu({
    anchor: { x, y },
    header: `当前编码：${tab.encoding}`,
    options: (tab.encodingCandidates.length ? tab.encodingCandidates : FALLBACK_ENCODINGS).map(
      (enc) => ({ value: enc, label: enc }),
    ),
    // 两类编码操作同框但语义不同：上面只改解读方式，下面是真正转码写新文件
    actions: [
      {
        label: "另存为编码…（转码写入新文件）",
        separatorBefore: true,
        run: () => void fileService.saveAsWithEncoding(),
      },
    ],
    current: tab.encoding,
    tabId: tab.id,
    onMessage: statusBar.showMessage,
    onPick: (enc) => void reopenWithEncoding(tab.id, enc),
  });
}

/** 重新打开为：按新编码重新解读磁盘字节（不写盘） */
async function reopenWithEncoding(tabId: string, encoding: string): Promise<void> {
  const tab = tabStore.findById(tabId);
  if (!tab || !tab.path) return;
  if (
    tab.dirty &&
    !(await confirmAction(
      `「${tab.name}」有未保存修改，重新打开将丢弃这些修改。是否继续？`,
    ))
  ) {
    return;
  }
  try {
    const data = await readDiskAs(tab.path, encoding);
    tabStore.reopenWith(tabId, data);
    // 编码已变更：旧结论失效，按新解读重新检测
    tabStore.setMojibake(tabId, "", "");
    if (tabStore.active()?.id === tabId) {
      await tabSwitcher.load();
      void checkMojibake(tabId);
    } else {
      statusBar.refresh();
    }
    statusBar.showMessage(
      tabStore.findById(tabId)?.dirty
        ? `编码已切换为 ${data.encoding}（未保存，Ctrl+S 转码保存）`
        : `已重新打开为 ${data.encoding}`,
    );
  } catch (e) {
    statusBar.showMessage(`重新打开失败: ${String(e).split("\n")[0]}`);
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
      text: tabStore.snapshotOf(tab),
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
      statusBar.showMessage(report.reason);
    }
  } catch (e) {
    console.warn("[mojibake] 检测失败", e);
  }
}

/** 命令面板入口：对当前标签立即重检并给出可选建议 */
function detectMojibakeManually(): void {
  const tab = activeTab();
  if (!tab || tab.kind !== "text" || !tab.path) {
    statusBar.showMessage("请先打开一个磁盘上的文本文件");
    return;
  }
  if (tab.virtual) {
    statusBar.showMessage("大文件只读视图不支持乱码检测");
    return;
  }
  void (async () => {
    await checkMojibake(tab.id);
    const fresh = tabStore.findById(tab.id);
    if (!fresh) return;
    if (!fresh.mojibakeReason) {
      statusBar.showMessage("未检测到乱码");
      return;
    }
    if (fresh.mojibakeSuggested) {
      const ok = await confirmAction(
        `${fresh.mojibakeReason}。是否立即重新打开为 ${fresh.mojibakeSuggested}？`,
        "重新打开",
      );
      if (ok) await reopenWithEncoding(fresh.id, fresh.mojibakeSuggested);
    } else {
      statusBar.showMessage(fresh.mojibakeReason);
    }
  })();
}

statusEncoding.style.cursor = "pointer";
statusEncoding.addEventListener("click", (e) => {
  e.stopPropagation();
  showEncodingMenu(e.clientX, e.clientY);
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
  welcomeView?.setVisible(tabStore.list().length === 0);
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
new EditorContextMenu(editorHandle.view.dom, buildEditorMenu);

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
  onCheckMojibake: (tabId) => void checkMojibake(tabId),
  onReloadActiveTab: () => reloadActiveTab(),
});

// 文件操作服务（打开 / 保存 / 另存 / 插入图片 / 配置）
const fileService = new FileService({
  getActiveTab: activeTab,
  blockIfReadonly,
  showMessage: statusBar.showMessage,
  onCheckMojibake: (tabId) => void checkMojibake(tabId),
  onDiscardDraft: (tabId) => void sessionHost.discardDraft(tabId),
  onPersistDraft: (tabId) => void sessionHost.persistDraft(tabId),
  insertAtCursor,
  syncWatchedFiles: () => sessionHost.syncWatchedDebounced(),
  refreshStatus: () => statusBar.refresh(),
  pickEncoding: (encodings, current, onPick, note) =>
    runHost.pickEncoding(encodings, current, onPick, note),
  largeHost,
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

// ---- 编辑器右键菜单内容（对齐常用编辑器：编辑 + 剪贴板 + 查找 + 格式化）----
// 菜单机器（子菜单/定位/关闭）在 ui/editorMenu.ts；此处只构建条目——
// 哪些条目可见取决于只读 / 选区 / 语言等领域状态。

function buildEditorMenu(): MenuEntry[] {
  const view = editorHandle.view;
  const readonly = view.state.readOnly;
  const tab = activeTab();
  const lang = tab ? effectiveLanguage(tab) : null;
  const hasSelection = !view.state.selection.main.empty;
  const canFormat = supportsFormatting(lang);
  const canRun =
    tab !== null && tab.kind === "text" && Boolean(tab.path) && runHost.runnerFor(tab) !== null;
  // cURL 入口只在当前选区/文档确实像 curl 命令时出现（避免 Python 等文件误显）
  const canScript = runHost.looksLikeCurlScript();
  const cut = (): void => void copyFromEditor(view, true, statusBar.showMessage);
  const copy = (): void => void copyFromEditor(view, false, statusBar.showMessage);
  const paste = (): void => void pasteIntoEditor(view, statusBar.showMessage);

  // 顶层保持短小：常用编辑命令平铺，其余收进二级菜单
  const top: MenuEntry[] = [];
  if (!readonly) {
    top.push({ label: "撤销", shortcut: "Ctrl+Z", run: () => void undo(view) });
    top.push({ label: "重做", shortcut: "Ctrl+Shift+Z", run: () => void redo(view) });
    top.push({ separator: true });
    top.push({ label: "剪切", shortcut: "Ctrl+X", run: cut });
  }
  top.push({ label: "复制", shortcut: "Ctrl+C", run: copy });
  if (!readonly) top.push({ label: "粘贴", shortcut: "Ctrl+V", run: paste });
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
  if (canRun) code.push({ label: "运行当前文件", shortcut: "F5", run: () => runHost.runCurrentFile() });
  if (canRun) code.push({ label: "在终端运行当前文件", shortcut: "Ctrl+F5", run: () => runHost.runInTerminal() });
  if (runHost.isRunning) code.push({ label: "停止运行", run: () => runHost.stop() });
  if (canScript) code.push({ label: "执行 cURL 脚本", run: () => runHost.runCurlScript() });
  if (canScript) code.push({ label: "在终端执行 cURL 脚本", run: () => runHost.runCurlInTerminal() });
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
        { label: "JSON 美化", run: () => runHost.runJson(false) },
        { label: "JSON 压缩", run: () => runHost.runJson(true) },
      ],
    });
  } else if (!readonly && lang === "markdown") {
    top.push({
      label: "Markdown",
      submenu: [
        { label: "加粗", run: () => runHost.runWrap("**", "加粗：") },
        { label: "斜体", run: () => runHost.runWrap("*", "斜体：") },
        { label: "高亮", run: () => runHost.runWrap("==", "高亮：") },
        { label: "插入表格…", run: () => runHost.toggleTableDialog() },
      ],
    });
  }

  // 格式转换：面板始终可开（只读禁替换）；直转仅在可写时列出
  if (tab && tab.kind === "text" && !tab.virtual) {
    const convertItems: MenuEntry[] = [
      { label: "打开转换面板…", run: () => runHost.openConvertPanel() },
    ];
    if (!readonly) {
      convertItems.push({ separator: true });
      for (const target of CONVERT_TARGETS) {
        convertItems.push({
          label: CONVERT_TARGET_LABELS[target],
          run: () => void runHost.convertDirect(target),
        });
      }
    }
    top.push({ label: "格式转换", submenu: convertItems });
  }

  // 文本转换（子菜单，需选中文本）
  if (!readonly && hasSelection) {
    top.push({
      label: "文本转换",
      submenu: (Object.keys(CASE_LABELS) as CaseMode[]).map((mode) => ({
        label: CASE_LABELS[mode],
        run: () => runHost.runCase(mode),
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
      insert.push({ label: "剪贴板图片", run: () => void fileService.insertClipboardImage() });
    }
    top.push({ label: "插入", submenu: insert });
  }

  // 比较：仅有未保存改动时提供
  if (tab?.path && tab.dirty && !tab.virtual) {
    top.push({ separator: true });
    top.push({ label: "与磁盘内容比较（未保存改动）", run: () => void diffService.diffUnsaved() });
  }
  return top;
}

// ---- 外部修改检测（Rust 侧监听，前端仅提示、不自动重载）：见 app/sessionHost.ts ----

// ---- 双栏分割线拖动 / 侧栏宽度：见 app/layout.ts ----

// ---- 文件操作（打开/保存/另存/插入图片/配置）：见 app/fileService.ts ----

// ---- 格式化（双通道 + 大文件确认 + 选中级）----

/** 超过此行数，格式化前弹确认 */
const FORMAT_CONFIRM_LINES = 10000;

/** 格式化进行中标志：防止连按快捷键启动两个格式化器互相覆盖 */
let formatting = false;

async function formatCurrent(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  if (blockIfReadonly()) return;
  if (formatting) {
    statusBar.showMessage("正在格式化，请稍候…");
    return;
  }
  const key = effectiveLanguage(tab);
  if (editorHandle.view.state.doc.lines > FORMAT_CONFIRM_LINES) {
    const ok = await confirmAction(
      `文档超过 ${FORMAT_CONFIRM_LINES} 行，格式化可能耗时较久，继续？`,
    );
    if (!ok) return;
  }
  formatting = true;
  try {
    const result = await formatDocument(editorHandle.view, key, tab.path);
    // await 期间可能切换了标签：结果已由 format.ts 做文档指纹校验，
    // 这里仅跳过过期标签上的消息刷新
    if (tabStore.active()?.id !== tab.id) return;
    if (!result.ok) {
      // 不走 window.alert（依赖 dialog 权限且打断流程）：状态栏显示首行
      // （首行已含安装命令，见 format.ts 的 withInstallHint）+ 控制台完整输出；
      // 错误停留 8s，留出阅读与照做的时间
      statusBar.showMessage(result.message.split("\n")[0] || "格式化失败", 8000);
      console.error("[format]", result.message);
      return;
    }
    statusBar.showMessage(result.message);
    statusBar.refresh();
  } finally {
    formatting = false;
  }
}

async function formatSelectionCurrent(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  if (blockIfReadonly()) return;
  if (formatting) {
    statusBar.showMessage("正在格式化，请稍候…");
    return;
  }
  const key = effectiveLanguage(tab);
  formatting = true;
  try {
    const result = await formatSelection(editorHandle.view, key, tab.path);
    if (tabStore.active()?.id !== tab.id) return;
    if (!result.ok) {
      statusBar.showMessage(result.message.split("\n")[0] || "格式化失败", 8000);
      console.error("[format]", result.message);
      return;
    }
    statusBar.showMessage(result.message);
    statusBar.refresh();
  } finally {
    formatting = false;
  }
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
registerCommands([
  // ---- 文件 ----
  { id: "file.open", title: "打开文件…", section: "文件", defaultKey: "Mod-O", menu: "file", menuOrder: 20, run: () => void fileService.openFileDialog() },
  { id: "file.new", title: "新建未命名文档", section: "文件", defaultKey: "Mod-N", menu: "file", menuLabel: "新建", menuOrder: 10, run: () => fileService.newUntitled() },
  { id: "file.save", title: "保存", section: "文件", defaultKey: "Mod-S", menu: "file", menuOrder: 50, menuSeparatorBefore: true, run: () => void fileService.saveFile() },
  { id: "file.saveAs", title: "另存为…", section: "文件", defaultKey: "Mod-Shift-S", menu: "file", menuOrder: 60, run: () => void fileService.saveFileAs() },
  { id: "file.saveAll", title: "全部保存", section: "文件", defaultKey: "Mod-Alt-S", menu: "file", menuLabel: "全部保存", menuOrder: 55, run: () => void saveAllFiles() },
  { id: "file.reload", title: "重新载入当前文件（丢弃未保存修改）", section: "文件", menu: "file", menuLabel: "重新载入当前文件", menuOrder: 65, run: () => void reloadCurrentFile() },
  { id: "file.reopenClosed", title: "重新打开关闭的标签", section: "文件", defaultKey: "Mod-Shift-T", menu: "file", menuLabel: "重新打开关闭的标签", menuOrder: 75, run: () => void reopenClosedTab() },
  { id: "file.closeTab", title: "关闭当前标签", section: "文件", defaultKey: "Mod-W", menu: "file", menuLabel: "关闭标签", menuOrder: 70, menuSeparatorBefore: true, run: () => {
      const tab = activeTab();
      if (tab) void closeTab(tab.id);
    } },
  { id: "file.quit", title: "退出", section: "文件", defaultKey: "Mod-Q", menu: "file", menuOrder: 80, hidden: true, run: () => windowChrome.close() },
  { id: "file.recent", title: "最近打开的文件…", section: "文件", menu: "file", menuLabel: "最近打开…", menuOrder: 40, run: () => runHost.toggleRecentFiles() },
  { id: "fetch.open", title: "从网址抓取网页…", section: "文件", defaultKey: "Mod-Shift-U", menu: "file", menuLabel: "从网址抓取网页…", menuOrder: 45, run: () => fetchHost.open() },
  { id: "file.saveAsEncoding", title: "另存为指定编码…", section: "文件", run: () => fileService.saveAsWithEncoding() },
  { id: "file.exportMarkdown", title: "导出 Markdown（当前 HTML 文件）", section: "文件", run: () => {
      const tab = activeTab();
      if (!tab || pathKindOf(tab.path) !== "html") {
        statusBar.showMessage("当前文件不是 HTML，无法导出 Markdown");
        return;
      }
      void preview.export(tab, "md");
    } },
  { id: "workspace.openDir", title: "打开目录（工作区）", section: "工作区", menu: "file", menuLabel: "打开目录（工作区）…", menuOrder: 30, run: () => void openWorkspaceDir() },
  // ---- 比较 ----
  { id: "diff.unsaved", title: "比较：与磁盘内容（未保存改动）", section: "比较", menu: "compare", menuLabel: "与磁盘内容比较（未保存改动）", menuOrder: 10, run: () => void diffService.diffUnsaved() },
  { id: "diff.pickFile", title: "比较：与文件…", section: "比较", menu: "compare", menuLabel: "与文件…比较", menuOrder: 20, run: () => void diffService.compareWithPickedFile() },
  { id: "diff.gitHead", title: "比较：与 Git HEAD", section: "比较", menu: "compare", menuLabel: "与 Git HEAD 比较", menuOrder: 30, menuSeparatorBefore: true, run: () => void diffService.diffWithGit("worktree") },
  { id: "diff.gitIndex", title: "比较：与 Git 暂存区", section: "比较", menu: "compare", menuLabel: "与 Git 暂存区比较", menuOrder: 40, run: () => void diffService.diffWithGit("index") },
  // ---- 设置 ----
  { id: "settings.open", title: "打开设置…", section: "设置", defaultKey: "Mod-,", menu: "settings", menuLabel: "设置中心…", menuOrder: 10, run: () => openSettings() },
  { id: "settings.openKeybindings", title: "设置：快捷键", section: "设置", run: () => openSettings("keybindings") },
  { id: "settings.openLayout", title: "设置：页面布局", section: "设置", run: () => openSettings("layout") },
  { id: "config.openFile", title: "打开配置文件（config.json）", section: "设置", menu: "settings", menuOrder: 30, run: () => void fileService.openConfigFile() },
  { id: "config.reload", title: "重新加载配置（config.json）", section: "设置", menu: "settings", menuLabel: "重新加载配置", menuOrder: 40, run: () => void fileService.reloadConfig() },
  { id: "help.settings", title: "配置说明（字段含义与生效方式）", section: "设置", menu: "settings", menuLabel: "配置说明", menuOrder: 20, menuSeparatorBefore: true, run: () => showSettingsHelp() },
  // ---- 编辑 ----
  { id: "edit.format", title: "格式化文档（Shift+Alt+F）", section: "编辑", defaultKey: "Shift-Alt-F", altKeys: ["Mod-Shift-L"], menu: "edit", menuLabel: "格式化文档", menuOrder: 90, menuSeparatorBefore: true, run: () => void formatCurrent() },
  { id: "edit.formatSelection", title: "格式化选中内容", section: "编辑", menu: "edit", menuOrder: 100, run: () => void formatSelectionCurrent() },
  { id: "edit.columnEditor", title: "列编辑器（Alt+C）", section: "编辑", defaultKey: "Alt-C", fixed: true, menu: "edit", menuLabel: "列编辑器", menuOrder: 110, run: () => { if (!blockIfReadonly()) openColumnEditor(editorHandle.view); } },
  { id: "edit.toggleWhitespace", title: "切换空白字符显示", section: "编辑", defaultKey: "", run: () => statusBar.toggleWhitespace() },
  // ---- 查找 ----
  { id: "search.results", title: "查找结果面板", section: "查找", defaultKey: "", menu: "edit", menuOrder: 80, run: () => toggleResultsPanel() },
  // ---- 工具 ----
  { id: "tools.cron", title: "Cron 表达式解析 / 生成", section: "工具", menu: "tools", menuLabel: "Cron 解析 / 生成…", menuOrder: 10, run: () => runHost.toggleCron() },
  { id: "tools.batchEncoding", title: "批量另存为编码…", section: "工具", menu: "tools", menuLabel: "批量另存为编码…", menuOrder: 30, run: () => runHost.toggleBatchEncoding() },
  { id: "tools.regex", title: "正则测试器", section: "工具", menu: "tools", menuLabel: "正则测试器…", menuOrder: 20, run: () => runHost.toggleRegexTester() },
  // 格式转换（面板 + 高频单步直转）
  { id: "convert.open", title: "格式转换…（面板）", section: "工具", menu: "tools", menuLabel: "格式转换…", menuOrder: 40, menuSeparatorBefore: true, run: () => runHost.openConvertPanel() },
  { id: "convert.json2yaml", title: "转换：JSON → YAML", section: "转换", run: () => void runHost.convertDirect("json2yaml") },
  { id: "convert.yaml2json", title: "转换：YAML → JSON", section: "转换", run: () => void runHost.convertDirect("yaml2json") },
  { id: "convert.properties2yaml", title: "转换：Properties → YAML", section: "转换", run: () => void runHost.convertDirect("properties2yaml") },
  { id: "convert.yaml2properties", title: "转换：YAML → Properties", section: "转换", run: () => void runHost.convertDirect("yaml2properties") },
  { id: "convert.json2java", title: "转换：JSON → Java 代码", section: "转换", run: () => void runHost.convertDirect("json2java") },
  { id: "convert.java2json", title: "转换：Java → JSON", section: "转换", run: () => void runHost.convertDirect("java2json") },
  // 文本变换（作用于选区）
  ...(Object.keys(CASE_LABELS) as CaseMode[]).map((mode) => ({
    id: `text.case.${mode}`,
    title: `转换大小写：${CASE_LABELS[mode]}`,
    section: "文本",
    run: () => runHost.runCase(mode),
  })),
  { id: "text.json.pretty", title: "JSON 美化", section: "文本", run: () => runHost.runJson(false) },
  { id: "text.json.minify", title: "JSON 压缩", section: "文本", run: () => runHost.runJson(true) },
  // Markdown 增强（作用于选区；表格为对话框）
  { id: "md.bold", title: "Markdown：加粗（包裹 ** **）", section: "Markdown", run: () => runHost.runWrap("**", "加粗：") },
  { id: "md.italic", title: "Markdown：斜体（包裹 * *）", section: "Markdown", run: () => runHost.runWrap("*", "斜体：") },
  { id: "md.highlight", title: "Markdown：高亮（包裹 == ==）", section: "Markdown", run: () => runHost.runWrap("==", "高亮：") },
  { id: "md.table", title: "Markdown：插入表格…", section: "Markdown", run: () => runHost.toggleTableDialog() },
  // ---- 插入 ----
  { id: "insert.clipboardImage", title: "插入剪贴板图片（存为 .assets 并插入引用）", section: "插入", run: () => void fileService.insertClipboardImage() },
  { id: "insert.localTime", title: "插入本地时间（YYYY-MM-DD HH:mm:ss）", section: "插入", run: () => insertAtCursor(localStamps().local) },
  { id: "insert.isoTime", title: "插入 ISO 时间戳", section: "插入", run: () => insertAtCursor(localStamps().iso) },
  { id: "insert.unixTime", title: "插入 Unix 时间戳", section: "插入", run: () => insertAtCursor(localStamps().unix) },
  { id: "insert.date", title: "插入日期（YYYY-MM-DD）", section: "插入", run: () => insertAtCursor(localStamps().date) },
  { id: "insert.time", title: "插入时间（HH:mm:ss）", section: "插入", run: () => insertAtCursor(localStamps().time) },
  { id: "insert.uuid", title: "插入 UUID（v4）", section: "插入", run: () => insertAtCursor(newUuid()) },
  // ---- 编码 / 运行 ----
  { id: "encoding.detectMojibake", title: "检测乱码并建议编码", section: "编码", menu: "tools", menuLabel: "检测乱码并建议编码", menuOrder: 50, menuSeparatorBefore: true, run: () => detectMojibakeManually() },
  { id: "code.run", title: "运行当前文件（Code Run）", section: "运行", defaultKey: "F5", run: () => runHost.runCurrentFile() },
  { id: "run.curlScript", title: "执行 cURL 脚本（选区/整篇，无需保存）", section: "运行", run: () => runHost.runCurlScript() },
  { id: "terminal.toggle", title: "切换终端（Ctrl+`）", section: "终端", defaultKey: "Mod-`", run: () => void terminalHost.toggle() },
  { id: "code.runInTerminal", title: "在终端运行当前文件（Ctrl+F5）", section: "运行", defaultKey: "Mod-F5", run: () => runHost.runInTerminal() },
  { id: "code.runCurlInTerminal", title: "在终端执行 cURL 脚本", section: "运行", run: () => runHost.runCurlInTerminal() },
  { id: "output.show", title: "显示运行输出面板", section: "运行", menu: "tools", menuLabel: "显示运行输出面板", menuOrder: 60, menuSeparatorBefore: true, run: () => {
      terminalHost.hide();
      runHost.showOutputPanel();
    } },
  { id: "code.stop", title: "停止运行", section: "运行", run: () => runHost.stop() },
  { id: "search.toggleBookmark", title: "切换书签（Ctrl+F2）", section: "查找", defaultKey: "Mod-F2", fixed: true, run: () => toggleBookmark(editorHandle.view) },
  { id: "search.nextBookmark", title: "下一个书签（F2）", section: "查找", defaultKey: "F2", fixed: true, menu: "go", menuLabel: "下一个书签", menuOrder: 10, run: () => gotoBookmark(editorHandle.view, 1) },
  { id: "search.prevBookmark", title: "上一个书签（Shift+F2）", section: "查找", defaultKey: "Shift-F2", fixed: true, menu: "go", menuLabel: "上一个书签", menuOrder: 20, hidden: true, run: () => gotoBookmark(editorHandle.view, -1) },
  // ---- 查找 / 替换（CM6 面板；仅菜单与快捷键，不进命令面板）----
  { id: "search.find", title: "查找（当前文档）", section: "查找", defaultKey: "Mod-F", menu: "edit", menuLabel: "查找…", menuOrder: 60, menuSeparatorBefore: true, hidden: true, run: () => {
      // 只读文档的编辑器 DOM 不可聚焦，CM6 自身键位收不到按键，故全局兜底放行
      if (activeTab()?.kind !== "text") return;
      openSearchPanel(editorHandle.view);
    } },
  { id: "search.replace", title: "替换（当前文档）", section: "查找", defaultKey: "Mod-H", menu: "edit", menuLabel: "替换…", menuOrder: 70, hidden: true, run: () => {
      const tab = activeTab();
      if (tab?.kind !== "text") return;
      openSearchPanel(editorHandle.view);
      // 面板内替换框（只读文档不渲染替换框，退化为仅查找）
      editorHandle.view.dom.querySelector<HTMLInputElement>('input[name="replace"]')?.focus();
    } },
  // ---- 视图 ----
  { id: "view.commandPalette", title: "命令面板", section: "视图", defaultKey: "Mod-Shift-P", menu: "edit", menuOrder: 120, menuSeparatorBefore: true, hidden: true, run: () => palette.toggle() },
  { id: "view.toggleSidebar", title: "切换侧栏", section: "视图", defaultKey: "Mod-B", hidden: true, run: () => layout.toggleSidebar() },
  { id: "view.prevTab", title: "上一个标签", section: "视图", defaultKey: "Mod-PageUp", hidden: true, run: () => tabSwitcher.switchTab(-1) },
  { id: "view.nextTab", title: "下一个标签", section: "视图", defaultKey: "Mod-PageDown", hidden: true, run: () => tabSwitcher.switchTab(1) },
  // ---- 纯菜单项（系统/CM6 内置行为，仅展示）----
  { id: "edit.undo", title: "撤销", section: "编辑", defaultKey: "Mod-Z", fixed: true, menu: "edit", menuOrder: 10, hidden: true, run: () => void undo(editorHandle.view) },
  { id: "edit.redo", title: "重做", section: "编辑", defaultKey: "Mod-Shift-Z", fixed: true, menu: "edit", menuOrder: 20, hidden: true, run: () => void redo(editorHandle.view) },
  { id: "clipboard.cut", title: "剪切", section: "编辑", menu: "edit", menuLabel: "剪切", menuOrder: 30, menuShortcut: "Mod-X", menuSeparatorBefore: true, hidden: true, run: () => void copyFromEditor(editorHandle.view, true, statusBar.showMessage) },
  { id: "clipboard.copy", title: "复制", section: "编辑", menu: "edit", menuOrder: 40, menuShortcut: "Mod-C", hidden: true, run: () => void copyFromEditor(editorHandle.view, false, statusBar.showMessage) },
  { id: "clipboard.paste", title: "粘贴", section: "编辑", menu: "edit", menuOrder: 50, menuShortcut: "Mod-V", hidden: true, run: () => void pasteIntoEditor(editorHandle.view, statusBar.showMessage) },
  { id: "select.all", title: "全选", section: "选择", menu: "select", menuOrder: 10, menuShortcut: "Mod-A", hidden: true, run: () => {
      const len = editorHandle.view.state.doc.length;
      editorHandle.view.dispatch({ selection: { anchor: 0, head: len } });
    } },
  // ---- 以下为编辑器内置（CM6）绑定，仅展示不可重绑 ----
  { id: "edit.comment", title: "切换注释", section: "编辑", defaultKey: "Mod-/", fixed: true, hidden: true, run: () => {} },
  { id: "edit.deleteLine", title: "删除当前行", section: "编辑", defaultKey: "Mod-D", fixed: true, hidden: true, run: () => {} },
  { id: "edit.copyLineUp", title: "复制行到上方", section: "编辑", defaultKey: "Mod-Alt-Up", fixed: true, hidden: true, run: () => {} },
  { id: "edit.copyLineDown", title: "复制行到下方", section: "编辑", defaultKey: "Mod-Alt-Down", fixed: true, hidden: true, run: () => {} },
  { id: "edit.moveLineUp", title: "上移当前行", section: "编辑", defaultKey: "Alt-Up", fixed: true, hidden: true, run: () => {} },
  { id: "edit.moveLineDown", title: "下移当前行", section: "编辑", defaultKey: "Alt-Down", fixed: true, hidden: true, run: () => {} },
]);

// 命令面板与菜单栏由同一注册表派生，快捷键展示也走同一解析
function shortcutText(cmd: CommandDef): string {
  const raw =
    cmd.menuShortcut ??
    (cmd.defaultKey !== undefined ? resolveKey(cmd, getConfig()) : "");
  return raw ? formatKey(raw) : "";
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
    // 模态 / 面板打开期间不派发全局命令（仅放行 Esc 由各面板自行处理）
    if (isModalOpen()) return;
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
  layout.applyConfiguredSidebar();
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
