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
import {
  openSearchPanel,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { foldAll, unfoldAll } from "@codemirror/language";
import type { CommandDef } from "../core/commands";
import { localStamps, newUuid } from "../core/stamps";
import { exportDiagnostics, openLogsDir } from "../services/diagnostics";
import { checkForUpdates } from "../services/updater";
import { CASE_LABELS, type CaseMode } from "../editor/transforms";
import { applyLineOp, type LineOp } from "../editor/lineOps";
import { textStats } from "../core/textOps";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tabStore } from "../store/tabs";
import { openColumnEditor } from "../editor/columnEditor";
import { gotoBookmark, toggleBookmark } from "../editor/bookmarks";
import { copyFromEditor, pasteIntoEditor } from "../editor/clipboard";
import { pathKindOf } from "../panels/preview";
import { showHelpDialog } from "../panels/helpDialog";
import { getConfig, updateSettings } from "../config/settings";
import { showSettingsHelp } from "../ui/settingsHelp";
import type { Tab } from "../store/tabs";
import type { FileService } from "./fileService";
import type { DiffService } from "./diffService";
import type { RunHost } from "./runHost";
import type { FormatHost } from "./formatHost";
import type { StatusActions } from "./statusActions";
import type { SymbolHost } from "./symbolHost";
import { firstLine } from "../core/errors";

