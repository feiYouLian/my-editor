/**
 * 编辑器右键菜单内容构建器（从 main.ts 迁出）。
 *
 * 菜单机器（子菜单 / 定位 / 关闭）在 ui/editorMenu.ts；本模块只决定
 * "显示哪些条目、点了做什么"。可见性依赖只读 / 选区 / 语言等领域状态，
 * 跨宿主动作（运行、转换、差异）经 Deps 注入，避免 app 模块互相 import。
 */

import type { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { foldAll, unfoldAll } from "@codemirror/language";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { applyLineOp, type LineOp } from "../editor/lineOps";
import { getConfig } from "../config/settings";
import { type Tab } from "../store/tabs";
import type { MenuEntry } from "../ui/editorMenu";
import { copyFromEditor, pasteIntoEditor } from "../editor/clipboard";
import { gotoBookmark, toggleBookmark } from "../editor/bookmarks";
import { openColumnEditor } from "../editor/columnEditor";
import { effectiveLanguage } from "../editor/languages";
import { supportsFormatting } from "../editor/format";
import { CASE_LABELS, type CaseMode } from "../editor/transforms";
import { localStamps, newUuid } from "../core/stamps";
import { CONVERT_TARGET_LABELS, type ConvertTarget } from "../core/convert";

/** 格式转换目标（按源格式分组：JSON / YAML / Properties / Java） */
const CONVERT_TARGETS: ConvertTarget[] = [
  "json2yaml",
  "json2java",
  "yaml2json",
  "yaml2properties",
  "properties2yaml",
  "java2json",
];

/** 右键菜单用到的运行宿主能力（结构类型，不 import app/runHost） */
export interface MenuRunHost {
  runnerFor: (tab: Tab) => string | null;
  looksLikeCurlScript: () => boolean;
  isRunning: boolean;
  runCurrentFile: () => void;
  runInTerminal: () => void;
  stop: () => void;
  runCurlScript: () => void;
  runCurlInTerminal: () => void;
  runJson: (minify: boolean) => void;
  runWrap: (marker: string, label: string) => void;
  toggleTableDialog: () => void;
  openConvertPanel: () => void;
  convertDirect: (target: ConvertTarget) => Promise<void>;
  runCase: (mode: CaseMode) => void;
}

export interface EditorMenuDeps {
  getView: () => EditorView;
  getActiveTab: () => Tab | null;
  showMessage: (text: string) => void;
  insertAtCursor: (text: string) => void;
  openFind: () => void;
  openReplace: () => void;
  toggleResults: () => void;
  /** 文档级格式化（FormatHost） */
  formatDocument: () => void;
  /** 选中级格式化（FormatHost） */
  formatSelection: () => void;
  insertClipboardImage: () => void;
  diffUnsaved: () => void;
  runHost: MenuRunHost;
}

export function buildEditorMenu(deps: EditorMenuDeps): MenuEntry[] {
  const view = deps.getView();
  const readonly = view.state.readOnly;
  const tab = deps.getActiveTab();
  const lang = tab ? effectiveLanguage(tab) : null;
  const hasSelection = !view.state.selection.main.empty;
  const canFormat = supportsFormatting(lang);
  const canRun =
    tab !== null &&
    tab.kind === "text" &&
    Boolean(tab.path) &&
    deps.runHost.runnerFor(tab) !== null;
  // cURL 入口只在当前选区/文档确实像 curl 命令时出现（避免 Python 等文件误显）
  const canScript = deps.runHost.looksLikeCurlScript();
  const cut = (): void => void copyFromEditor(view, true, deps.showMessage);
  const copy = (): void => void copyFromEditor(view, false, deps.showMessage);
  const paste = (): void => void pasteIntoEditor(view, deps.showMessage);

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
    { label: "查找…", shortcut: "Ctrl+F", run: () => deps.openFind() },
  ];
  if (!readonly) find.push({ label: "替换…", shortcut: "Ctrl+H", run: () => deps.openReplace() });
  find.push({ label: "查找结果面板", run: () => deps.toggleResults() });
  if (!readonly) {
    find.push({ separator: true });
    find.push({ label: "切换书签", shortcut: "Ctrl+F2", run: () => toggleBookmark(view) });
    find.push({ label: "下一个书签", shortcut: "F2", run: () => gotoBookmark(view, 1) });
  }
  if (!readonly && hasSelection) {
    find.push({ separator: true });
    find.push({
      label: "选中下一个相同词",
      shortcut: "Ctrl+Alt+D",
      run: () => selectNextOccurrence(view),
    });
    find.push({
      label: "选中全部相同词",
      shortcut: "Ctrl+Alt+Shift+D",
      run: () => selectSelectionMatches(view),
    });
  }
  top.push({ separator: true });
  top.push({ label: "查找与书签", submenu: find });

  // 代码：格式化 / 运行 / 列编辑
  const code: MenuEntry[] = [];
  if (!readonly && canFormat) {
    code.push({ label: "格式化文档", shortcut: "Shift+Alt+F", run: () => deps.formatDocument() });
    if (hasSelection) {
      code.push({ label: "格式化选中内容", run: () => deps.formatSelection() });
    }
  }
  if (canRun) {
    code.push({
      label: "运行当前文件",
      shortcut: "F5",
      run: () => deps.runHost.runCurrentFile(),
    });
  }
  if (canRun) {
    code.push({
      label: "在终端运行当前文件",
      shortcut: "Ctrl+F5",
      run: () => deps.runHost.runInTerminal(),
    });
  }
  if (deps.runHost.isRunning) {
    code.push({ label: "停止运行", run: () => deps.runHost.stop() });
  }
  if (canScript) {
    code.push({ label: "执行 cURL 脚本", run: () => deps.runHost.runCurlScript() });
  }
  if (canScript) {
    code.push({ label: "在终端执行 cURL 脚本", run: () => deps.runHost.runCurlInTerminal() });
  }
  if (!readonly) {
    if (code.length > 0) code.push({ separator: true });
    code.push({ label: "列编辑器", shortcut: "Alt+C", run: () => openColumnEditor(view) });
    code.push({ separator: true });
    code.push({ label: "折叠全部", shortcut: "Ctrl+Alt+[", run: () => { foldAll(view); } });
    code.push({ label: "展开全部", shortcut: "Ctrl+Alt+]", run: () => { unfoldAll(view); } });
  }
  if (code.length > 0) top.push({ label: "代码", submenu: code });

  // 语言专属：仅 JSON / Markdown
  if (!readonly && lang === "json") {
    top.push({
      label: "JSON",
      submenu: [
        { label: "JSON 美化", run: () => deps.runHost.runJson(false) },
        { label: "JSON 压缩", run: () => deps.runHost.runJson(true) },
      ],
    });
  } else if (!readonly && lang === "markdown") {
    top.push({
      label: "Markdown",
      submenu: [
        { label: "加粗", run: () => deps.runHost.runWrap("**", "加粗：") },
        { label: "斜体", run: () => deps.runHost.runWrap("*", "斜体：") },
        { label: "高亮", run: () => deps.runHost.runWrap("==", "高亮：") },
        { label: "插入表格…", run: () => deps.runHost.toggleTableDialog() },
      ],
    });
  }

  // 格式转换：面板始终可开（只读禁替换）；直转仅在可写时列出
  if (tab && tab.kind === "text" && !tab.virtual) {
    const convertItems: MenuEntry[] = [
      { label: "打开转换面板…", run: () => deps.runHost.openConvertPanel() },
    ];
    if (!readonly) {
      convertItems.push({ separator: true });
      for (const target of CONVERT_TARGETS) {
        convertItems.push({
          label: CONVERT_TARGET_LABELS[target],
          run: () => void deps.runHost.convertDirect(target),
        });
      }
    }
    top.push({ label: "格式转换", submenu: convertItems });
  }

  // 行操作：按"整行"语义，不需要用户先精确选中整行
  if (!readonly && tab && tab.kind === "text" && !tab.virtual) {
    const runLine = (op: LineOp): void => {
      deps.showMessage(applyLineOp(view, op, getConfig().tabSize).message);
    };
    top.push({
      label: "行操作",
      submenu: [
        { label: "按升序排序", run: () => runLine({ kind: "sort", options: {} }) },
        { label: "按降序排序", run: () => runLine({ kind: "sort", options: { desc: true } }) },
        { label: "按数字升序排序", run: () => runLine({ kind: "sort", options: { numeric: true } }) },
        { label: "去除重复行", run: () => runLine({ kind: "dedupe" }) },
        { label: "反转行序", run: () => runLine({ kind: "reverse" }) },
        { label: "删除空行", run: () => runLine({ kind: "removeEmpty" }) },
        { separator: true },
        { label: "删除行尾空白", run: () => runLine({ kind: "trimTrailing" }) },
        { label: "缩进：Tab 转空格", run: () => runLine({ kind: "indent", toSpaces: true }) },
        { label: "缩进：空格转 Tab", run: () => runLine({ kind: "indent", toSpaces: false }) },
      ],
    });
  }

  // 文本转换（子菜单，需选中文本）
  if (!readonly && hasSelection) {
    top.push({
      label: "文本转换",
      submenu: (Object.keys(CASE_LABELS) as CaseMode[]).map((mode) => ({
        label: CASE_LABELS[mode],
        run: () => deps.runHost.runCase(mode),
      })),
    });
  }

  // 插入（二级菜单）
  if (!readonly) {
    const insert: MenuEntry[] = [
      { label: "本地时间", run: () => deps.insertAtCursor(localStamps().local) },
      { label: "ISO 时间戳", run: () => deps.insertAtCursor(localStamps().iso) },
      { label: "Unix 时间戳", run: () => deps.insertAtCursor(localStamps().unix) },
      { label: "日期", run: () => deps.insertAtCursor(localStamps().date) },
      { label: "时间", run: () => deps.insertAtCursor(localStamps().time) },
      { label: "UUID（v4）", run: () => deps.insertAtCursor(newUuid()) },
    ];
    if (tab?.path) {
      insert.push({ separator: true });
      insert.push({ label: "剪贴板图片", run: () => deps.insertClipboardImage() });
    }
    top.push({ label: "插入", submenu: insert });
  }

  // 比较：仅有未保存改动时提供
  if (tab?.path && tab.dirty && !tab.virtual) {
    top.push({ separator: true });
    top.push({ label: "与磁盘内容比较（未保存改动）", run: () => deps.diffUnsaved() });
  }
  return top;
}
