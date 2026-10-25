/**
 * 运行与工具面板宿主：Code Run（运行 / 停止 / 输出面板）、
 * Cron 解析、批量另存编码、正则测试器、Markdown 表格、最近打开、
 * 另存为编码对话框，以及文本变换入口（大小写 / JSON / 包裹）。
 *
 * 面板实例收在本宿主（原散落在 main.ts 装配区）；编辑器操作
 * （transforms / markdownTools）直接依赖 editor 层。
 */

import type { EditorView } from "@codemirror/view";
import { getConfig } from "../config/settings";
import { tabStore, type Tab } from "../store/tabs";
import { CronPanel } from "../panels/cronPanel";
import { BatchEncodingPanel } from "../panels/batchEncoding";
import { RegexTesterPanel } from "../panels/regexTester";
import { MarkdownTableDialog } from "../panels/tableDialog";
import { RecentFilesDialog } from "../panels/recentFiles";
import { SaveEncodingDialog } from "../panels/saveEncoding";
import { RunPanel } from "../panels/runPanel";
import { applyCase, applyJson, CASE_LABELS, type CaseMode } from "../editor/transforms";
import { insertTable, toggleWrap } from "../editor/markdownTools";
import { effectiveLanguage } from "../editor/languages";
import { ConvertPanel, type ConvertSource } from "../panels/convertPanel";
import {
  CONVERT_TARGET_LABELS,
  convert,
  detectFormat,
  parseJsonText,
  targetExtension,
  targetLanguage,
  type ConvertFormat,
  type ConvertKind,
  type ConvertTarget,
} from "../core/convert";
import { jsonToJava } from "../core/convertCodegen";
import { confirmAction } from "../ui/dialogs";
import { dirnameOf } from "../core/paths";
import { looksLikeCurlScript as isCurlScriptText } from "../core/curlScript";

export interface RunHostDeps {
  getActiveTab: () => Tab | null;
  blockIfReadonly: () => boolean;
  showMessage: (text: string) => void;
  getView: () => EditorView;
  /** 打开文件（最近打开列表用；含大文件分流） */
  onOpenFile: (path: string) => void;
  /** 把转换 / 代码生成结果插入为新的未命名标签 */
  insertAsTab: (text: string, name: string, language: string) => void;
  /** 在终端运行当前文件（由 main 注入 TerminalHost） */
  runInTerminal: (path: string, runner: string) => void;
  /** 在终端执行 cURL 脚本文本 */
  runCurlInTerminal: (script: string) => void;
  /** 打开运行输出中的文件位置（堆栈点击跳转） */
  onOpenLocation: (path: string, line: number) => void;
  /** 输出面板即将显示（用于隐藏终端，避免底部区域被两个面板挤满） */
  onBeforeRun?: () => void;
}

export class RunHost {
  private readonly cronPanel = new CronPanel();
  private readonly batchEncodingPanel = new BatchEncodingPanel();
  private readonly regexTester = new RegexTesterPanel();
  private readonly saveEncodingDialog = new SaveEncodingDialog();
  private runActive = false;

  private readonly tableDialog: MarkdownTableDialog;
  private readonly recentFiles: RecentFilesDialog;
  private readonly runPanel: RunPanel;
  private readonly convertPanel: ConvertPanel;

  /** 转换替换前确认行数（与格式化一致） */
  private static readonly CONVERT_CONFIRM_LINES = 10000;

