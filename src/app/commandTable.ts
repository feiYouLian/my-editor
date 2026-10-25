/**
 * 命令注册表数据（从 main.ts 迁出）。
 *
 * 单一来源：菜单栏 / 命令面板 / 快捷键 / 设置键位页全部由本表派生。
 * 字段语义见 core/commands.ts：menu* 控制菜单栏，defaultKey 控制快捷键，
 * hidden 控制是否进命令面板，menuOrder 控制菜单内顺序。
 *
 * 运行期依赖（宿主能力）经 ctx 注入；tab / view 用 getter，
 * 保证单编辑器实例下始终取到当前标签与当前视图。
 */

import type { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { CommandDef } from "../core/commands";
import { localStamps, newUuid } from "../core/stamps";
import { CASE_LABELS, type CaseMode } from "../editor/transforms";
import { openColumnEditor } from "../editor/columnEditor";
import { gotoBookmark, toggleBookmark } from "../editor/bookmarks";
import { copyFromEditor, pasteIntoEditor } from "../editor/clipboard";
import { pathKindOf } from "../panels/preview";
import { showSettingsHelp } from "../ui/settingsHelp";
import type { Tab } from "../store/tabs";
import type { FileService } from "./fileService";
import type { DiffService } from "./diffService";
import type { RunHost } from "./runHost";
import type { FormatHost } from "./formatHost";
import type { StatusActions } from "./statusActions";

export interface CommandTableCtx {
  fileService: FileService;
  quickOpen: { open(): void };
  fetchHost: { open(): void };
  preview: { export(tab: Tab, format: "html" | "word" | "pdf" | "md"): Promise<void> };
  diffService: DiffService;
  runHost: RunHost;
  terminalHost: { toggle(): Promise<void>; hide(): void };
  windowChrome: { close(): void };
  layout: { toggleSidebar(): void };
  palette: { toggle(): void };
  tabSwitcher: { switchTab(delta: number): void };
  formatHost: FormatHost;
  statusActions: StatusActions;
  statusBar: { showMessage(text: string): void; toggleWhitespace(): void };
  getActiveTab: () => Tab | null;
  getView: () => EditorView;
  openSettings: (category?: "theme" | "keybindings" | "layout") => void;
  openWorkspaceDir: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  reloadCurrentFile: () => Promise<void>;
  reopenClosedTab: () => Promise<void>;
  blockIfReadonly: () => boolean;
  insertAtCursor: (text: string) => void;
  toggleResultsPanel: () => void;
  focusWorkspaceSearch: () => void;
  showSidebarView: (view: "open" | "git" | "files" | "search" | "outline") => void;
  /** Git：分支切换面板 / 拉取 / 推送（状态栏入口之外的可命令化入口） */
  gitPickBranch: () => void;
  gitPull: () => void;
  gitPush: () => void;
  /** 快捷键速查 / 关于（依赖 main.ts 的键位解析，保持注入） */
  showShortcuts: () => void;
  showAbout: () => void;
}

export function buildCommandTable(ctx: CommandTableCtx): CommandDef[] {
  const {
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
    getActiveTab,
    getView,
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
    gitPickBranch,
    gitPull,
    gitPush,
    showShortcuts,
    showAbout,
  } = ctx;
  const { showMessage, toggleWhitespace } = ctx.statusBar;

  return [
    // ---- 文件 ----
    { id: "file.open", title: "打开文件…", section: "文件", defaultKey: "Mod-O", menu: "file", menuOrder: 20, run: () => void fileService.openFileDialog() },
    { id: "file.quickOpen", title: "快速打开文件…", section: "文件", defaultKey: "Mod-P", menu: "file", menuLabel: "快速打开文件…", menuOrder: 25, run: () => quickOpen.open() },
    { id: "file.new", title: "新建未命名文档", section: "文件", defaultKey: "Mod-N", menu: "file", menuLabel: "新建", menuOrder: 10, run: () => fileService.newUntitled() },
    { id: "file.save", title: "保存", section: "文件", defaultKey: "Mod-S", menu: "file", menuOrder: 50, menuSeparatorBefore: true, run: () => void fileService.saveFile() },
    { id: "file.saveAs", title: "另存为…", section: "文件", defaultKey: "Mod-Shift-S", menu: "file", menuOrder: 60, run: () => void fileService.saveFileAs() },
    { id: "file.saveAll", title: "全部保存", section: "文件", defaultKey: "Mod-Alt-S", menu: "file", menuLabel: "全部保存", menuOrder: 55, run: () => void saveAllFiles() },
    { id: "file.reload", title: "重新载入当前文件（丢弃未保存修改）", section: "文件", menu: "file", menuLabel: "重新载入当前文件", menuOrder: 65, run: () => void reloadCurrentFile() },
    { id: "file.reopenClosed", title: "重新打开关闭的标签", section: "文件", defaultKey: "Mod-Shift-T", menu: "file", menuLabel: "重新打开关闭的标签", menuOrder: 75, run: () => void reopenClosedTab() },
    { id: "file.closeTab", title: "关闭当前标签", section: "文件", defaultKey: "Mod-W", menu: "file", menuLabel: "关闭标签", menuOrder: 70, menuSeparatorBefore: true, run: () => {
        const tab = getActiveTab();
        if (tab) void closeTab(tab.id);
      } },
    { id: "file.quit", title: "退出", section: "文件", defaultKey: "Mod-Q", menu: "file", menuOrder: 80, hidden: true, run: () => windowChrome.close() },
    { id: "file.recent", title: "最近打开的文件…", section: "文件", menu: "file", menuLabel: "最近打开…", menuOrder: 40, run: () => runHost.toggleRecentFiles() },
    { id: "fetch.open", title: "从网址抓取网页…", section: "文件", defaultKey: "Mod-Shift-U", menu: "file", menuLabel: "从网址抓取网页…", menuOrder: 45, run: () => fetchHost.open() },
    { id: "file.saveAsEncoding", title: "另存为指定编码…", section: "文件", run: () => fileService.saveAsWithEncoding() },
    { id: "file.exportMarkdown", title: "导出 Markdown（当前 HTML 文件）", section: "文件", run: () => {
        const tab = getActiveTab();
        if (!tab || pathKindOf(tab.path) !== "html") {
          showMessage("当前文件不是 HTML，无法导出 Markdown");
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
    { id: "edit.format", title: "格式化文档（Shift+Alt+F）", section: "编辑", defaultKey: "Shift-Alt-F", altKeys: ["Mod-Shift-L"], menu: "edit", menuLabel: "格式化文档", menuOrder: 90, menuSeparatorBefore: true, run: () => void formatHost.formatCurrent() },
    { id: "edit.formatSelection", title: "格式化选中内容", section: "编辑", menu: "edit", menuOrder: 100, run: () => void formatHost.formatSelectionCurrent() },
    { id: "edit.columnEditor", title: "列编辑器（Alt+C）", section: "编辑", defaultKey: "Alt-C", fixed: true, menu: "edit", menuLabel: "列编辑器", menuOrder: 110, run: () => { if (!blockIfReadonly()) openColumnEditor(getView()); } },
    { id: "edit.toggleWhitespace", title: "切换空白字符显示", section: "编辑", defaultKey: "", run: () => toggleWhitespace() },
    // ---- 查找 ----
    { id: "search.results", title: "查找结果面板", section: "查找", defaultKey: "", menu: "edit", menuOrder: 80, run: () => toggleResultsPanel() },
    { id: "search.workspace", title: "在文件中查找…（工作区）", section: "查找", defaultKey: "Mod-Shift-F", menu: "edit", menuLabel: "在文件中查找…", menuOrder: 85, run: () => focusWorkspaceSearch() },
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
    { id: "encoding.detectMojibake", title: "检测乱码并建议编码", section: "编码", menu: "tools", menuLabel: "检测乱码并建议编码", menuOrder: 50, menuSeparatorBefore: true, run: () => statusActions.detectMojibakeManually() },
    { id: "code.run", title: "运行当前文件（Code Run）", section: "运行", defaultKey: "F5", run: () => runHost.runCurrentFile() },
    { id: "run.curlScript", title: "执行 cURL 脚本（选区/整篇，无需保存）", section: "运行", run: () => runHost.runCurlScript() },
    { id: "terminal.toggle", title: "切换终端（Ctrl+`）", section: "终端", defaultKey: "Mod-`", menu: "view", menuLabel: "切换终端", menuOrder: 20, run: () => void terminalHost.toggle() },
    { id: "code.runInTerminal", title: "在终端运行当前文件（Ctrl+F5）", section: "运行", defaultKey: "Mod-F5", run: () => runHost.runInTerminal() },
    { id: "code.runCurlInTerminal", title: "在终端执行 cURL 脚本", section: "运行", run: () => runHost.runCurlInTerminal() },
    { id: "output.show", title: "显示运行输出面板", section: "运行", menu: "view", menuLabel: "显示运行输出面板", menuOrder: 30, menuSeparatorBefore: true, run: () => {
        terminalHost.hide();
        runHost.showOutputPanel();
      } },
    { id: "code.stop", title: "停止运行", section: "运行", run: () => runHost.stop() },
    { id: "search.toggleBookmark", title: "切换书签（Ctrl+F2）", section: "查找", defaultKey: "Mod-F2", fixed: true, run: () => toggleBookmark(getView()) },
    { id: "search.nextBookmark", title: "下一个书签（F2）", section: "查找", defaultKey: "F2", fixed: true, menu: "go", menuLabel: "下一个书签", menuOrder: 10, run: () => gotoBookmark(getView(), 1) },
    { id: "search.prevBookmark", title: "上一个书签（Shift+F2）", section: "查找", defaultKey: "Shift-F2", fixed: true, menu: "go", menuLabel: "上一个书签", menuOrder: 20, hidden: true, run: () => gotoBookmark(getView(), -1) },
    // ---- 查找 / 替换（CM6 面板；仅菜单与快捷键，不进命令面板）----
    { id: "search.find", title: "查找（当前文档）", section: "查找", defaultKey: "Mod-F", menu: "edit", menuLabel: "查找…", menuOrder: 60, menuSeparatorBefore: true, hidden: true, run: () => {
        // 只读文档的编辑器 DOM 不可聚焦，CM6 自身键位收不到按键，故全局兜底放行
        if (getActiveTab()?.kind !== "text") return;
        openSearchPanel(getView());
      } },
    { id: "search.replace", title: "替换（当前文档）", section: "查找", defaultKey: "Mod-H", menu: "edit", menuLabel: "替换…", menuOrder: 70, hidden: true, run: () => {
        const tab = getActiveTab();
        if (tab?.kind !== "text") return;
        const view = getView();
        openSearchPanel(view);
        // 面板内替换框（只读文档不渲染替换框，退化为仅查找）
        view.dom.querySelector<HTMLInputElement>('input[name="replace"]')?.focus();
      } },
    // ---- 视图 ----
    { id: "view.commandPalette", title: "命令面板", section: "视图", defaultKey: "Mod-Shift-P", menu: "edit", menuOrder: 120, menuSeparatorBefore: true, hidden: true, run: () => palette.toggle() },
    { id: "view.toggleSidebar", title: "切换侧栏", section: "视图", defaultKey: "Mod-B", menu: "view", menuLabel: "切换侧栏", menuOrder: 10, hidden: true, run: () => layout.toggleSidebar() },
    { id: "view.prevTab", title: "上一个标签", section: "视图", defaultKey: "Mod-PageUp", hidden: true, run: () => tabSwitcher.switchTab(-1) },
    { id: "view.nextTab", title: "下一个标签", section: "视图", defaultKey: "Mod-PageDown", hidden: true, run: () => tabSwitcher.switchTab(1) },
    { id: "view.sidebarOpen", title: "侧栏：打开的文件", section: "视图", menu: "view", menuLabel: "侧栏：打开的文件", menuOrder: 35, menuSeparatorBefore: true, run: () => showSidebarView("open") },
    { id: "view.sidebarGit", title: "侧栏：源代码管理", section: "视图", menu: "view", menuLabel: "侧栏：源代码管理", menuOrder: 38, run: () => showSidebarView("git") },
    { id: "view.sidebarFiles", title: "侧栏：文件", section: "视图", menu: "view", menuLabel: "侧栏：文件", menuOrder: 40, run: () => showSidebarView("files") },
    { id: "view.sidebarSearch", title: "侧栏：搜索", section: "视图", menu: "view", menuLabel: "侧栏：搜索", menuOrder: 50, run: () => showSidebarView("search") },
    { id: "view.sidebarOutline", title: "侧栏：大纲", section: "视图", menu: "view", menuLabel: "侧栏：大纲", menuOrder: 60, run: () => showSidebarView("outline") },
    // ---- Git ----
    { id: "git.pickBranch", title: "切换分支…", section: "Git", menu: "view", menuLabel: "切换 Git 分支…", menuOrder: 70, run: () => gitPickBranch() },
    { id: "git.pull", title: "拉取（快进合并）", section: "Git", menu: "view", menuLabel: "拉取", menuOrder: 72, run: () => gitPull() },
    { id: "git.push", title: "推送", section: "Git", menu: "view", menuLabel: "推送", menuOrder: 74, run: () => gitPush() },
    { id: "help.shortcuts", title: "快捷键速查", section: "设置", menu: "settings", menuLabel: "快捷键速查…", menuOrder: 85, run: () => showShortcuts() },
    { id: "help.about", title: "关于 my-editor", section: "设置", menu: "settings", menuLabel: "关于…", menuOrder: 90, run: () => showAbout() },
    // ---- 纯菜单项（系统/CM6 内置行为，仅展示）----
    { id: "edit.undo", title: "撤销", section: "编辑", defaultKey: "Mod-Z", fixed: true, menu: "edit", menuOrder: 10, hidden: true, run: () => void undo(getView()) },
    { id: "edit.redo", title: "重做", section: "编辑", defaultKey: "Mod-Shift-Z", fixed: true, menu: "edit", menuOrder: 20, hidden: true, run: () => void redo(getView()) },
    { id: "clipboard.cut", title: "剪切", section: "编辑", menu: "edit", menuLabel: "剪切", menuOrder: 30, menuShortcut: "Mod-X", menuSeparatorBefore: true, hidden: true, run: () => void copyFromEditor(getView(), true, showMessage) },
    { id: "clipboard.copy", title: "复制", section: "编辑", menu: "edit", menuOrder: 40, menuShortcut: "Mod-C", hidden: true, run: () => void copyFromEditor(getView(), false, showMessage) },
    { id: "clipboard.paste", title: "粘贴", section: "编辑", menu: "edit", menuOrder: 50, menuShortcut: "Mod-V", hidden: true, run: () => void pasteIntoEditor(getView(), showMessage) },
    { id: "select.all", title: "全选", section: "选择", menu: "select", menuOrder: 10, menuShortcut: "Mod-A", hidden: true, run: () => {
        const view = getView();
        const len = view.state.doc.length;
        view.dispatch({ selection: { anchor: 0, head: len } });
      } },
    // ---- 以下为编辑器内置（CM6）绑定，仅展示不可重绑 ----
    { id: "edit.comment", title: "切换注释", section: "编辑", defaultKey: "Mod-/", fixed: true, hidden: true, run: () => {} },
    { id: "edit.deleteLine", title: "删除当前行", section: "编辑", defaultKey: "Mod-D", fixed: true, hidden: true, run: () => {} },
    { id: "edit.copyLineUp", title: "复制行到上方", section: "编辑", defaultKey: "Mod-Alt-Up", fixed: true, hidden: true, run: () => {} },
    { id: "edit.copyLineDown", title: "复制行到下方", section: "编辑", defaultKey: "Mod-Alt-Down", fixed: true, hidden: true, run: () => {} },
    { id: "edit.moveLineUp", title: "上移当前行", section: "编辑", defaultKey: "Alt-Up", fixed: true, hidden: true, run: () => {} },
    { id: "edit.moveLineDown", title: "下移当前行", section: "编辑", defaultKey: "Alt-Down", fixed: true, hidden: true, run: () => {} },
  ];
}