export interface CommandTableCtx {
  fileService: FileService;
  quickOpen: { open(): void };
  fetchHost: { open(): void };
  preview: {
    export(tab: Tab, format: "html" | "word" | "pdf" | "md"): Promise<void>;
    /** 纯预览模式下接管 Ctrl+F：在渲染结果里查找（返回 false 表示未接管） */
    openFind(): boolean;
  };
  diffService: DiffService;
  runHost: RunHost;
  terminalHost: { toggle(): Promise<void>; hide(): void; readonly isOpen: boolean };
  windowChrome: { close(): void };
  layout: { toggleSidebar(): void; readonly isSidebarVisible: boolean };
  palette: { toggle(): void };
  tabSwitcher: { switchTab(delta: number): void };
  formatHost: FormatHost;
  statusActions: StatusActions;
  symbolHost: SymbolHost;
  statusBar: { showMessage(text: string): void; toggleWhitespace(): void };
  getActiveTab: () => Tab | null;
  getView: () => EditorView;
  openSettings: (category?: "theme" | "keybindings" | "layout") => void;
  openWorkspaceDir: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  reloadCurrentFile: () => Promise<void>;
  /** 重新加载界面（前端整体重载；执行前会 flush 会话与草稿） */
  reloadWindow: () => Promise<void>;
  reopenClosedTab: () => Promise<void>;
  blockIfReadonly: () => boolean;
  insertAtCursor: (text: string) => void;
  toggleResultsPanel: () => void;
  focusWorkspaceSearch: () => void;
  showSidebarView: (
    view: "open" | "git" | "files" | "search" | "outline" | "bookmarks",
  ) => void;
  /** 侧栏某分区是否正在显示（勾选态；侧栏收起时为 false） */
  isSidebarViewOpen: (
    view: "open" | "git" | "files" | "search" | "outline" | "bookmarks",
  ) => boolean;
  /** 结构化只读视图（CSV 表格 / JSON 树）；不传则按扩展名猜 */
  showStructuredView: (mode?: "csv" | "json") => void;
  /** 结构化视图是否正以指定模式打开（勾选态） */
  isStructuredViewOpen: (mode: "csv" | "json") => boolean;
  /** 显示运行输出面板（先收起终端与 Git 历史，避免底部面板叠在一起） */
  showRunOutput: () => void;
  /** Git：分支切换面板 / 拉取 / 推送（状态栏入口之外的可命令化入口） */
  gitPickBranch: () => void;
  /** Git 只读开关：只查看 vs 可写（保护正在用的仓库） */
  gitToggleReadOnly: () => void;
  /** 查看提交历史（底部面板；入口在 Git 菜单与分支面板） */
  gitOpenHistory: () => void;
  gitPull: () => void;
  gitPush: () => void;
  /** 行内 Git Blame 开关（跟随光标） */
  gitToggleInlineBlame: () => void;
  gitInlineBlameEnabled: () => boolean;
  /** 逐行 Blame 对话框（命令面板入口） */
  gitOpenBlame: () => void;
  /** 快捷键速查 / 关于（依赖 main.ts 的键位解析，保持注入） */
  showShortcuts: () => void;
  showAbout: () => void;
  /** 打开「最近消息」（状态栏瞬时消息历史，由通知面板承载） */
  showMessageHistory: () => void;
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
    symbolHost,
    getActiveTab,
    getView,
    openSettings,
    openWorkspaceDir,
    closeTab,
    saveAllFiles,
    reloadCurrentFile,
    reloadWindow,
    reopenClosedTab,
    blockIfReadonly,
    insertAtCursor,
    toggleResultsPanel,
    focusWorkspaceSearch,
    showSidebarView,
    isSidebarViewOpen,
    showStructuredView,
    isStructuredViewOpen,
    showRunOutput,
    gitPickBranch,
    gitToggleReadOnly,
    gitOpenHistory,
    gitPull,
    gitPush,
    gitToggleInlineBlame,
    gitInlineBlameEnabled,
    gitOpenBlame,
    showShortcuts,
    showAbout,
    showMessageHistory,
  } = ctx;
  const { showMessage, toggleWhitespace } = ctx.statusBar;

  /** 行操作的统一入口：只读拦截 + Tab 宽度取当前配置 + 结果消息 */
  const runLineOp = (op: LineOp): void => {
    if (blockIfReadonly()) return;
    showMessage(applyLineOp(getView(), op, getConfig().tabSize).message);
  };
  /** 全屏状态缓存：isFullscreen 是异步接口，菜单勾选态需要同步取值 */
  let fullscreenOn = false;
  // 单测环境没有 window：跳过这次探测，菜单勾选态保持默认值
  if (typeof window !== "undefined") {
    void getCurrentWindow()
      .isFullscreen()
      .then((on) => {
        fullscreenOn = on;
      })
      .catch(() => {
        // 取不到就保持 false（菜单只是缺少勾选，不影响切换）
      });
  }

  return [
    // ---- 文件 ----
    { id: "file.open", title: "打开文件…", section: "文件", defaultKey: "Mod-O", menu: "file", menuOrder: 20, run: () => void fileService.openFileDialog() },
    { id: "file.quickOpen", title: "快速打开文件…", section: "文件", defaultKey: "Mod-P", menu: "file", menuLabel: "快速打开文件…", menuOrder: 25, run: () => quickOpen.open() },
    { id: "file.new", title: "新建未命名文档", section: "文件", defaultKey: "Mod-N", menu: "file", menuLabel: "新建", menuOrder: 10, run: () => fileService.newUntitled() },
    { id: "file.save", title: "保存", section: "文件", defaultKey: "Mod-S", menu: "file", menuOrder: 50, menuSeparatorBefore: true, run: () => void fileService.saveFile() },
    { id: "file.saveAs", title: "另存为…", section: "文件", defaultKey: "Mod-Shift-S", menu: "file", menuOrder: 60, run: () => void fileService.saveFileAs() },
    { id: "file.saveAll", title: "全部保存", section: "文件", defaultKey: "Mod-Alt-S", menu: "file", menuLabel: "全部保存", menuOrder: 55, run: () => void saveAllFiles() },
    { id: "file.saveAsEncoding", title: "另存为指定编码…", section: "文件", menu: "file", menuLabel: "另存为指定编码…", menuOrder: 62, run: () => fileService.saveAsWithEncoding() },
    { id: "file.reload", title: "重新载入当前文件（丢弃未保存修改）", section: "文件", defaultKey: "Mod-R", menu: "file", menuLabel: "重新载入当前文件", menuOrder: 65, run: () => void reloadCurrentFile() },
    { id: "file.reopenClosed", title: "重新打开关闭的标签", section: "文件", defaultKey: "Mod-Shift-T", menu: "file", menuLabel: "重新打开关闭的标签", menuOrder: 78, run: () => void reopenClosedTab() },
    { id: "file.closeTab", title: "关闭当前标签", section: "文件", defaultKey: "Mod-W", menu: "file", menuLabel: "关闭标签", menuOrder: 76, menuSeparatorBefore: true, run: () => {
        const tab = getActiveTab();
        if (tab) void closeTab(tab.id);
      } },
    { id: "file.quit", title: "退出", section: "文件", defaultKey: "Mod-Q", menu: "file", menuLabel: "退出", menuOrder: 80, run: () => windowChrome.close() },
    { id: "file.recent", title: "最近打开的文件…", section: "文件", menu: "file", menuLabel: "最近打开…", menuOrder: 40, run: () => runHost.toggleRecentFiles() },
    { id: "fetch.open", title: "从网址抓取网页…", section: "文件", defaultKey: "Mod-Shift-U", menu: "file", menuLabel: "从网址抓取网页…", menuOrder: 45, run: () => fetchHost.open() },
    { id: "workspace.openDir", title: "打开目录（工作区）", section: "工作区", menu: "file", menuLabel: "打开目录（工作区）…", menuOrder: 30, run: () => void openWorkspaceDir() },
    { id: "file.exportMarkdown", title: "导出 Markdown（当前 HTML 文件）", section: "文件", menu: "file", menuLabel: "导出 Markdown（当前 HTML）…", menuOrder: 74, menuSeparatorBefore: true, run: () => {
        const tab = getActiveTab();
        if (!tab || pathKindOf(tab.path) !== "html") {
          showMessage("当前文件不是 HTML，无法导出 Markdown");
          return;
        }
        void preview.export(tab, "md");
      } },
    // 文件级比较（Git 比较在「Git」菜单）：原「比较」顶级菜单撤销，按功能归位
    { id: "diff.unsaved", title: "比较：与磁盘内容（未保存改动）", section: "比较", menu: "file", menuLabel: "与磁盘内容比较（未保存改动）", menuOrder: 70, menuSeparatorBefore: true, run: () => void diffService.diffUnsaved() },
    { id: "diff.pickFile", title: "比较：与文件…", section: "比较", menu: "file", menuLabel: "与文件…比较", menuOrder: 72, run: () => void diffService.compareWithPickedFile() },
    // ---- 设置 ----
    { id: "settings.open", title: "打开设置…", section: "设置", defaultKey: "Mod-,", menu: "settings", menuLabel: "设置中心…", menuOrder: 10, run: () => openSettings() },
    { id: "settings.openKeybindings", title: "设置：快捷键", section: "设置", run: () => openSettings("keybindings") },
    { id: "settings.openLayout", title: "设置：页面布局", section: "设置", run: () => openSettings("layout") },
    { id: "help.settings", title: "配置说明（字段含义与生效方式）", section: "设置", menu: "settings", menuLabel: "配置说明", menuOrder: 20, menuSeparatorBefore: true, run: () => showSettingsHelp() },
    { id: "config.openFile", title: "打开配置文件（config.json）", section: "设置", menu: "settings", menuLabel: "打开配置文件…", menuOrder: 30, menuSeparatorBefore: true, run: () => void fileService.openConfigFile() },
    { id: "config.reload", title: "重新加载配置（config.json）", section: "设置", menu: "settings", menuLabel: "重新加载配置", menuOrder: 40, run: () => void fileService.reloadConfig() },
    // 诊断 / 更新类归「帮助」（原混在「设置」里，与配置项不是一类事）
    { id: "help.openLogs", title: "打开日志目录", section: "帮助", menu: "help", menuLabel: "打开日志目录", menuOrder: 45, run: () => {
        void openLogsDir().catch((e) => showMessage(`打开日志目录失败：${firstLine(e)}`));
      } },
    { id: "help.exportDiagnostics", title: "导出诊断包（版本 / 系统 / 日志）", section: "帮助", menu: "help", menuLabel: "导出诊断包…", menuOrder: 50, run: () => {
        void exportDiagnostics()
          .then((path) => showMessage(`诊断包已导出：${path}`))
          .catch((e) => showMessage(`导出诊断失败：${firstLine(e)}`));
      } },
    { id: "help.checkUpdates", title: "检查更新", section: "帮助", menu: "help", menuLabel: "检查更新…", menuOrder: 40, menuSeparatorBefore: true, run: () => void checkForUpdates(showMessage) },
    // ---- 编辑 ----
    { id: "edit.format", title: "格式化文档", section: "编辑", defaultKey: "Shift-Alt-F", altKeys: ["Mod-Alt-Shift-F"], menu: "edit", menuLabel: "格式化文档", menuOrder: 80, menuSeparatorBefore: true, run: () => void formatHost.formatCurrent() },
    { id: "edit.formatSelection", title: "格式化选中内容", section: "编辑", menu: "edit", menuOrder: 85, run: () => void formatHost.formatSelectionCurrent() },
    // 选中同词属于「选择」菜单（VS Code Selection 分组）：Ctrl+Alt+D / Ctrl+Alt+Shift+D（不改动 Mod-D = 删除当前行）
    { id: "edit.selectNextOccurrence", title: "选中下一个相同词", section: "选择", defaultKey: "Mod-Alt-D", menu: "select", menuOrder: 20, menuSeparatorBefore: true, run: () => { if (!blockIfReadonly()) selectNextOccurrence(getView()); } },
    { id: "edit.selectAllOccurrences", title: "选中全部相同词", section: "选择", defaultKey: "Mod-Alt-Shift-D", menu: "select", menuOrder: 30, run: () => { if (!blockIfReadonly()) selectSelectionMatches(getView()); } },
    // 折叠属于「视图」菜单（VS Code View ▸ Folding）：能力来自 foldKeymap，这里只补"可发现性"
    { id: "edit.foldAll", title: "折叠全部", section: "视图", defaultKey: "Ctrl-Alt-[", fixed: true, menu: "view", menuLabel: "折叠全部", menuOrder: 50, menuSeparatorBefore: true, hidden: true, run: () => { foldAll(getView()); } },
    { id: "edit.unfoldAll", title: "展开全部", section: "视图", defaultKey: "Ctrl-Alt-]", fixed: true, menu: "view", menuLabel: "展开全部", menuOrder: 55, hidden: true, run: () => { unfoldAll(getView()); } },
    { id: "edit.complete", title: "触发补全", section: "编辑", defaultKey: "Ctrl-Space", fixed: true, hidden: true, run: () => { /* 由 CM6 键位处理，仅用于速查展示 */ } },
    { id: "edit.columnEditor", title: "列编辑器", section: "编辑", defaultKey: "Alt-C", fixed: true, menu: "edit", menuLabel: "列编辑器", menuOrder: 90, menuSeparatorBefore: true, run: () => { if (!blockIfReadonly()) openColumnEditor(getView()); } },
    // 行操作：按行语义（有选区取整行，无选区整篇），不占用默认键位
    { id: "edit.sortLinesAsc", title: "行操作：按升序排序", section: "编辑", run: () => runLineOp({ kind: "sort", options: {} }) },
    { id: "edit.sortLinesDesc", title: "行操作：按降序排序", section: "编辑", run: () => runLineOp({ kind: "sort", options: { desc: true } }) },
    { id: "edit.sortLinesAscNumeric", title: "行操作：按数字升序排序", section: "编辑", run: () => runLineOp({ kind: "sort", options: { numeric: true } }) },
    { id: "edit.dedupeLines", title: "行操作：去除重复行", section: "编辑", run: () => runLineOp({ kind: "dedupe" }) },
    { id: "edit.reverseLines", title: "行操作：反转行序", section: "编辑", run: () => runLineOp({ kind: "reverse" }) },
    { id: "edit.removeEmptyLines", title: "行操作：删除空行", section: "编辑", run: () => runLineOp({ kind: "removeEmpty" }) },
    { id: "edit.trimTrailing", title: "行操作：删除行尾空白", section: "编辑", run: () => runLineOp({ kind: "trimTrailing" }) },
    { id: "edit.tabsToSpaces", title: "行操作：缩进 Tab 转空格", section: "编辑", run: () => runLineOp({ kind: "indent", toSpaces: true }) },
    { id: "edit.spacesToTabs", title: "行操作：缩进空格转 Tab", section: "编辑", run: () => runLineOp({ kind: "indent", toSpaces: false }) },
    { id: "edit.toggleWhitespace", title: "切换空白字符显示", section: "编辑", defaultKey: "", menu: "edit", menuLabel: "切换空白字符显示", menuOrder: 95, menuSeparatorBefore: true, run: () => toggleWhitespace() },
    // ---- 查找 ----
    { id: "search.results", title: "查找结果面板", section: "查找", defaultKey: "", menu: "edit", menuOrder: 72, run: () => toggleResultsPanel() },
    { id: "search.workspace", title: "在文件中查找…（工作区）", section: "查找", defaultKey: "Mod-Shift-F", menu: "edit", menuLabel: "在文件中查找…", menuOrder: 70, run: () => focusWorkspaceSearch() },
    // ---- 工具 ----
    { id: "tools.cron", title: "Cron 表达式解析 / 生成", section: "工具", menu: "tools", menuLabel: "Cron 解析 / 生成…", menuOrder: 10, run: () => runHost.toggleCron() },
    { id: "tools.batchEncoding", title: "批量另存为编码…", section: "工具", menu: "tools", menuLabel: "批量另存为编码…", menuOrder: 30, run: () => runHost.toggleBatchEncoding() },
    { id: "tools.regex", title: "正则测试器", section: "工具", menu: "tools", menuLabel: "正则测试器…", menuOrder: 20, run: () => runHost.toggleRegexTester() },
    // 格式转换（面板 + 高频单步直转）
    { id: "convert.open", title: "格式转换…（面板）", section: "工具", menu: "tools", menuLabel: "格式转换…", menuOrder: 50, menuSeparatorBefore: true, run: () => runHost.openConvertPanel() },
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
    { id: "encoding.detectMojibake", title: "检测乱码并建议编码", section: "编码", menu: "tools", menuLabel: "检测乱码并建议编码", menuOrder: 40, run: () => statusActions.detectMojibakeManually() },
    { id: "code.run", title: "运行当前文件（Code Run）", section: "运行", defaultKey: "F5", menu: "tools", menuLabel: "运行当前文件", menuOrder: 60, menuSeparatorBefore: true, run: () => runHost.runCurrentFile() },
    { id: "run.curlScript", title: "执行 cURL 脚本（选区/整篇，无需保存）", section: "运行", menu: "tools", menuLabel: "执行 cURL 脚本", menuOrder: 70, run: () => runHost.runCurlScript() },
    { id: "terminal.toggle", title: "切换终端（Ctrl+`）", section: "终端", defaultKey: "Mod-`", menu: "view", menuLabel: "切换终端", menuOrder: 30, menuSeparatorBefore: true, menuChecked: () => terminalHost.isOpen, run: () => void terminalHost.toggle() },
    { id: "code.runInTerminal", title: "在终端运行当前文件（Ctrl+F5）", section: "运行", defaultKey: "Mod-F5", menu: "tools", menuLabel: "在终端运行当前文件", menuOrder: 65, run: () => runHost.runInTerminal() },
    { id: "code.runCurlInTerminal", title: "在终端执行 cURL 脚本", section: "运行", run: () => runHost.runCurlInTerminal() },
    { id: "output.show", title: "运行输出面板", section: "运行", menu: "view", menuLabel: "运行输出面板", menuOrder: 35, menuChecked: () => runHost.isOutputOpen, run: () => {
        // 与终端同语义：已显示则收起；显示前先让出底部区域给其它面板
        if (runHost.isOutputOpen) runHost.hideOutputPanel();
        else showRunOutput();
      } },
    { id: "code.stop", title: "停止运行", section: "运行", menu: "tools", menuLabel: "停止运行", menuOrder: 75, run: () => runHost.stop() },
    { id: "search.toggleBookmark", title: "切换书签", section: "查找", defaultKey: "Mod-F2", fixed: true, run: () => toggleBookmark(getView()) },
    { id: "search.nextBookmark", title: "下一个书签", section: "查找", defaultKey: "F2", fixed: true, menu: "go", menuLabel: "下一个书签", menuOrder: 10, run: () => gotoBookmark(getView(), 1) },
    { id: "search.prevBookmark", title: "上一个书签", section: "查找", defaultKey: "Shift-F2", fixed: true, menu: "go", menuLabel: "上一个书签", menuOrder: 20, hidden: true, run: () => gotoBookmark(getView(), -1) },
    // 转到定义：文本级定位（复用工作区搜索的遍历，不是 LSP）。F12 可重绑。
    { id: "go.definition", title: "转到定义（工作区文本定位）", section: "查找", defaultKey: "F12", menu: "go", menuLabel: "转到定义（文本级）", menuOrder: 5, run: () => void symbolHost.jumpToDefinition() },
    // ---- 查找 / 替换（CM6 面板；仅菜单与快捷键，不进命令面板）----
    { id: "search.find", title: "查找（当前文档）", section: "查找", defaultKey: "Mod-F", menu: "edit", menuLabel: "查找…", menuOrder: 60, menuSeparatorBefore: true, hidden: true, run: () => {
        const tab = getActiveTab();
        if (!tab || tab.kind !== "text") return;
        // 虚拟视图的编辑器是隐藏的：打开 CM6 查找面板用户看不到任何东西
        if (tab.virtual) {
          showMessage("大文件虚拟视图请用工具条里的过滤");
          return;
        }
        // 纯预览模式下编辑器不可见：Ctrl+F 改为在渲染结果中查找
        if (preview.openFind()) return;
        openSearchPanel(getView());
      } },
    { id: "search.replace", title: "替换（当前文档）", section: "查找", defaultKey: "Mod-H", menu: "edit", menuLabel: "替换…", menuOrder: 65, hidden: true, run: () => {
        const tab = getActiveTab();
        if (tab?.kind !== "text") return;
        if (tab.virtual) {
          showMessage("大文件虚拟视图不支持替换");
          return;
        }
        const view = getView();
        openSearchPanel(view);
        // 面板内替换框（只读文档不渲染替换框，退化为仅查找）
        view.dom.querySelector<HTMLInputElement>('input[name="replace"]')?.focus();
      } },
    // ---- 视图 ----
    // 命令面板固定为「视图」第一项（VS Code 惯例）
    { id: "view.commandPalette", title: "命令面板", section: "视图", defaultKey: "Mod-Shift-P", menu: "view", menuLabel: "命令面板…", menuOrder: 5, hidden: true, run: () => palette.toggle() },
    { id: "view.toggleSidebar", title: "切换侧栏", section: "视图", defaultKey: "Mod-B", menu: "view", menuLabel: "切换侧栏", menuOrder: 10, hidden: true, menuChecked: () => layout.isSidebarVisible, run: () => layout.toggleSidebar() },
    { id: "view.toggleMinimap", title: "切换 Minimap 缩略图", section: "视图", defaultKey: "Mod-Shift-M", menu: "view", menuLabel: "切换 Minimap 缩略图", menuOrder: 40, menuSeparatorBefore: true, menuChecked: () => getConfig().layout.minimap, run: () => {
        const next = !getConfig().layout.minimap;
        // layout 段是浅合并，必须整对象回传；保存成功后主进程订阅会触发 Compartment 重配
        void updateSettings({ layout: { ...getConfig().layout, minimap: next } })
          .then(() => showMessage(`Minimap 已${next ? "开启" : "关闭"}`))
          .catch((e) => showMessage(`配置保存失败：${firstLine(e)}`));
      } },
    { id: "view.prevTab", title: "上一个标签", section: "视图", defaultKey: "Mod-PageUp", hidden: true, run: () => tabSwitcher.switchTab(-1) },
    { id: "view.nextTab", title: "下一个标签", section: "视图", defaultKey: "Mod-PageDown", hidden: true, run: () => tabSwitcher.switchTab(1) },
    { id: "view.toggleFullscreen", title: "全屏 / 退出全屏", section: "视图", defaultKey: "F11", menu: "view", menuLabel: "全屏 / 退出全屏", menuOrder: 45, menuChecked: () => fullscreenOn, run: () => {
        const win = getCurrentWindow();
        void win
          .isFullscreen()
          .then(async (on) => {
            await win.setFullscreen(!on);
            fullscreenOn = !on;
          })
          .catch((e) => showMessage(`全屏切换失败：${firstLine(e)}`));
      } },
    // 重新加载界面：改完前端资源 / 需要干净重放会话时用；执行前 flush 会话与草稿
    { id: "view.reloadWindow", title: "重新加载界面（Reload Window）", section: "视图", defaultKey: "Mod-Shift-R", menu: "view", menuLabel: "重新加载界面", menuOrder: 80, menuSeparatorBefore: true, run: () => void reloadWindow() },
    { id: "view.docStats", title: "文档统计（行 / 词 / 字符）", section: "视图", menu: "view", menuLabel: "文档统计…", menuOrder: 70, menuSeparatorBefore: true, run: () => {
        const tab = getActiveTab();
        if (!tab || tab.kind !== "text") {
          showMessage("当前标签没有可统计的文本");
          return;
        }
        // 虚拟标签没有 content 快照（snapshotOf 返回空串），直接统计会显示 0 行；
        // 索引完成后用真实总行数，未完成则明确提示
        if (tab.virtual) {
          showMessage(
            tab.totalLines == null
              ? "大文件索引尚未完成，请稍后再试"
              : `${tab.totalLines} 行 · 虚拟视图不统计词/字符`,
          );
          return;
        }
        const stats = textStats(tabStore.snapshotOf(tab));
        showMessage(
          `${stats.lines} 行 · ${stats.words} 词 · ${stats.chars} 字符（不含换行 ${stats.charsNoBreak}）`,
        );
      } },
    { id: "view.messageHistory", title: "查看最近消息（状态栏历史）", section: "视图", menu: "view", menuLabel: "最近消息…", menuOrder: 72, run: () => showMessageHistory() },
    { id: "view.sidebarOpen", title: "侧栏：打开的文件", section: "视图", menu: "view", menuLabel: "侧栏：打开的文件", menuOrder: 15, menuSeparatorBefore: true, menuChecked: () => isSidebarViewOpen("open"), run: () => showSidebarView("open") },
    { id: "view.sidebarGit", title: "侧栏：源代码管理", section: "视图", menu: "view", menuLabel: "侧栏：源代码管理", menuOrder: 17, menuChecked: () => isSidebarViewOpen("git"), run: () => showSidebarView("git") },
    { id: "view.sidebarFiles", title: "侧栏：文件", section: "视图", menu: "view", menuLabel: "侧栏：文件", menuOrder: 20, menuChecked: () => isSidebarViewOpen("files"), run: () => showSidebarView("files") },
    { id: "view.sidebarSearch", title: "侧栏：搜索", section: "视图", menu: "view", menuLabel: "侧栏：搜索", menuOrder: 22, menuChecked: () => isSidebarViewOpen("search"), run: () => showSidebarView("search") },
    { id: "view.sidebarOutline", title: "侧栏：大纲", section: "视图", menu: "view", menuLabel: "侧栏：大纲", menuOrder: 24, menuChecked: () => isSidebarViewOpen("outline"), run: () => showSidebarView("outline") },
    { id: "view.sidebarBookmarks", title: "侧栏：书签", section: "视图", menu: "view", menuLabel: "侧栏：书签", menuOrder: 26, menuChecked: () => isSidebarViewOpen("bookmarks"), run: () => showSidebarView("bookmarks") },
    // 结构化只读视图（不改文件，只换一种看法）；再点同一模式即关闭
    { id: "view.structuredCsv", title: "以表格查看（CSV / TSV）", section: "视图", menu: "view", menuLabel: "表格视图（CSV）", menuOrder: 60, menuSeparatorBefore: true, menuChecked: () => isStructuredViewOpen("csv"), run: () => showStructuredView("csv") },
    { id: "view.structuredJson", title: "以树查看（JSON）", section: "视图", menu: "view", menuLabel: "JSON 树视图", menuOrder: 62, menuChecked: () => isStructuredViewOpen("json"), run: () => showStructuredView("json") },
    // ---- Git（独立顶级菜单：Git 是一等能力）----
    { id: "git.pull", title: "拉取（快进合并）", section: "Git", menu: "git", menuLabel: "拉取（快进合并）", menuOrder: 10, run: () => gitPull() },
    { id: "git.push", title: "推送", section: "Git", menu: "git", menuLabel: "推送", menuOrder: 20, run: () => gitPush() },
    { id: "git.pickBranch", title: "切换分支…", section: "Git", menu: "git", menuLabel: "切换分支…", menuOrder: 30, menuSeparatorBefore: true, run: () => gitPickBranch() },
    { id: "git.showHistory", title: "Git：查看提交历史", section: "Git", menu: "git", menuLabel: "查看提交历史…", menuOrder: 40, run: () => gitOpenHistory() },
    { id: "diff.gitHead", title: "比较：与 Git HEAD", section: "Git", menu: "git", menuLabel: "与 Git HEAD 比较", menuOrder: 50, menuSeparatorBefore: true, run: () => void diffService.diffWithGit("worktree") },
    { id: "diff.gitIndex", title: "比较：与 Git 暂存区", section: "Git", menu: "git", menuLabel: "与 Git 暂存区比较", menuOrder: 55, run: () => void diffService.diffWithGit("index") },
    { id: "git.blameDialog", title: "Git：打开当前文件的 Blame 列表", section: "Git", menu: "git", menuLabel: "Blame 列表…", menuOrder: 60, menuSeparatorBefore: true, run: () => gitOpenBlame() },
    { id: "git.inlineBlame", title: "切换行内 Git Blame（跟随光标）", section: "Git", menu: "git", menuLabel: "行内 Git Blame", menuOrder: 65, menuChecked: () => gitInlineBlameEnabled(), run: () => gitToggleInlineBlame() },
    { id: "git.toggleReadOnly", title: "Git 只读模式（查看 / 可写切换）", section: "Git", menu: "git", menuLabel: "只读模式（切换）", menuOrder: 70, menuSeparatorBefore: true, run: () => gitToggleReadOnly() },
    // ---- 帮助菜单（文档随安装包打包，离线可用；速查/关于/诊断统一归这里）----
    { id: "help.guide", title: "用户指南", section: "帮助", menu: "help", menuLabel: "用户指南", menuOrder: 10, run: () => showHelpDialog("guide") },
    { id: "help.faq", title: "常见问题（FAQ）", section: "帮助", menu: "help", menuLabel: "常见问题（FAQ）", menuOrder: 20, run: () => showHelpDialog("faq") },
    { id: "help.shortcuts", title: "快捷键速查", section: "帮助", menu: "help", menuLabel: "快捷键速查…", menuOrder: 30, menuSeparatorBefore: true, run: () => showShortcuts() },
    { id: "help.about", title: "关于 my-editor", section: "帮助", menu: "help", menuLabel: "关于…", menuOrder: 60, menuSeparatorBefore: true, run: () => showAbout() },
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