  constructor(
    private runBtn: HTMLButtonElement,
    private deps: RunHostDeps,
  ) {
    // Markdown 表格对话框：确认后在光标处插入表格
    this.tableDialog = new MarkdownTableDialog((cols, rows) => {
      if (!deps.getActiveTab() || deps.blockIfReadonly()) return;
      const result = insertTable(deps.getView(), cols, rows);
      deps.showMessage(result.message);
    });

    // 最近打开：点击后走统一的打开流程（含大文件分流）
    this.recentFiles = new RecentFilesDialog((path) => deps.onOpenFile(path));

    // Code Run 输出面板（按语言分类、堆栈位置可点击）
    this.runPanel = new RunPanel(
      document.getElementById("run-output")!,
      () => {
        this.runActive = this.runPanel.isRunning;
        this.refreshRunButton();
      },
      (path, line) => deps.onOpenLocation(path, line),
    );
    this.runPanel.mount();

    // 格式转换面板：写回编辑器 / 插入新标签经 deps 注入（panels 不反向依赖 app）
    this.convertPanel = new ConvertPanel({
      replace: (text, source) => this.replaceConverted(text, source),
      insertAsTab: (text, target) =>
        deps.insertAsTab(text, `转换结果${targetExtension(target)}`, targetLanguage(target)),
      showMessage: deps.showMessage,
    });

    // 标签栏右侧的运行快捷按钮：运行 / 停止切换
    runBtn.addEventListener("click", () => {
      if (this.runActive) this.runPanel.stop();
      else this.runCurrentFile();
    });
  }

  /** 标签栏右侧的运行快捷按钮状态 */
  refreshRunButton(): void {
    if (this.runActive) {
      this.runBtn.disabled = false;
      this.runBtn.classList.add("running");
      this.runBtn.textContent = "■ 停止";
      this.runBtn.title = "停止运行（F5）";
      return;
    }
    const tab = this.deps.getActiveTab();
    const canRun =
      tab !== null &&
      tab.kind === "text" &&
      !!tab.path &&
      !tab.virtual &&
      this.runnerFor(tab) !== null;
    this.runBtn.classList.remove("running");
    this.runBtn.textContent = "▶ 运行";
    this.runBtn.disabled = !canRun || tab?.dirty === true;
    this.runBtn.title = !canRun
      ? "当前文件不支持运行（支持 Python / JS / Java / cURL，且需已保存为磁盘文件）"
      : tab?.dirty
        ? "有未保存改动：运行时执行的是磁盘内容，请先保存（Ctrl+S）"
        : `运行 ${tab?.name ?? ""}（F5）`;
  }

  /** 按生效语言选择 Code Run 运行器（仅 Python / Node / Java / cURL） */
  runnerFor(tab: Tab): string | null {
    const lang = effectiveLanguage(tab);
    if (lang === "python") return "python";
    if (lang === "javascript" || lang === "jsx") return "node";
    if (lang === "java") return "java";
    // cURL 脚本：只看第一个有意义行（兼容 curl / curl.exe / PowerShell & 'curl'）
    // 只取前 4KB：本函数每次输入都会调用，对全文扫描太贵（惰性快照下走 O(4KB) 头部读取）
    const head = tabStore.contentHeadOf(tab, 4096);
    if (isCurlScriptText(head)) return "curl";
    return null;
  }

