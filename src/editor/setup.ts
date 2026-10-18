import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  type KeyBinding,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import {
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  deleteLine,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentUnit,
} from "@codemirror/language";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";

import { settings, type ColumnModifier } from "../config/settings";
import { editorTheme } from "./theme";
import { loadLanguage, languageKeyFromPath } from "./languages";
import { occurrences } from "./occurrences";
import { bookmarkGutter, bookmarkKeymap } from "./bookmarks";
import { openColumnEditor } from "./columnEditor";
import { searchExtensions } from "./search";

/**
 * 编辑器装配。
 * 适用范围：仅 <20MB 文档；≥20MB 或 .log 不进入编辑器。
 * 性能保护：>50000 行或存在 >2000 字符超长行时整篇降级纯文本。
 *
 * 配置驱动：所有受配置影响的扩展均置于 Compartment，
 * 配置载入/变更后调用 handle.applySettings() 热更新，无需重建编辑器。
 */

export interface EditorCallbacks {
  /** 文档内容变化（用户输入或撤销/重做） */
  onDocChange?: () => void;
  /** 光标位置变化 */
  onCursorChange?: (info: { line: number; col: number; totalLines: number }) => void;
  /** 高亮因性能保护被禁用时通知一次 */
  onHighlightDisabled?: (reason: "lines" | "longLine") => void;
}

export interface EditorHandle {
  view: EditorView;
  /** 加载文档内容并切换语言；重置 dirty 状态。readonly 为 true 时禁用编辑 */
  loadDocument: (path: string, content: string, readonly?: boolean) => Promise<void>;
  getContent: () => string;
  toggleWhitespace: () => void;
  /** 空白字符当前是否显示（状态栏体现用） */
  isWhitespaceOn: () => boolean;
  currentLanguage: () => string | null;
  /** 应用当前 settings 到编辑器（配置载入/热更新后调用） */
  applySettings: () => void;
}

function modifierActive(e: MouseEvent, key: ColumnModifier): boolean {
  switch (key) {
    case "Alt":
      return e.altKey;
    case "Control":
      return e.ctrlKey;
    case "Shift":
      return e.shiftKey;
    case "Meta":
      return e.metaKey;
  }
}

/** 是否存在超长行（简化实现：整篇降级，见文档 3.1 简化说明） */
function hasLongLine(state: EditorState): boolean {
  for (let i = 1; i <= state.doc.lines; i++) {
    if (state.doc.line(i).length > settings.longLineSkipChars) return true;
  }
  return false;
}

/** Home 双段跳转：第 1 次跳到行内首个非空白字符，第 2 次跳到行首 */
function smartHome(view: EditorView, select: boolean): boolean {
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.head);
  const firstNonSpace = line.text.search(/\S/);
  const indentPos = firstNonSpace < 0 ? line.from : line.from + firstNonSpace;
  const target = range.head === indentPos ? line.from : indentPos;
  view.dispatch({
    selection: select ? { anchor: range.anchor, head: target } : { anchor: target },
    scrollIntoView: true,
  });
  return true;
}

/** 行操作键位：先于 defaultKeymap，用于覆盖同键默认绑定 */
function lineEditKeys(): KeyBinding[] {
  return [
    { key: "Mod-d", preventDefault: true, run: deleteLine },
    { key: "Mod-Alt-ArrowUp", preventDefault: true, run: copyLineUp },
    { key: "Mod-Alt-ArrowDown", preventDefault: true, run: copyLineDown },
    { key: "Home", preventDefault: true, run: (v) => smartHome(v, false) },
    { key: "Shift-Home", preventDefault: true, run: (v) => smartHome(v, true) },
  ];
}

/** 键位表（列编辑器快捷键来自配置，需随 Compartment 热更新） */
function buildKeymap() {
  return keymap.of([
    indentWithTab,
    ...lineEditKeys(),
    ...defaultKeymap,
    ...historyKeymap,
    ...bookmarkKeymap,
    {
      key: settings.columnEditorKey,
      preventDefault: true,
      run: (v) => {
        // 只读文档不进入列编辑器（其编辑动作绕过 CM6 输入路径）
        if (v.state.readOnly) return true;
        openColumnEditor(v);
        return true;
      },
    },
  ]);
}

function indentationExtensions() {
  return [
    indentUnit.of(" ".repeat(settings.tabSize)),
    EditorState.tabSize.of(settings.tabSize),
  ];
}

