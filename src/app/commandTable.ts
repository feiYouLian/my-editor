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
import { showErrorCard } from "../ui/resultCard";
import { reportResult } from "./resultCenter";
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
    {
      id: "file.open",
      title: "打开文件…",
      section: "文件",
      description: "从磁盘打开一个文件，按扩展名自动选语法高亮",
      outcome: { kind: "none", hint: "打开的文件进入新标签；已打开的同路径文件会复用标签" },
      defaultKey: "Mod-O",
      menu: "file",
      menuOrder: 20,
      run: () => void fileService.openFileDialog(),
    },
    {
      id: "file.quickOpen",
      title: "快速打开文件…",
      section: "文件",
      description: "按文件名快速跳到工作区里的文件",
      keywords: ["快速打开", "找文件", "ctrl+p", "跳转文件"],
      outcome: { kind: "view", hint: "输入文件名片段即可过滤；↑↓ 选择、Enter 打开" },
      defaultKey: "Mod-P",
      menu: "file",
      menuLabel: "快速打开文件…",
      menuOrder: 25,
      run: () => quickOpen.open(),
    },
    {
      id: "file.new",
      title: "新建未命名文档",
      section: "文件",
      description: "新建一个空白的未命名文档，保存时再选路径",
      keywords: ["新建", "新文件", "untitled"],
      outcome: { kind: "none", hint: "未保存前不落盘；首次保存时让你选路径" },
      defaultKey: "Mod-N",
      menu: "file",
      menuLabel: "新建",
      menuOrder: 10,
      run: () => fileService.newUntitled(),
    },
    {
      id: "file.save",
      title: "保存",
      section: "文件",
      description: "把当前标签的改动写回原文件，不弹路径选择",
      keywords: ["ctrl+s", "存盘", "保存文件", "写回磁盘"],
      outcome: { kind: "none", hint: "写回原路径并保持原编码；未命名文档会先让你选保存位置" },
      defaultKey: "Mod-S",
      menu: "file",
      menuOrder: 50,
      menuSeparatorBefore: true,
      run: () => void fileService.saveFile(),
    },
    {
      id: "file.saveAs",
      title: "另存为…",
      section: "文件",
      description: "把当前内容另存为新文件，原文件保持不变",
      keywords: ["另存", "换个名字", "复制一份", "save as"],
      outcome: { kind: "file", hint: "新路径由你选择，原文件不动；保存后编辑的是新文件" },
      defaultKey: "Mod-Shift-S",
      menu: "file",
      menuOrder: 60,
      run: () => void fileService.saveFileAs(),
    },
    {
      id: "file.saveAll",
      title: "全部保存",
      section: "文件",
      description: "一次保存所有有未保存改动的标签",
      keywords: ["全部保存", "批量存盘", "一次存完"],
      outcome: { kind: "none", hint: "只写有改动的标签；失败时逐条列出是哪个文件" },
      defaultKey: "Mod-Alt-S",
      menu: "file",
      menuLabel: "全部保存",
      menuOrder: 55,
      run: () => void saveAllFiles(),
    },
    {
      id: "file.saveAsEncoding",
      title: "另存为指定编码…",
      section: "文件",
      description: "用指定编码另存当前文件，可顺带转码（如 GBK 转 UTF-8）",
      keywords: ["转编码", "gbk 转 utf-8", "另存编码", "乱码修复"],
      outcome: { kind: "file", hint: "写入新文件还是覆盖原文件由你选；确认前可先看预览" },
      menu: "file",
      menuLabel: "另存为指定编码…",
      menuOrder: 62,
      run: () => fileService.saveAsWithEncoding(),
    },
    {
      id: "file.reload",
      title: "重新载入当前文件（丢弃未保存修改）",
      section: "文件",
      description: "从磁盘重新读取当前文件，丢弃未保存的改动",
      keywords: ["重新载入", "丢弃改动", "还原", "重新打开"],
      outcome: { kind: "none", hint: "会丢失未保存修改，执行前有确认" },
      defaultKey: "Mod-R",
      menu: "file",
      menuLabel: "重新载入当前文件",
      menuOrder: 65,
      run: () => void reloadCurrentFile(),
    },
    {
      id: "file.reopenClosed",
      title: "重新打开关闭的标签",
      section: "文件",
      description: "重新打开最近关闭的标签，恢复光标与滚动位置",
      keywords: ["恢复标签", "撤销关闭", "重开", "ctrl+shift+t"],
      outcome: { kind: "none", hint: "按关闭顺序逐个恢复；文件已删除时会提示不存在" },
      defaultKey: "Mod-Shift-T",
      menu: "file",
      menuLabel: "重新打开关闭的标签",
      menuOrder: 78,
      run: () => void reopenClosedTab(),
    },
    {
      id: "file.closeTab",
      title: "关闭当前标签",
      section: "文件",
      description: "关闭当前标签，有未保存改动时先询问",
      keywords: ["关闭标签", "关掉", "ctrl+w"],
      outcome: { kind: "none", hint: "未保存时会问保存 / 不保存 / 取消" },
      defaultKey: "Mod-W",
      menu: "file",
      menuLabel: "关闭标签",
      menuOrder: 76,
      menuSeparatorBefore: true,
      run: () => {
        const tab = getActiveTab();
        if (tab) void closeTab(tab.id);
      },
    },
    {
      id: "file.quit",
      title: "退出",
      section: "文件",
      description: "退出应用，逐个处理未保存的标签",
      keywords: ["退出", "关闭应用", "结束"],
      outcome: { kind: "none", hint: "有未保存改动时逐个确认；会话与草稿会先落盘" },
      defaultKey: "Mod-Q",
      menu: "file",
      menuLabel: "退出",
      menuOrder: 80,
      run: () => windowChrome.close(),
    },
    {
      id: "file.recent",
      title: "最近打开的文件…",
      section: "文件",
      description: "从最近打开的文件里选一个重新打开",
      keywords: ["最近文件", "history", "上次打开的"],
      outcome: { kind: "view", hint: "列表来自本机记录；文件已移动时会提示找不到" },
      menu: "file",
      menuLabel: "最近打开…",
      menuOrder: 40,
      run: () => runHost.toggleRecentFiles(),
    },
    {
      id: "fetch.open",
      title: "从网址抓取网页…",
      section: "文件",
      description: "输入网址抓取网页正文，转成 Markdown 存到本地",
      keywords: ["抓网页", "网页转 markdown", "保存文章", "离线阅读"],
      outcome: { kind: "file", hint: "产物是 .md 文件，目录在对话框里选；抓取失败会给出原因" },
      defaultKey: "Mod-Shift-U",
      menu: "file",
      menuLabel: "从网址抓取网页…",
      menuOrder: 45,
      run: () => fetchHost.open(),
    },
    {
      id: "workspace.openDir",
      title: "打开目录（工作区）",
      section: "工作区",
      description: "把某个目录设为工作区，文件树与搜索以它为根",
      keywords: ["打开文件夹", "工作区", "项目根目录"],
      outcome: { kind: "none", hint: "切换工作区会重建文件树；当前打开的标签保留" },
      menu: "file",
      menuLabel: "打开目录（工作区）…",
      menuOrder: 30,
      run: () => void openWorkspaceDir(),
    },
    {
      id: "file.exportMarkdown",
      title: "导出 Markdown（当前 HTML 文件）",
      section: "文件",
      description: "把当前 HTML 页面转成 Markdown 文件，保存在原文件旁边",
      keywords: ["转成 md", "html 转 markdown", "导出 md", "给文档留个底"],
      outcome: { kind: "file", hint: "产物是同目录同名的 .md 文件，不修改原 HTML" },
      menu: "file",
      menuLabel: "导出 Markdown（当前 HTML）…",
      menuOrder: 74,
      menuSeparatorBefore: true,
      run: () => {
        const tab = getActiveTab();
        if (!tab || pathKindOf(tab.path) !== "html") {
          showMessage("当前文件不是 HTML，无法导出 Markdown");
          return;
        }
        void preview.export(tab, "md");
      },
    },
    // 文件级比较（Git 比较在「Git」菜单）：原「比较」顶级菜单撤销，按功能归位
    {
      id: "diff.unsaved",
      title: "比较：与磁盘内容（未保存改动）",
      section: "比较",
      description: "对比当前标签与磁盘内容，看还没保存的改动",
      keywords: ["未保存对比", "和磁盘比", "看改了啥", "diff", "未保存补丁", "把改动存成 patch"],
      outcome: { kind: "view", hint: "只读对比；可直接导出 .patch 发给别人" },
      menu: "file",
      menuLabel: "与磁盘内容比较（未保存改动）",
      menuOrder: 70,
      menuSeparatorBefore: true,
      run: () => void diffService.diffUnsaved(),
    },
    {
      id: "diff.pickFile",
      title: "比较：与文件…",
      section: "比较",
      description: "把当前文件与磁盘上另一个文件逐行对比，结果只读，可导出 .patch",
      keywords: ["比两个文件", "文件对比", "diff", "patch", "找不同", "两个文件差异", "对比结果留底"],
      outcome: { kind: "view", hint: "左侧是当前文件、右侧是所选文件；不改任何文件" },
      menu: "file",
      menuLabel: "与文件…比较",
      menuOrder: 72,
      run: () => void diffService.compareWithPickedFile(),
    },
    {
      id: "diff.compare",
      title: "灵活比较…",
      section: "比较",
      description:
        "两侧任选来源（当前标签 / 当前选区 / 磁盘版本 / 已打开的文件 / 磁盘文件 / 剪贴板 / 空文本），内容可编辑后比较",
      keywords: ["任意内容比较", "剪贴板对比", "文本对比", "对比两段", "改完再比", "diff"],
      outcome: {
        kind: "view",
        hint: "两侧文本框可直接修改，停顿后自动重算；结果是只读对齐视图，可复制补丁",
      },
      menu: "file",
      menuLabel: "灵活比较（任意内容）…",
      menuOrder: 73,
      run: () => void diffService.openWorkbench(),
    },
    // ---- 设置 ----
    {
      id: "settings.open",
      title: "打开设置…",
      section: "设置",
      description: "打开设置中心，主题 / 编辑 / 布局等改动即时生效",
      keywords: ["设置", "偏好", "选项", "配置界面"],
      outcome: { kind: "view", hint: "改动即时保存到 config.json；字段含义可在「配置说明」里查" },
      defaultKey: "Mod-,",
      menu: "settings",
      menuLabel: "设置中心…",
      menuOrder: 10,
      run: () => openSettings(),
    },
    {
      id: "settings.openKeybindings",
      title: "设置：快捷键",
      section: "设置",
      description: "打开设置里的快捷键页，改键位或恢复默认",
      keywords: ["改快捷键", "键位", "快捷键设置", "绑定"],
      outcome: { kind: "view", hint: "每条命令都可重绑，冲突会提示；改动即时生效", entry: "命令面板" },
      run: () => openSettings("keybindings"),
    },
    {
      id: "settings.openLayout",
      title: "设置：页面布局",
      section: "设置",
      description: "打开设置里的页面布局页，调整字号 / 行高 / 侧栏宽度",
      keywords: ["布局", "字号", "行高", "界面设置"],
      outcome: { kind: "view", hint: "改动即时预览并保存；可一键恢复默认", entry: "命令面板" },
      run: () => openSettings("layout"),
    },
    {
      id: "help.settings",
      title: "配置说明（字段含义与生效方式）",
      section: "设置",
      description: "列出 config.json 每个字段的含义与生效方式",
      keywords: ["配置说明", "字段含义", "config 怎么改", "生效方式"],
      outcome: { kind: "view", hint: "说明随版本内置，离线可查；改完保存后由应用自动重载" },
      menu: "settings",
      menuLabel: "配置说明",
      menuOrder: 20,
      menuSeparatorBefore: true,
      run: () => showSettingsHelp(),
    },
    {
      id: "config.openFile",
      title: "打开配置文件（config.json）",
      section: "设置",
      description: "在编辑器里打开 config.json，直接改原始配置",
      keywords: ["打开配置", "config.json", "手改配置", "高级设置"],
      outcome: { kind: "none", hint: "改完保存即生效；格式错误会在打开时提示具体位置" },
      menu: "settings",
      menuLabel: "打开配置文件…",
      menuOrder: 30,
      menuSeparatorBefore: true,
      run: () => void fileService.openConfigFile(),
    },
    {
      id: "config.reload",
      title: "重新加载配置（config.json）",
      section: "设置",
      description: "重新读取磁盘上的 config.json，丢弃未保存的配置改动",
      keywords: ["重载配置", "刷新配置", "配置没生效", "config 重读"],
      outcome: { kind: "none", hint: "只重读配置，不动文档；外部改过 config.json 后用这个同步" },
      menu: "settings",
      menuLabel: "重新加载配置",
      menuOrder: 40,
      run: () => void fileService.reloadConfig(),
    },
    // 诊断 / 更新类归「帮助」（原混在「设置」里，与配置项不是一类事）
    {
      id: "help.openLogs",
      title: "打开日志目录",
      section: "帮助",
      description: "打开日志目录，查看运行记录与报错细节",
      keywords: ["日志", "报错", "排查", "log 在哪"],
      outcome: { kind: "view", hint: "目录由系统文件管理器打开；日志按天分文件，不含文档内容" },
      menu: "help",
      menuLabel: "打开日志目录",
      menuOrder: 45,
      run: () => {
        void openLogsDir().catch((e) => showMessage(`打开日志目录失败：${firstLine(e)}`));
      },
    },
    {
      id: "help.exportDiagnostics",
      title: "导出诊断包（版本 / 系统 / 日志）",
      section: "帮助",
      description: "把版本、系统信息与日志打包，用于反馈问题",
      keywords: ["诊断包", "反馈 bug", "导出日志", "求助"],
      outcome: { kind: "file", hint: "产物是 zip 压缩包；只含版本、系统与日志，不含文档内容" },
      menu: "help",
      menuLabel: "导出诊断包…",
      menuOrder: 50,
      run: () => {
        void exportDiagnostics()
          .then((path) =>
            reportResult({
              title: "已导出诊断包",
              path,
              hint: "压缩包只含版本、系统信息与日志，不含文档内容；反馈问题时附上它即可",
              key: "diagnostics",
            }),
          )
          .catch((e) =>
            showErrorCard({
              title: "导出诊断包失败",
              message: firstLine(e),
              hint: "配置目录可能只读；可先打开「日志目录」确认磁盘状态后重试。",
            }),
          );
      },
    },
    {
      id: "help.checkUpdates",
      title: "检查更新",
      section: "帮助",
      description: "检查是否有新版本，有则可直接下载安装",
      keywords: ["更新", "升级", "新版本", "check update"],
      outcome: { kind: "view", hint: "结果以提示显示；下载安装前会再确认一次" },
      menu: "help",
      menuLabel: "检查更新…",
      menuOrder: 40,
      menuSeparatorBefore: true,
      run: () => void checkForUpdates(showMessage),
    },
    // ---- 编辑 ----
    {
      id: "edit.format",
      title: "格式化文档",
      section: "编辑",
      description: "用对应语言的格式化工具整理整篇文档，格式错误会指出位置",
      keywords: ["格式化", "美化代码", "prettier", "排版"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；缺工具时会给出配置入口" },
      defaultKey: "Shift-Alt-F",
      altKeys: ["Mod-Alt-Shift-F"],
      menu: "edit",
      menuLabel: "格式化文档",
      menuOrder: 80,
      menuSeparatorBefore: true,
      run: () => void formatHost.formatCurrent(),
    },
    {
      id: "edit.formatSelection",
      title: "格式化选中内容",
      section: "编辑",
      description: "只格式化选中的一段代码，其余内容不动",
      keywords: ["格式化选区", "局部格式化", "选中排版"],
      outcome: { kind: "none", hint: "只改选区，可撤销；未选中时提示先选一段" },
      menu: "edit",
      menuOrder: 85,
      run: () => void formatHost.formatSelectionCurrent(),
    },
    // 选中同词属于「选择」菜单（VS Code Selection 分组）：Ctrl+Alt+D / Ctrl+Alt+Shift+D（不改动 Mod-D = 删除当前行）
    {
      id: "edit.selectNextOccurrence",
      title: "选中下一个相同词",
      section: "选择",
      description: "选中与当前选区相同的下一处文本",
      keywords: ["选中同词", "多光标", "批量改", "ctrl+alt+d"],
      outcome: { kind: "none", hint: "连续触发可累积多个选区，再一起编辑" },
      defaultKey: "Mod-Alt-D",
      menu: "select",
      menuOrder: 20,
      menuSeparatorBefore: true,
      run: () => { if (!blockIfReadonly()) selectNextOccurrence(getView()); },
    },
    {
      id: "edit.selectAllOccurrences",
      title: "选中全部相同词",
      section: "选择",
      description: "一次选中文档里所有与当前选区相同的文本",
      keywords: ["全选同词", "全部匹配", "批量替换"],
      outcome: { kind: "none", hint: "只选中不改内容；随后输入会同时改所有选区" },
      defaultKey: "Mod-Alt-Shift-D",
      menu: "select",
      menuOrder: 30,
      run: () => { if (!blockIfReadonly()) selectSelectionMatches(getView()); },
    },
    // 折叠属于「视图」菜单（VS Code View ▸ Folding）：能力来自 foldKeymap，这里只补"可发现性"
    {
      id: "edit.foldAll",
      title: "折叠全部",
      section: "视图",
      description: "折叠文档里所有可折叠的代码块",
      keywords: ["折叠全部", "收起代码", "折叠"],
      outcome: { kind: "none", hint: "只影响显示，不改内容" },
      defaultKey: "Ctrl-Alt-[",
      fixed: true,
      menu: "view",
      menuLabel: "折叠全部",
      menuOrder: 50,
      menuSeparatorBefore: true,
      hidden: true,
      run: () => { foldAll(getView()); },
    },
    {
      id: "edit.unfoldAll",
      title: "展开全部",
      section: "视图",
      description: "展开文档里所有被折叠的代码块",
      keywords: ["展开全部", "取消折叠"],
      outcome: { kind: "none", hint: "只影响显示，不改内容" },
      defaultKey: "Ctrl-Alt-]",
      fixed: true,
      menu: "view",
      menuLabel: "展开全部",
      menuOrder: 55,
      hidden: true,
      run: () => { unfoldAll(getView()); },
    },
    {
      id: "edit.complete",
      title: "触发补全",
      section: "编辑",
      description: "在光标处触发编辑器内置的词法补全建议",
      keywords: ["补全", "autocomplete", "ctrl+space"],
      outcome: { kind: "view", hint: "补全来自编辑器内置的词法分析，不做语义推断" },
      defaultKey: "Ctrl-Space",
      fixed: true,
      hidden: true,
      run: () => { /* 由 CM6 键位处理，仅用于速查展示 */ },
    },
    {
      id: "edit.columnEditor",
      title: "列编辑器",
      section: "编辑",
      description: "打开列编辑：按列对齐插入或改写多行",
      keywords: ["列编辑", "多行编辑", "矩形选择", "alt+c"],
      outcome: { kind: "view", hint: "对话框内输入，确认后写回编辑器；可撤销" },
      defaultKey: "Alt-C",
      fixed: true,
      menu: "edit",
      menuLabel: "列编辑器",
      menuOrder: 90,
      menuSeparatorBefore: true,
      run: () => { if (!blockIfReadonly()) openColumnEditor(getView()); },
    },
    // 行操作：按行语义（有选区取整行，无选区整篇），不占用默认键位
    {
      id: "edit.sortLinesAsc",
      title: "行操作：按升序排序",
      section: "编辑",
      description: "把选中行或整篇按字符升序排序",
      keywords: ["排序", "升序", "按字母排", "整理列表"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；有选区时只排选区内的行", entry: "命令面板" },
      run: () => runLineOp({ kind: "sort", options: {} }),
    },
    {
      id: "edit.sortLinesDesc",
      title: "行操作：按降序排序",
      section: "编辑",
      description: "把选中行或整篇按字符降序排序",
      keywords: ["倒序排列", "降序", "排序"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销", entry: "命令面板" },
      run: () => runLineOp({ kind: "sort", options: { desc: true } }),
    },
    {
      id: "edit.sortLinesAscNumeric",
      title: "行操作：按数字升序排序",
      section: "编辑",
      description: "按数字大小升序排列，2 排在 10 前面",
      keywords: ["数字排序", "按大小排", "数值升序"],
      outcome: { kind: "none", hint: "非数字行按 0 处理；结果可撤销", entry: "命令面板" },
      run: () => runLineOp({ kind: "sort", options: { numeric: true } }),
    },
    {
      id: "edit.dedupeLines",
      title: "行操作：去除重复行",
      section: "编辑",
      description: "删除重复行，只保留第一次出现的那行",
      keywords: ["去重", "删除重复行", "unique"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；行内空格不参与比较", entry: "命令面板" },
      run: () => runLineOp({ kind: "dedupe" }),
    },
    {
      id: "edit.reverseLines",
      title: "行操作：反转行序",
      section: "编辑",
      description: "把选中行或整篇的行序反过来",
      keywords: ["反转行序", "倒过来", "reverse"],
      outcome: { kind: "none", hint: "只调整行顺序，不改行内容；可撤销", entry: "命令面板" },
      run: () => runLineOp({ kind: "reverse" }),
    },
    {
      id: "edit.removeEmptyLines",
      title: "行操作：删除空行",
      section: "编辑",
      description: "删除文档或选区里的空行与只含空白的行",
      keywords: ["删空行", "去掉空白行", "清理"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销", entry: "命令面板" },
      run: () => runLineOp({ kind: "removeEmpty" }),
    },
    {
      id: "edit.trimTrailing",
      title: "行操作：删除行尾空白",
      section: "编辑",
      description: "删除每行末尾多余的空格与制表符",
      keywords: ["行尾空格", "去掉尾随空白", "清理空白"],
      outcome: { kind: "none", hint: "只动行尾，不改行首缩进；可撤销", entry: "命令面板" },
      run: () => runLineOp({ kind: "trimTrailing" }),
    },
    {
      id: "edit.tabsToSpaces",
      title: "行操作：缩进 Tab 转空格",
      section: "编辑",
      description: "按当前 Tab 宽度把行首缩进里的 Tab 换成空格",
      keywords: ["tab 转空格", "缩进转换", "空格缩进"],
      outcome: { kind: "none", hint: "宽度取设置里的 tabSize；只处理行首缩进，可撤销", entry: "命令面板" },
      run: () => runLineOp({ kind: "indent", toSpaces: true }),
    },
    {
      id: "edit.spacesToTabs",
      title: "行操作：缩进空格转 Tab",
      section: "编辑",
      description: "把行首缩进里的空格按 Tab 宽度换成 Tab",
      keywords: ["空格转 tab", "缩进转换", "tab 缩进"],
      outcome: { kind: "none", hint: "宽度取设置里的 tabSize；只处理行首缩进，可撤销", entry: "命令面板" },
      run: () => runLineOp({ kind: "indent", toSpaces: false }),
    },
    {
      id: "edit.toggleWhitespace",
      title: "切换空白字符显示",
      section: "编辑",
      description: "显示或隐藏空格、制表符与换行的可见标记",
      keywords: ["空白字符", "显示空格", "tab 标记"],
      outcome: { kind: "none", hint: "只改显示，不改内容" },
      defaultKey: "",
      menu: "edit",
      menuLabel: "切换空白字符显示",
      menuOrder: 95,
      menuSeparatorBefore: true,
      run: () => toggleWhitespace(),
    },
    // ---- 查找 ----
    {
      id: "search.results",
      title: "查找结果面板",
      section: "查找",
      description: "展开或收起查找结果面板，点条目跳到命中处",
      keywords: ["查找结果", "搜索结果", "结果列表"],
      outcome: { kind: "view", hint: "显示当前文档或工作区的匹配列表；点条目跳转" },
      defaultKey: "",
      menu: "edit",
      menuOrder: 72,
      run: () => toggleResultsPanel(),
    },
    {
      id: "search.workspace",
      title: "在文件中查找…（工作区）",
      section: "查找",
      description: "在整个工作区里按文本查找，结果可批量替换",
      keywords: ["全局搜索", "在文件中查找", "ctrl+shift+f", "批量替换"],
      outcome: { kind: "view", hint: "先在侧栏列出命中；批量替换会写盘，执行前逐条确认" },
      defaultKey: "Mod-Shift-F",
      menu: "edit",
      menuLabel: "在文件中查找…",
      menuOrder: 70,
      run: () => focusWorkspaceSearch(),
    },
    // ---- 工具 ----
    {
      id: "tools.cron",
      title: "Cron 表达式解析 / 生成",
      section: "工具",
      description: "解析 Cron 表达式，或按选择生成表达式",
      keywords: ["cron", "定时任务", "表达式", "几点执行"],
      outcome: { kind: "view", hint: "面板内计算，不改文档；可复制生成的表达式" },
      menu: "tools",
      menuLabel: "Cron 解析 / 生成…",
      menuOrder: 10,
      run: () => runHost.toggleCron(),
    },
    {
      id: "tools.batchEncoding",
      title: "批量另存为编码…",
      section: "工具",
      description: "按目录批量把文件转成指定编码，可先预览命中清单",
      keywords: ["批量转码", "整个目录转 utf-8", "gbk 批量", "编码转换"],
      outcome: { kind: "file", hint: "先列出命中文件再执行；覆盖原文件前会确认，产物路径在结果里" },
      menu: "tools",
      menuLabel: "批量另存为编码…",
      menuOrder: 30,
      run: () => runHost.toggleBatchEncoding(),
    },
    {
      id: "tools.regex",
      title: "正则测试器",
      section: "工具",
      description: "边写正则边看匹配结果，可只保留或删除命中行",
      keywords: ["正则测试", "regex", "匹配", "替换"],
      outcome: { kind: "view", hint: "面板内试写不改文档；只有点「应用」才写回编辑器" },
      menu: "tools",
      menuLabel: "正则测试器…",
      menuOrder: 20,
      run: () => runHost.toggleRegexTester(),
    },
    // 格式转换（面板 + 高频单步直转）
    {
      id: "convert.open",
      title: "格式转换…（面板）",
      section: "工具",
      description: "打开格式转换面板，在 JSON / YAML / Properties / Java 之间互转",
      keywords: ["格式转换", "json 转 yaml", "yaml 转 json", "properties"],
      outcome: { kind: "view", hint: "面板内转换结果可替换当前文档或复制；不自动写盘" },
      menu: "tools",
      menuLabel: "格式转换…",
      menuOrder: 50,
      menuSeparatorBefore: true,
      run: () => runHost.openConvertPanel(),
    },
    {
      id: "convert.json2yaml",
      title: "转换：JSON → YAML",
      section: "转换",
      description: "把当前文档或选区的 JSON 转成 YAML，结果写回编辑器",
      keywords: ["json 转 yaml", "转成 yaml", "yml"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；不生成新文件", entry: "命令面板" },
      run: () => void runHost.convertDirect("json2yaml"),
    },
    {
      id: "convert.yaml2json",
      title: "转换：YAML → JSON",
      section: "转换",
      description: "把当前文档或选区的 YAML 转成 JSON，结果写回编辑器",
      keywords: ["yaml 转 json", "转成 json", "yml 转 json"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；不生成新文件", entry: "命令面板" },
      run: () => void runHost.convertDirect("yaml2json"),
    },
    {
      id: "convert.properties2yaml",
      title: "转换：Properties → YAML",
      section: "转换",
      description: "把 .properties 配置转成 YAML，结果写回编辑器",
      keywords: ["properties 转 yaml", "配置文件转换", "java 配置"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；不生成新文件", entry: "命令面板" },
      run: () => void runHost.convertDirect("properties2yaml"),
    },
    {
      id: "convert.yaml2properties",
      title: "转换：YAML → Properties",
      section: "转换",
      description: "把 YAML 转成 .properties 配置，结果写回编辑器",
      keywords: ["yaml 转 properties", "生成 properties", "java 配置"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；不生成新文件", entry: "命令面板" },
      run: () => void runHost.convertDirect("yaml2properties"),
    },
    {
      id: "convert.json2java",
      title: "转换：JSON → Java 代码",
      section: "转换",
      description: "把 JSON 样例转成 Java 类代码，字段类型自动推断",
      keywords: ["json 转 java", "生成实体类", "pojo", "javabean"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；类名按文件名推断，可再改", entry: "命令面板" },
      run: () => void runHost.convertDirect("json2java"),
    },
    {
      id: "convert.java2json",
      title: "转换：Java → JSON",
      section: "转换",
      description: "把 Java 类字段转成 JSON 样例，便于构造测试数据",
      keywords: ["java 转 json", "生成 json 样例", "测试数据"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；只取字段名与类型，不解析方法体", entry: "命令面板" },
      run: () => void runHost.convertDirect("java2json"),
    },
    // 文本变换（作用于选区）
    ...(Object.keys(CASE_LABELS) as CaseMode[]).map((mode): CommandDef => ({
      id: `text.case.${mode}`,
      title: `转换大小写：${CASE_LABELS[mode]}`,
      section: "文本",
      description: "把选中文本在全部大写、小写、驼峰、下划线等命名写法之间转换",
      keywords: ["大小写", "驼峰", "下划线", "命名风格", "case 转换"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；无选区时处理光标所在的词", entry: "命令面板" },
      run: () => runHost.runCase(mode),
    })),
    {
      id: "text.json.pretty",
      title: "JSON 美化",
      section: "文本",
      description: "把 JSON 重新缩进排版，解析失败会指出出错位置",
      keywords: ["json 美化", "格式化 json", "缩进"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销；语法错误时不改内容并给出行列", entry: "命令面板" },
      run: () => runHost.runJson(false),
    },
    {
      id: "text.json.minify",
      title: "JSON 压缩",
      section: "文本",
      description: "把 JSON 压成单行，去掉多余空白",
      keywords: ["json 压缩", "minify", "压成一行"],
      outcome: { kind: "none", hint: "结果写回编辑器，可撤销", entry: "命令面板" },
      run: () => runHost.runJson(true),
    },
    // Markdown 增强（作用于选区；表格为对话框）
    {
      id: "md.bold",
      title: "Markdown：加粗（包裹 ** **）",
      section: "Markdown",
      description: "把选区包成 **加粗**，未选中时插入标记并停在中间",
      keywords: ["加粗", "bold", "markdown 粗体"],
      outcome: { kind: "none", hint: "只改编辑器内容，可撤销", entry: "命令面板" },
      run: () => runHost.runWrap("**", "加粗："),
    },
    {
      id: "md.italic",
      title: "Markdown：斜体（包裹 * *）",
      section: "Markdown",
      description: "把选区包成 *斜体*，未选中时插入标记并停在中间",
      keywords: ["斜体", "italic", "markdown 斜体"],
      outcome: { kind: "none", hint: "只改编辑器内容，可撤销", entry: "命令面板" },
      run: () => runHost.runWrap("*", "斜体："),
    },
    {
      id: "md.highlight",
      title: "Markdown：高亮（包裹 == ==）",
      section: "Markdown",
      description: "把选区包成 ==高亮==",
      keywords: ["高亮", "highlight", "mark"],
      outcome: { kind: "none", hint: "只改编辑器内容，可撤销", entry: "命令面板" },
      run: () => runHost.runWrap("==", "高亮："),
    },
    {
      id: "md.table",
      title: "Markdown：插入表格…",
      section: "Markdown",
      description: "按指定行列插入 Markdown 表格骨架",
      keywords: ["表格", "插入表格", "markdown table"],
      outcome: { kind: "none", hint: "插入的是空表格骨架，可直接填；可撤销", entry: "命令面板" },
      run: () => runHost.toggleTableDialog(),
    },
    // ---- 插入 ----
    {
      id: "insert.clipboardImage",
      title: "插入剪贴板图片（存为 .assets 并插入引用）",
      section: "插入",
      description: "把剪贴板里的图片存到文档旁的 .assets 目录并插入引用",
      keywords: ["粘贴图片", "截图", "插图", "markdown 图片"],
      outcome: { kind: "file", hint: "产物在文档同目录的 .assets 里；插入的是相对路径引用", entry: "命令面板" },
      run: () => void fileService.insertClipboardImage(),
    },
    {
      id: "insert.localTime",
      title: "插入本地时间（YYYY-MM-DD HH:mm:ss）",
      section: "插入",
      description: "在光标处插入本地时间（YYYY-MM-DD HH:mm:ss）",
      keywords: ["插入时间", "当前时间", "时间戳"],
      outcome: { kind: "none", hint: "插入的是纯文本，可撤销", entry: "命令面板" },
      run: () => insertAtCursor(localStamps().local),
    },
    {
      id: "insert.isoTime",
      title: "插入 ISO 时间戳",
      section: "插入",
      description: "在光标处插入 ISO 8601 时间戳",
      keywords: ["iso 时间", "utc 时间", "标准时间"],
      outcome: { kind: "none", hint: "插入的是纯文本，可撤销", entry: "命令面板" },
      run: () => insertAtCursor(localStamps().iso),
    },
    {
      id: "insert.unixTime",
      title: "插入 Unix 时间戳",
      section: "插入",
      description: "在光标处插入 Unix 秒级时间戳",
      keywords: ["unix 时间戳", "epoch", "秒级"],
      outcome: { kind: "none", hint: "插入的是纯数字，可撤销", entry: "命令面板" },
      run: () => insertAtCursor(localStamps().unix),
    },
    {
      id: "insert.date",
      title: "插入日期（YYYY-MM-DD）",
      section: "插入",
      description: "在光标处插入日期（YYYY-MM-DD）",
      keywords: ["插入日期", "今天", "日期"],
      outcome: { kind: "none", hint: "插入的是纯文本，可撤销", entry: "命令面板" },
      run: () => insertAtCursor(localStamps().date),
    },
    {
      id: "insert.time",
      title: "插入时间（HH:mm:ss）",
      section: "插入",
      description: "在光标处插入时间（HH:mm:ss）",
      keywords: ["插入时间", "当前时刻"],
      outcome: { kind: "none", hint: "插入的是纯文本，可撤销", entry: "命令面板" },
      run: () => insertAtCursor(localStamps().time),
    },
    {
      id: "insert.uuid",
      title: "插入 UUID（v4）",
      section: "插入",
      description: "在光标处插入一个 UUID v4",
      keywords: ["uuid", "唯一 id", "guid"],
      outcome: { kind: "none", hint: "每次执行生成新值，可撤销", entry: "命令面板" },
      run: () => insertAtCursor(newUuid()),
    },
    // ---- 编码 / 运行 ----
    {
      id: "encoding.detectMojibake",
      title: "检测乱码并建议编码",
      section: "编码",
      description: "检查当前文档是否乱码，并建议用哪个编码重开",
      keywords: ["乱码", "编码检测", "gbk", "utf-8"],
      outcome: { kind: "view", hint: "结果在状态栏提示；确认后用「另存为指定编码」或重开转换" },
      menu: "tools",
      menuLabel: "检测乱码并建议编码",
      menuOrder: 40,
      run: () => statusActions.detectMojibakeManually(),
    },
    {
      id: "code.run",
      title: "运行当前文件（Code Run）",
      section: "运行",
      description: "把当前文件交给对应语言的运行器执行，输出显示在底部面板",
      keywords: ["运行", "f5", "跑一下", "执行脚本"],
      outcome: { kind: "view", hint: "文件需先保存到磁盘；输出在运行面板，可随时停止" },
      defaultKey: "F5",
      menu: "tools",
      menuLabel: "运行当前文件",
      menuOrder: 60,
      menuSeparatorBefore: true,
      run: () => runHost.runCurrentFile(),
    },
    {
      id: "run.curlScript",
      title: "执行 cURL 脚本（选区/整篇，无需保存）",
      section: "运行",
      description: "把选区或整篇 cURL 命令直接执行，输出在运行面板",
      keywords: ["curl", "执行脚本", "调接口", "http"],
      outcome: { kind: "view", hint: "无需保存文件；输出面板可复制，敏感头信息会原样显示" },
      menu: "tools",
      menuLabel: "执行 cURL 脚本",
      menuOrder: 70,
      run: () => runHost.runCurlScript(),
    },
    {
      id: "terminal.toggle",
      title: "切换终端（Ctrl+`）",
      section: "终端",
      description: "打开或收起底部终端，会话保持不丢失",
      keywords: ["终端", "命令行", "shell", "命令行窗口"],
      outcome: { kind: "view", hint: "最多同时 8 个会话；收起不会结束正在运行的进程" },
      defaultKey: "Mod-`",
      menu: "view",
      menuLabel: "切换终端",
      menuOrder: 30,
      menuSeparatorBefore: true,
      menuChecked: () => terminalHost.isOpen,
      run: () => void terminalHost.toggle(),
    },
    {
      id: "code.runInTerminal",
      title: "在终端运行当前文件（Ctrl+F5）",
      section: "运行",
      description: "在终端里用当前文件的语言命令运行，可直接输入交互",
      keywords: ["在终端运行", "交互式运行", "终端执行", "python 交互"],
      outcome: { kind: "view", hint: "需要已保存的文件；命令与参数取自运行器配置" },
      defaultKey: "Mod-F5",
      menu: "tools",
      menuLabel: "在终端运行当前文件",
      menuOrder: 65,
      run: () => runHost.runInTerminal(),
    },
    {
      id: "code.runCurlInTerminal",
      title: "在终端执行 cURL 脚本",
      section: "运行",
      description: "把选区或整篇 cURL 命令交给终端执行，便于看实时输出",
      keywords: ["curl", "执行请求", "调接口", "http 请求"],
      outcome: { kind: "view", hint: "无需保存文件；请求内容会出现在终端里，注意敏感头信息", entry: "命令面板" },
      run: () => runHost.runCurlInTerminal(),
    },
    {
      id: "output.show",
      title: "运行输出面板",
      section: "运行",
      description: "展开或收起底部运行输出面板",
      keywords: ["输出面板", "看运行结果", "控制台"],
      outcome: { kind: "view", hint: "显示最近一次运行的输出；与终端互斥，避免底部叠加" },
      menu: "view",
      menuLabel: "运行输出面板",
      menuOrder: 35,
      menuChecked: () => runHost.isOutputOpen,
      run: () => {
        // 与终端同语义：已显示则收起；显示前先让出底部区域给其它面板
        if (runHost.isOutputOpen) runHost.hideOutputPanel();
        else showRunOutput();
      },
    },
    {
      id: "code.stop",
      title: "停止运行",
      section: "运行",
      description: "终止本应用启动的、正在运行的进程",
      keywords: ["停止运行", "终止", "kill", "中断"],
      outcome: { kind: "view", hint: "只结束本应用启动的进程；终端里的会话用 Ctrl+C" },
      menu: "tools",
      menuLabel: "停止运行",
      menuOrder: 75,
      run: () => runHost.stop(),
    },
    {
      id: "search.toggleBookmark",
      title: "切换书签",
      section: "查找",
      description: "在当前行添加或取消书签，可在侧栏书签页查看",
      keywords: ["书签", "标记行", "ctrl+f2"],
      outcome: { kind: "none", hint: "书签存在会话里，可在侧栏「书签」查看", entry: "命令面板" },
      defaultKey: "Mod-F2",
      fixed: true,
      run: () => toggleBookmark(getView()),
    },
    {
      id: "search.nextBookmark",
      title: "下一个书签",
      section: "查找",
      description: "跳到下一个书签所在行，到末尾回到第一个",
      keywords: ["下一个书签", "f2"],
      outcome: { kind: "none", hint: "到末尾会回到第一个并提示" },
      defaultKey: "F2",
      fixed: true,
      menu: "go",
      menuLabel: "下一个书签",
      menuOrder: 10,
      run: () => gotoBookmark(getView(), 1),
    },
    {
      id: "search.prevBookmark",
      title: "上一个书签",
      section: "查找",
      description: "跳到上一个书签所在行，到开头回到最后一个",
      keywords: ["上一个书签", "shift+f2"],
      outcome: { kind: "none", hint: "到开头会回到最后一个并提示" },
      defaultKey: "Shift-F2",
      fixed: true,
      menu: "go",
      menuLabel: "上一个书签",
      menuOrder: 20,
      hidden: true,
      run: () => gotoBookmark(getView(), -1),
    },
    // 转到定义：文本级定位（复用工作区搜索的遍历，不是 LSP）。F12 可重绑。
    {
      id: "go.definition",
      title: "转到定义（工作区文本定位）",
      section: "查找",
      description: "在当前工作区里按名字找同名符号，跳到它出现的位置（不做语义解析）",
      keywords: ["转到定义", "f12", "找定义", "跳转"],
      outcome: { kind: "none", hint: "文本级定位，可能有同名误报；结果列表里可挑选" },
      defaultKey: "F12",
      menu: "go",
      menuLabel: "转到定义（文本级）",
      menuOrder: 5,
      run: () => void symbolHost.jumpToDefinition(),
    },
    // ---- 查找 / 替换（CM6 面板；仅菜单与快捷键，不进命令面板）----
    {
      id: "search.find",
      title: "查找（当前文档）",
      section: "查找",
      description: "在当前文档里查找文本，Ctrl+F 打开查找栏",
      keywords: ["查找", "ctrl+f", "搜索"],
      outcome: { kind: "view", hint: "编辑器内查找栏；大文件虚拟视图请用工具条过滤" },
      defaultKey: "Mod-F",
      menu: "edit",
      menuLabel: "查找…",
      menuOrder: 60,
      menuSeparatorBefore: true,
      hidden: true,
      run: () => {
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
      },
    },
    {
      id: "search.replace",
      title: "替换（当前文档）",
      section: "查找",
      description: "在当前文档里查找并替换，可逐条或全部替换",
      keywords: ["替换", "ctrl+h", "批量改"],
      outcome: { kind: "none", hint: "替换写回编辑器，可撤销；只读文档不显示替换框" },
      defaultKey: "Mod-H",
      menu: "edit",
      menuLabel: "替换…",
      menuOrder: 65,
      hidden: true,
      run: () => {
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
      },
    },
    // ---- 视图 ----
    // 命令面板固定为「视图」第一项（VS Code 惯例）
    {
      id: "view.commandPalette",
      title: "命令面板",
      section: "视图",
      description: "打开命令面板，按名字或用途搜命令",
      keywords: ["命令面板", "ctrl+shift+p", "找命令"],
      outcome: { kind: "view", hint: "输入自然语言也能命中说明与关键词；Enter 执行" },
      defaultKey: "Mod-Shift-P",
      menu: "view",
      menuLabel: "命令面板…",
      menuOrder: 5,
      hidden: true,
      run: () => palette.toggle(),
    },
    {
      id: "view.toggleSidebar",
      title: "切换侧栏",
      section: "视图",
      description: "显示或收起左侧栏，布局状态会记住",
      keywords: ["侧栏", "收起侧栏", "ctrl+b"],
      outcome: { kind: "none", hint: "只改布局，不改文件；下次启动记住状态" },
      defaultKey: "Mod-B",
      menu: "view",
      menuLabel: "切换侧栏",
      menuOrder: 10,
      hidden: true,
      menuChecked: () => layout.isSidebarVisible,
      run: () => layout.toggleSidebar(),
    },
    {
      id: "view.toggleMinimap",
      title: "切换 Minimap 缩略图",
      section: "视图",
      description: "显示或隐藏右侧代码缩略图",
      keywords: ["minimap", "缩略图", "代码地图"],
      outcome: { kind: "none", hint: "改动即时保存到配置" },
      defaultKey: "Mod-Shift-M",
      menu: "view",
      menuLabel: "切换 Minimap 缩略图",
      menuOrder: 40,
      menuSeparatorBefore: true,
      menuChecked: () => getConfig().layout.minimap,
      run: () => {
        const next = !getConfig().layout.minimap;
        // layout 段是浅合并，必须整对象回传；保存成功后主进程订阅会触发 Compartment 重配
        void updateSettings({ layout: { ...getConfig().layout, minimap: next } })
          .then(() => showMessage(`Minimap 已${next ? "开启" : "关闭"}`))
          .catch((e) => showMessage(`配置保存失败：${firstLine(e)}`));
      },
    },
    {
      id: "view.prevTab",
      title: "上一个标签",
      section: "视图",
      description: "切到标签栏里左边一个标签，循环切换",
      keywords: ["上一个标签", "切标签"],
      outcome: { kind: "none", hint: "按标签栏顺序循环" },
      defaultKey: "Mod-PageUp",
      hidden: true,
      run: () => tabSwitcher.switchTab(-1),
    },
    {
      id: "view.nextTab",
      title: "下一个标签",
      section: "视图",
      description: "切到标签栏里右边一个标签，循环切换",
      keywords: ["下一个标签", "切标签"],
      outcome: { kind: "none", hint: "按标签栏顺序循环" },
      defaultKey: "Mod-PageDown",
      hidden: true,
      run: () => tabSwitcher.switchTab(1),
    },
    {
      id: "view.toggleFullscreen",
      title: "全屏 / 退出全屏",
      section: "视图",
      description: "进入或退出全屏，只改窗口状态",
      keywords: ["全屏", "f11", "沉浸"],
      outcome: { kind: "none", hint: "只改窗口状态，不影响文件" },
      defaultKey: "F11",
      menu: "view",
      menuLabel: "全屏 / 退出全屏",
      menuOrder: 45,
      menuChecked: () => fullscreenOn,
      run: () => {
        const win = getCurrentWindow();
        void win
          .isFullscreen()
          .then(async (on) => {
            await win.setFullscreen(!on);
            fullscreenOn = !on;
          })
          .catch((e) => showMessage(`全屏切换失败：${firstLine(e)}`));
      },
    },
    // 重新加载界面：改完前端资源 / 需要干净重放会话时用；执行前 flush 会话与草稿
    {
      id: "view.reloadWindow",
      title: "重新加载界面（Reload Window）",
      section: "视图",
      description: "重新加载界面，用于改完前端资源或需要干净重放会话",
      keywords: ["重载界面", "刷新窗口", "reload"],
      outcome: { kind: "none", hint: "执行前会先保存会话与草稿；未保存的文档改动会提示" },
      defaultKey: "Mod-Shift-R",
      menu: "view",
      menuLabel: "重新加载界面",
      menuOrder: 80,
      menuSeparatorBefore: true,
      run: () => void reloadWindow(),
    },
    {
      id: "view.docStats",
      title: "文档统计（行 / 词 / 字符）",
      section: "视图",
      description: "统计当前文档的行数、词数与字符数",
      keywords: ["字数", "统计", "多少行", "字符数"],
      outcome: { kind: "view", hint: "结果显示在状态栏；大文件虚拟视图只统计行数" },
      menu: "view",
      menuLabel: "文档统计…",
      menuOrder: 70,
      menuSeparatorBefore: true,
      run: () => {
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
      },
    },
    {
      id: "view.messageHistory",
      title: "查看最近消息（状态栏历史）",
      section: "视图",
      description: "查看状态栏最近出现过的提示消息",
      keywords: ["消息历史", "错过的提示", "通知记录"],
      outcome: { kind: "view", hint: "消息按时间倒序列出；可复制文本，解决提示一闪而过" },
      menu: "view",
      menuLabel: "最近消息…",
      menuOrder: 72,
      run: () => showMessageHistory(),
    },
    {
      id: "view.sidebarOpen",
      title: "侧栏：打开的文件",
      section: "视图",
      description: "侧栏切到「打开的文件」列表",
      keywords: ["打开的文件", "侧栏文件列表"],
      outcome: { kind: "view", hint: "列出当前所有标签；点击切换，可关闭" },
      menu: "view",
      menuLabel: "侧栏：打开的文件",
      menuOrder: 15,
      menuSeparatorBefore: true,
      menuChecked: () => isSidebarViewOpen("open"),
      run: () => showSidebarView("open"),
    },
    {
      id: "view.sidebarGit",
      title: "侧栏：源代码管理",
      section: "视图",
      description: "打开左侧源代码管理侧栏，查看当前仓库的改动并逐块处理",
      keywords: ["源代码管理", "git 侧栏", "看改动", "提交"],
      outcome: { kind: "view", hint: "侧栏列出工作区改动；点文件打开差异，可暂存或放弃" },
      menu: "view",
      menuLabel: "侧栏：源代码管理",
      menuOrder: 17,
      menuChecked: () => isSidebarViewOpen("git"),
      run: () => showSidebarView("git"),
    },
    {
      id: "view.sidebarFiles",
      title: "侧栏：文件",
      section: "视图",
      description: "侧栏切到工作区文件树，以工作区为根",
      keywords: ["文件树", "目录", "项目文件"],
      outcome: { kind: "view", hint: "以工作区为根；未打开工作区时提示先打开目录" },
      menu: "view",
      menuLabel: "侧栏：文件",
      menuOrder: 20,
      menuChecked: () => isSidebarViewOpen("files"),
      run: () => showSidebarView("files"),
    },
    {
      id: "view.sidebarSearch",
      title: "侧栏：搜索",
      section: "视图",
      description: "侧栏切到搜索页，与「在文件中查找」同一面板",
      keywords: ["侧栏搜索", "全局搜索"],
      outcome: { kind: "view", hint: "与「在文件中查找」同一面板" },
      menu: "view",
      menuLabel: "侧栏：搜索",
      menuOrder: 22,
      menuChecked: () => isSidebarViewOpen("search"),
      run: () => showSidebarView("search"),
    },
    {
      id: "view.sidebarOutline",
      title: "侧栏：大纲",
      section: "视图",
      description: "侧栏切到大纲（标题 / 符号列表）",
      keywords: ["大纲", "outline", "结构"],
      outcome: { kind: "view", hint: "按语言解析结构；点击跳到对应位置" },
      menu: "view",
      menuLabel: "侧栏：大纲",
      menuOrder: 24,
      menuChecked: () => isSidebarViewOpen("outline"),
      run: () => showSidebarView("outline"),
    },
    {
      id: "view.sidebarBookmarks",
      title: "侧栏：书签",
      section: "视图",
      description: "侧栏切到书签列表，按文档分组显示",
      keywords: ["书签列表", "标记"],
      outcome: { kind: "view", hint: "按文档分组；点击跳到行，可在列表里删除" },
      menu: "view",
      menuLabel: "侧栏：书签",
      menuOrder: 26,
      menuChecked: () => isSidebarViewOpen("bookmarks"),
      run: () => showSidebarView("bookmarks"),
    },
    // 结构化只读视图（不改文件，只换一种看法）；再点同一模式即关闭
    {
      id: "view.structuredCsv",
      title: "以表格查看（CSV / TSV）",
      section: "视图",
      description: "把 CSV / TSV 渲染成只读表格，便于核对列",
      keywords: ["csv 表格", "看 csv", "表格视图", "tsv"],
      outcome: { kind: "view", hint: "只读视图，不改文件；再点一次回到文本" },
      menu: "view",
      menuLabel: "表格视图（CSV）",
      menuOrder: 60,
      menuSeparatorBefore: true,
      menuChecked: () => isStructuredViewOpen("csv"),
      run: () => showStructuredView("csv"),
    },
    {
      id: "view.structuredJson",
      title: "以树查看（JSON）",
      section: "视图",
      description: "把 JSON 渲染成可折叠的树，便于看层级",
      keywords: ["json 树", "层级查看", "折叠"],
      outcome: { kind: "view", hint: "只读视图，不改文件；再点一次回到文本" },
      menu: "view",
      menuLabel: "JSON 树视图",
      menuOrder: 62,
      menuChecked: () => isStructuredViewOpen("json"),
      run: () => showStructuredView("json"),
    },
    // ---- Git（独立顶级菜单：Git 是一等能力）----
    {
      id: "git.pull",
      title: "拉取（快进合并）",
      section: "Git",
      description: "从远程拉取当前分支并快进合并，不改写本地提交历史",
      keywords: ["git pull", "拉取", "同步远程", "更新代码"],
      outcome: { kind: "git", hint: "只做快进合并；分支已分叉时提示先处理，不会强推或重置" },
      menu: "git",
      menuLabel: "拉取（快进合并）",
      menuOrder: 10,
      run: () => gitPull(),
    },
    {
      id: "git.push",
      title: "推送",
      section: "Git",
      description: "把当前分支的本地提交推送到远程同名分支",
      keywords: ["git push", "推送", "上传代码", "同步到远程"],
      outcome: { kind: "git", hint: "推送的是已提交内容；未提交的改动不受影响" },
      menu: "git",
      menuLabel: "推送",
      menuOrder: 20,
      run: () => gitPush(),
    },
    {
      id: "git.pickBranch",
      title: "切换分支…",
      section: "Git",
      description: "列出本地分支并切换，切走前会先确认未保存的改动",
      keywords: ["切换分支", "git checkout", "git switch", "换分支"],
      outcome: { kind: "view", hint: "↑↓ 选择、Enter 切换；未保存的改动会提示先保存" },
      menu: "git",
      menuLabel: "切换分支…",
      menuOrder: 30,
      menuSeparatorBefore: true,
      run: () => gitPickBranch(),
    },
    {
      id: "git.showHistory",
      title: "Git：查看提交历史",
      section: "Git",
      description: "按时间查看当前工作区的提交记录，选中一条可看它改了哪些文件",
      keywords: ["git log", "查看改动记录", "看看谁改的", "提交历史"],
      outcome: { kind: "git", hint: "选中提交后右侧显示它与上一版的差异，可复制或导出 .patch", entry: "Git 菜单 · 源代码管理侧栏" },
      menu: "git",
      menuLabel: "查看提交历史…",
      menuOrder: 40,
      run: () => gitOpenHistory(),
    },
    {
      id: "diff.gitHead",
      title: "比较：与 Git HEAD",
      section: "Git",
      description: "把当前文件与 Git 里最后一次提交的版本对比，可导出 .patch",
      keywords: ["git diff", "和上次提交比", "看改了哪", "patch", "git apply", "发给别人", "留个底"],
      outcome: { kind: "git", hint: "对比结果只读，不修改文件；导出得到统一 diff 补丁，可用 git apply 应用" },
      menu: "git",
      menuLabel: "与 Git HEAD 比较",
      menuOrder: 50,
      menuSeparatorBefore: true,
      run: () => void diffService.diffWithGit("worktree"),
    },
    {
      id: "diff.gitIndex",
      title: "比较：与 Git 暂存区",
      section: "Git",
      description: "把当前文件已暂存的内容与最后一次提交对比，看即将提交什么",
      keywords: ["git diff --cached", "暂存区对比", "看暂存了什么", "HEAD", "暂存区补丁", "即将提交的 diff"],
      outcome: { kind: "git", hint: "对比对象是暂存区；不会改动暂存内容或工作区文件" },
      menu: "git",
      menuLabel: "与 Git 暂存区比较",
      menuOrder: 55,
      run: () => void diffService.diffWithGit("index"),
    },
    {
      id: "git.blameDialog",
      title: "Git：打开当前文件的 Blame 列表",
      section: "Git",
      description: "列出当前文件每一行的最后修改人与提交，定位问题引入点",
      keywords: ["blame", "谁改的", "最后一笔", "追查改动"],
      outcome: { kind: "view", hint: "列表按行号排列；点击可跳到该行，不修改文件" },
      menu: "git",
      menuLabel: "Blame 列表…",
      menuOrder: 60,
      menuSeparatorBefore: true,
      run: () => gitOpenBlame(),
    },
    {
      id: "git.inlineBlame",
      title: "切换行内 Git Blame（跟随光标）",
      section: "Git",
      description: "在光标所在行末尾显示最后一次提交的作者与时间，随光标移动",
      keywords: ["行内 blame", "看这一行谁改的", "当前行"],
      outcome: { kind: "none", hint: "只加行尾提示，不写文件；再点一次关闭" },
      menu: "git",
      menuLabel: "行内 Git Blame",
      menuOrder: 65,
      menuChecked: () => gitInlineBlameEnabled(),
      run: () => gitToggleInlineBlame(),
    },
    {
      id: "git.toggleReadOnly",
      title: "Git 只读模式（查看 / 可写切换）",
      section: "Git",
      description: "切换 Git 只读模式：只查看改动，避免误改正在用的仓库",
      keywords: ["只读", "保护仓库", "禁止提交", "误操作"],
      outcome: { kind: "none", hint: "只读时提交 / 暂存 / 放弃按钮禁用并说明原因" },
      menu: "git",
      menuLabel: "只读模式（切换）",
      menuOrder: 70,
      menuSeparatorBefore: true,
      run: () => gitToggleReadOnly(),
    },
    // ---- 帮助菜单（文档随安装包打包，离线可用；速查/关于/诊断统一归这里）----
    {
      id: "help.guide",
      title: "用户指南",
      section: "帮助",
      description: "打开内置用户指南，按功能说明操作步骤",
      keywords: ["用户指南", "说明书", "怎么用", "帮助文档"],
      outcome: { kind: "view", hint: "指南随安装包内置，离线可查；可在其中搜功能名" },
      menu: "help",
      menuLabel: "用户指南",
      menuOrder: 10,
      run: () => showHelpDialog("guide"),
    },
    {
      id: "help.faq",
      title: "常见问题（FAQ）",
      section: "帮助",
      description: "打开常见问题，查快捷键 / 编码 / Git 等高频疑问",
      keywords: ["faq", "常见问题", "疑问", "为什么"],
      outcome: { kind: "view", hint: "按主题分组；没有答案时可在「帮助 → 导出诊断包」反馈" },
      menu: "help",
      menuLabel: "常见问题（FAQ）",
      menuOrder: 20,
      run: () => showHelpDialog("faq"),
    },
    {
      id: "help.shortcuts",
      title: "快捷键速查",
      section: "帮助",
      description: "列出全部命令的当前键位，可搜索与改绑",
      keywords: ["快捷键速查", "键位表", "快捷键是什么", "按键"],
      outcome: { kind: "view", hint: "显示的是当前生效键位（含改绑）；点条目可跳到改键" },
      menu: "help",
      menuLabel: "快捷键速查…",
      menuOrder: 30,
      menuSeparatorBefore: true,
      run: () => showShortcuts(),
    },
    {
      id: "help.about",
      title: "关于 my-editor",
      section: "帮助",
      description: "查看版本号、构建信息与第三方许可",
      keywords: ["关于", "版本号", "license", "构建信息"],
      outcome: { kind: "view", hint: "反馈问题时请附这里的版本号" },
      menu: "help",
      menuLabel: "关于…",
      menuOrder: 60,
      menuSeparatorBefore: true,
      run: () => showAbout(),
    },
    // ---- 纯菜单项（系统/CM6 内置行为，仅展示）----
    {
      id: "edit.undo",
      title: "撤销",
      section: "编辑",
      description: "撤销上一个编辑动作，撤销栈按标签独立",
      keywords: ["撤销", "ctrl+z", "回退"],
      outcome: { kind: "none", hint: "编辑器内置行为；撤销栈按标签独立" },
      defaultKey: "Mod-Z",
      fixed: true,
      menu: "edit",
      menuOrder: 10,
      hidden: true,
      run: () => void undo(getView()),
    },
    {
      id: "edit.redo",
      title: "重做",
      section: "编辑",
      description: "重做刚撤销的编辑动作，按标签独立",
      keywords: ["重做", "ctrl+shift+z", "恢复"],
      outcome: { kind: "none", hint: "编辑器内置行为" },
      defaultKey: "Mod-Shift-Z",
      fixed: true,
      menu: "edit",
      menuOrder: 20,
      hidden: true,
      run: () => void redo(getView()),
    },
    {
      id: "clipboard.cut",
      title: "剪切",
      section: "编辑",
      description: "剪切当前选区到系统剪贴板",
      keywords: ["剪切", "ctrl+x"],
      outcome: { kind: "clipboard", hint: "内容是系统剪贴板，可粘贴到其它应用；可撤销" },
      menu: "edit",
      menuLabel: "剪切",
      menuOrder: 30,
      menuShortcut: "Mod-X",
      menuSeparatorBefore: true,
      hidden: true,
      run: () => void copyFromEditor(getView(), true, showMessage),
    },
    {
      id: "clipboard.copy",
      title: "复制",
      section: "编辑",
      description: "复制当前选区到系统剪贴板",
      keywords: ["复制", "ctrl+c"],
      outcome: { kind: "clipboard", hint: "内容是系统剪贴板，可粘贴到其它应用" },
      menu: "edit",
      menuOrder: 40,
      menuShortcut: "Mod-C",
      hidden: true,
      run: () => void copyFromEditor(getView(), false, showMessage),
    },
    {
      id: "clipboard.paste",
      title: "粘贴",
      section: "编辑",
      description: "把系统剪贴板内容粘贴到光标处",
      keywords: ["粘贴", "ctrl+v"],
      outcome: { kind: "none", hint: "写入编辑器，可撤销；图片粘贴见「插入剪贴板图片」" },
      menu: "edit",
      menuOrder: 50,
      menuShortcut: "Mod-V",
      hidden: true,
      run: () => void pasteIntoEditor(getView(), showMessage),
    },
    {
      id: "select.all",
      title: "全选",
      section: "选择",
      description: "选中当前文档的全部内容，只改选区",
      keywords: ["全选", "ctrl+a"],
      outcome: { kind: "none", hint: "只改选区，不改内容" },
      menu: "select",
      menuOrder: 10,
      menuShortcut: "Mod-A",
      hidden: true,
      run: () => {
        const view = getView();
        const len = view.state.doc.length;
        view.dispatch({ selection: { anchor: 0, head: len } });
      },
    },
    // ---- 以下为编辑器内置（CM6）绑定，仅展示不可重绑 ----
    {
      id: "edit.comment",
      title: "切换注释",
      section: "编辑",
      description: "切换当前行或选区的行注释",
      keywords: ["注释", "ctrl+/", "取消注释"],
      outcome: { kind: "none", hint: "按语言选择注释符号；可撤销" },
      defaultKey: "Mod-/",
      fixed: true,
      hidden: true,
      run: () => {},
    },
    {
      id: "edit.deleteLine",
      title: "删除当前行",
      section: "编辑",
      description: "删除光标所在的整行，编辑器内置行为",
      keywords: ["删除行", "删掉这一行", "ctrl+d"],
      outcome: { kind: "none", hint: "编辑器内置行为，可撤销；有选区时删除选区覆盖的行" },
      defaultKey: "Mod-D",
      fixed: true,
      hidden: true,
      run: () => {},
    },
    {
      id: "edit.copyLineUp",
      title: "复制行到上方",
      section: "编辑",
      description: "把当前行复制一份到上方，编辑器内置行为",
      keywords: ["复制行", "向上复制", "alt+shift+up"],
      outcome: { kind: "none", hint: "编辑器内置行为，可撤销" },
      defaultKey: "Mod-Alt-Up",
      fixed: true,
      hidden: true,
      run: () => {},
    },
    {
      id: "edit.copyLineDown",
      title: "复制行到下方",
      section: "编辑",
      description: "把当前行复制一份到下方，编辑器内置行为",
      keywords: ["复制行", "向下复制", "alt+shift+down"],
      outcome: { kind: "none", hint: "编辑器内置行为，可撤销" },
      defaultKey: "Mod-Alt-Down",
      fixed: true,
      hidden: true,
      run: () => {},
    },
    {
      id: "edit.moveLineUp",
      title: "上移当前行",
      section: "编辑",
      description: "把当前行或选中行整体上移一行",
      keywords: ["上移行", "调整行序", "alt+up"],
      outcome: { kind: "none", hint: "编辑器内置行为，可撤销" },
      defaultKey: "Alt-Up",
      fixed: true,
      hidden: true,
      run: () => {},
    },
    {
      id: "edit.moveLineDown",
      title: "下移当前行",
      section: "编辑",
      description: "把当前行或选中行整体下移一行",
      keywords: ["下移行", "调整行序", "alt+down"],
      outcome: { kind: "none", hint: "编辑器内置行为，可撤销" },
      defaultKey: "Alt-Down",
      fixed: true,
      hidden: true,
      run: () => {},
    },
  ];
}