  /** 运行当前文件（执行的是磁盘内容，故要求无未保存改动） */
  runCurrentFile(): void {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text" || !tab.path) {
      this.deps.showMessage("请先保存为磁盘文件再运行");
      return;
    }
    if (tab.virtual) {
      this.deps.showMessage("大文件只读视图不支持运行");
      return;
    }
    if (tab.dirty) {
      this.deps.showMessage("有未保存改动：运行时执行的是磁盘内容，请先保存（Ctrl+S）");
      return;
    }
    const runner = this.runnerFor(tab);
    if (!runner) {
      this.deps.showMessage("当前语言不支持运行（支持 Python / JS / Java / cURL）");
      return;
    }
    this.deps.onBeforeRun?.();
    void this.runPanel.start(tab.path, runner, dirnameOf(tab.path));
  }

  /** 在终端运行当前文件（保存 / 脏检查与 F5 一致） */
  runInTerminal(): void {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text" || !tab.path) {
      this.deps.showMessage("请先保存为磁盘文件再运行");
      return;
    }
    if (tab.virtual) {
      this.deps.showMessage("大文件只读视图不支持运行");
      return;
    }
    if (tab.dirty) {
      this.deps.showMessage("有未保存改动：终端运行的是磁盘内容，请先保存（Ctrl+S）");
      return;
    }
    const runner = this.runnerFor(tab);
    if (!runner) {
      this.deps.showMessage("当前语言不支持运行（支持 Python / JS / Java / cURL）");
      return;
    }
    this.deps.runInTerminal(tab.path, runner);
  }

  /** 停止运行 */
  stop(): void {
    this.runPanel.stop();
  }

  /**
   * 执行 cURL 脚本：选区优先，无选区则整篇。
   * 不要求先保存 / 不要求无未保存改动（执行的是编辑区文本）；
   * 只读也允许（执行不修改文档，与文本变换不同）。
   */
  runCurlScript(): void {
    const script = this.readCurlScript();
    if (!script) return;
    this.deps.onBeforeRun?.();
    void this.runPanel.startScript("curl", script);
  }

  /** 在终端执行 cURL 脚本（选区优先，无选区整篇） */
  runCurlInTerminal(): void {
    const script = this.readCurlScript();
    if (!script) return;
    this.deps.runCurlInTerminal(script);
  }

  /** 当前选区（优先）或整篇是否像 cURL 命令：右键菜单显隐用，不提示。
   *  无选区时只读文档头部（与 runnerFor 同口径）：右键菜单每次打开都会调用，
   *  对 20MB 文档做全文 toString 代价过高。 */
  looksLikeCurlScript(): boolean {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text" || tab.virtual) return false;
    const view = this.deps.getView();
    const sel = view.state.selection.main;
    const text = sel.empty
      ? tabStore.contentHeadOf(tab, 4096)
      : view.state.sliceDoc(sel.from, sel.to);
    return isCurlScriptText(text);
  }

  /** 读取并校验 cURL 脚本文本（选区优先）；不合法时提示并返回 null */
  private readCurlScript(): string | null {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text") {
      this.deps.showMessage("请先打开一个文本文件");
      return null;
    }
    if (tab.virtual) {
      this.deps.showMessage("大文件只读视图不支持执行脚本");
      return null;
    }
    const view = this.deps.getView();
    const sel = view.state.selection.main;
    const script = sel.empty
      ? view.state.doc.toString()
      : view.state.sliceDoc(sel.from, sel.to);
    if (!script.trim()) {
      this.deps.showMessage("没有可执行的 cURL 脚本（先输入或选中一段 curl 命令）");
      return null;
    }
    if (!isCurlScriptText(script)) {
      this.deps.showMessage(
        "当前内容不是 cURL 命令（应以 curl 开头，支持 PowerShell 的 & 'curl' 写法）",
      );
      return null;
    }
    return script;
  }

  /** 隐藏输出面板（终端打开时调用，保留输出与运行状态） */
  hideOutputPanel(): void {
    this.runPanel.hide();
  }

  /** 重新显示上一次运行输出 */
  showOutputPanel(): void {
    if (!this.runPanel.hasContent) {
      this.deps.showMessage("还没有运行输出（F5 运行当前文件）");
      return;
    }
    this.runPanel.show();
  }

  /** 是否有任务在跑（右键菜单 / 状态栏用） */
  get isRunning(): boolean {
    return this.runActive;
  }

  toggleCron(): void {
    this.cronPanel.toggle();
  }

  toggleBatchEncoding(): void {
    this.batchEncodingPanel.toggle();
  }

  toggleRegexTester(): void {
    this.regexTester.toggle();
  }

  toggleRecentFiles(): void {
    this.recentFiles.toggle();
  }

  toggleTableDialog(): void {
    this.tableDialog.toggle();
  }

  /** 打开「另存为指定编码」对话框（fileService 经此委托） */
  pickEncoding(
    encodings: string[],
    current: string,
    onPick: (encoding: string) => void,
    note: string,
  ): void {
    this.saveEncodingDialog.open(encodings, current, onPick, note);
  }

  /** Markdown 选中包裹切换（加粗 / 斜体 / 高亮） */
  runWrap(marker: string, label: string): void {
    if (!this.deps.getActiveTab() || this.deps.blockIfReadonly()) return;
    const result = toggleWrap(this.deps.getView(), marker);
    this.deps.showMessage(result.ok ? `${label}${result.message}` : result.message);
  }

  /** 文本变换入口：只读拦截 + 结果提示 */
  runCase(mode: CaseMode): void {
    if (!this.deps.getActiveTab() || this.deps.blockIfReadonly()) return;
    const result = applyCase(this.deps.getView(), mode);
    this.deps.showMessage(result.message);
  }

  runJson(minify: boolean): void {
    if (!this.deps.getActiveTab() || this.deps.blockIfReadonly()) return;
    const cfg = getConfig();
    const indent = cfg.insertSpaces ? " ".repeat(cfg.tabSize) : "\t";
    const result = applyJson(this.deps.getView(), minify, indent);
    this.deps.showMessage(result.message);
  }

  /** 打开格式转换面板（选区优先，无选区整篇） */
  openConvertPanel(): void {
    const source = this.captureConvertSource();
    if (source) this.convertPanel.open(source);
  }

  /** 命令面板直转：跳过面板，直接替换选区/整篇 */
  async convertDirect(target: ConvertTarget): Promise<void> {
    const source = this.captureConvertSource();
    if (!source) return;
    if (source.readonly) {
      this.deps.showMessage("只读文件不可替换（可用「格式转换」面板预览后复制）");
      return;
    }
    // 目标名前缀即源格式（json2java → json，yaml2json → yaml，java2json → java）
    const required = target.slice(0, target.indexOf("2")) as ConvertFormat;
    const detected = detectFormat(source.text);
    if (detected && detected !== required) {
      this.deps.showMessage(
        `当前内容识别为 ${detected.toUpperCase()}，不是 ${required.toUpperCase()}；请用「格式转换」面板指定源格式`,
      );
      return;
    }
    if (source.lineCount > RunHost.CONVERT_CONFIRM_LINES) {
      const ok = await confirmAction(
        `文档超过 ${RunHost.CONVERT_CONFIRM_LINES} 行，转换可能耗时较久，继续？`,
      );
      if (!ok) return;
    }
    try {
      let result: string;
      if (target === "json2java") {
        result = jsonToJava(parseJsonText(source.text), {
          className: "Root",
          javaStyle: "class",
          javaLombok: false,
        });
      } else {
        result = await convert(source.text, target as ConvertKind, {});
      }
      if (this.replaceConverted(result, source)) {
        this.deps.showMessage(`已替换为 ${CONVERT_TARGET_LABELS[target]}（Ctrl+Z 可撤销）`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.showMessage(message.split("\n")[0] || "转换失败");
    }
  }

  /** 采集当前转换源：选区优先，无选区整篇；不可转换时提示并返回 null */
  private captureConvertSource(): ConvertSource | null {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text") {
      this.deps.showMessage("请先打开一个文本文件");
      return null;
    }
    if (tab.virtual) {
      this.deps.showMessage("大文件只读视图不支持格式转换");
      return null;
    }
    const view = this.deps.getView();
    const sel = view.state.selection.main;
    const hasSelection = !sel.empty;
    return {
      text: hasSelection ? view.state.sliceDoc(sel.from, sel.to) : view.state.doc.toString(),
      from: hasSelection ? sel.from : 0,
      to: hasSelection ? sel.to : view.state.doc.length,
      hasSelection,
      readonly: tab.readonly,
      lineCount: view.state.doc.lines,
      tabId: tab.id,
    };
  }

  /** 写回转换结果（整体替换选区或整篇） */
  private replaceConverted(text: string, source: ConvertSource): boolean {
    if (this.deps.getActiveTab()?.id !== source.tabId) {
      this.deps.showMessage("标签已切换，转换结果未应用");
      return false;
    }
    if (this.deps.blockIfReadonly()) return false;
    const view = this.deps.getView();
    if (
      source.to > view.state.doc.length ||
      view.state.sliceDoc(source.from, source.to) !== source.text
    ) {
      // 仅比较长度不够：异长编辑后长度可能恰好相等，会覆盖用户新输入的内容
      this.deps.showMessage("文档已变化，转换结果未应用");
      return false;
    }
    view.dispatch({
      changes: { from: source.from, to: source.to, insert: text },
      selection: { anchor: source.from + text.length },
      scrollIntoView: true,
    });
    return true;
  }

  /** 大小写模式清单（命令注册表展开用） */
  static caseModes(): CaseMode[] {
    return Object.keys(CASE_LABELS) as CaseMode[];
  }

  /** 大小写模式展示名 */
  static caseLabel(mode: CaseMode): string {
    return CASE_LABELS[mode];
  }
}