function columnSelectionExtensions() {
  if (!settings.columnSelection) return [];
  return [
    rectangularSelection({
      eventFilter: (e) => modifierActive(e, settings.columnSelectionModifier),
    }),
    crosshairCursor({ key: settings.columnSelectionModifier }),
  ];
}

/** 只读态：readOnly 拦截文档变更事务，editable 关闭输入（含 IME 与粘贴） */
function readOnlyExtensions(readonly: boolean) {
  return [
    EditorState.readOnly.of(readonly),
    EditorView.editable.of(!readonly),
  ];
}

export function createEditor(parent: HTMLElement, callbacks: EditorCallbacks): EditorHandle {
  const languageCompartment = new Compartment();
  const whitespaceCompartment = new Compartment();
  const indentCompartment = new Compartment();
  const keymapCompartment = new Compartment();
  const bracketCompartment = new Compartment();
  const indentGuidesCompartment = new Compartment();
  const occurrenceCompartment = new Compartment();
  const columnSelectionCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  /** loadDocument 期间抑制 dirty 回调 */
  let loading = false;
  let languageKey: string | null = null;
  let whitespaceOn = settings.showWhitespace;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        // 列选择前提：允许多选区（rectangularSelection 来自 @codemirror/view 核心）
        EditorState.allowMultipleSelections.of(true),
        indentCompartment.of(indentationExtensions()),
        keymapCompartment.of(buildKeymap()),
        bracketCompartment.of(settings.bracketMatching ? bracketMatching() : []),
        indentGuidesCompartment.of(settings.indentGuides ? indentationMarkers() : []),
        columnSelectionCompartment.of(columnSelectionExtensions()),
        occurrenceCompartment.of(settings.occurrenceHighlight ? occurrences() : []),
        whitespaceCompartment.of(whitespaceOn ? highlightWhitespace() : []),
        readOnlyCompartment.of(readOnlyExtensions(false)),
        languageCompartment.of([]),
        ...bookmarkGutter,
        ...searchExtensions(),
        ...editorTheme,
        placeholder("打开文件开始编辑（Ctrl+S 保存）"),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !loading) {
            callbacks.onDocChange?.();
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            callbacks.onCursorChange?.({
              line: line.number,
              col: head - line.from + 1,
              totalLines: update.state.doc.lines,
            });
          }
        }),
      ],
    }),
  });

  async function loadDocument(
    path: string,
    content: string,
    readonly = false,
  ): Promise<void> {
    loading = true;
    try {
      // 只读态随文档切换重建（切换标签时读写状态可能不同）
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readonly)),
      });
      // 整篇替换文档内容
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        selection: { anchor: 0 },
      });

      // 语言切换（按扩展名；内置同步、懒加载异步）
      languageKey = languageKeyFromPath(path);
      const support = languageKey ? await loadLanguage(languageKey) : null;

      // 性能保护：行数超限或存在超长行 → 降级纯文本
      const tooManyLines = view.state.doc.lines > settings.highlighterDisabledOver;
      const longLine = hasLongLine(view.state);
      if (tooManyLines || longLine) {
        view.dispatch({ effects: languageCompartment.reconfigure([]) });
        callbacks.onHighlightDisabled?.(tooManyLines ? "lines" : "longLine");
        return;
      }
      view.dispatch({
        effects: languageCompartment.reconfigure(support ? [support] : []),
      });
    } finally {
      loading = false;
    }
  }

  /** 配置热更新：将当前 settings 应用到编辑器各 Compartment */
  function applySettings(): void {
    whitespaceOn = settings.showWhitespace;
    view.dispatch({
      effects: [
        indentCompartment.reconfigure(indentationExtensions()),
        keymapCompartment.reconfigure(buildKeymap()),
        bracketCompartment.reconfigure(settings.bracketMatching ? bracketMatching() : []),
        indentGuidesCompartment.reconfigure(
          settings.indentGuides ? indentationMarkers() : [],
        ),
        columnSelectionCompartment.reconfigure(columnSelectionExtensions()),
        occurrenceCompartment.reconfigure(
          settings.occurrenceHighlight ? occurrences() : [],
        ),
        whitespaceCompartment.reconfigure(whitespaceOn ? highlightWhitespace() : []),
      ],
    });
  }

  return {
    view,
    loadDocument,
    getContent: () => view.state.doc.toString(),
    toggleWhitespace: () => {
      whitespaceOn = !whitespaceOn;
      view.dispatch({
        effects: whitespaceCompartment.reconfigure(whitespaceOn ? highlightWhitespace() : []),
      });
    },
    isWhitespaceOn: () => whitespaceOn,
    currentLanguage: () => languageKey,
    applySettings,
  };
}
