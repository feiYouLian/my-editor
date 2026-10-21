import { Compartment, EditorState, type Extension, type StateEffect } from "@codemirror/state";
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
import { editorThemeFor } from "./theme";
import { loadLanguage, languageKeyFromPath } from "./languages";
import { occurrences } from "./occurrences";
import { rainbowBrackets } from "./rainbowBrackets";
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
  /**
   * 加载 / 激活文档。docId 为标签的稳定标识：
   * 同一 docId 且内容未变时恢复该标签缓存的状态（保留撤销历史与光标），
   * 内容变化或首次打开时重建状态。
   */
  loadDocument: (
    path: string,
    content: string,
    readonly?: boolean,
    languageOverride?: string | null,
    docId?: string,
  ) => Promise<void>;
  /** 关闭标签后丢弃其缓存状态 */
  forgetDocument: (docId: string) => void;
  getContent: () => string;
  /** 切换高亮语言（不重载内容）：undefined = 自动，null = 纯文本，字符串 = 指定语言键 */
  setLanguage: (override: string | null | undefined) => Promise<void>;
  toggleWhitespace: () => void;
  /** 空白字符当前是否显示（状态栏体现用） */
  isWhitespaceOn: () => boolean;
  /** 自动换行开关 */
  setWordWrap: (on: boolean) => void;
  currentLanguage: () => string | null;
  /** 跳转到指定行（1 基）并聚焦编辑器 */
  gotoLine: (line: number) => void;
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

/** 超长行扫描结果缓存：Text 不可变，同一份文档在同一阈值下只扫一次 */
const longLineCache = new WeakMap<object, { limit: number; long: boolean }>();

/** 是否存在超长行（简化实现：整篇降级，见文档 3.1 简化说明） */
function hasLongLine(state: EditorState): boolean {
  const limit = settings.longLineSkipChars;
  const cached = longLineCache.get(state.doc);
  if (cached && cached.limit === limit) return cached.long;
  let found = false;
  for (let i = 1; i <= state.doc.lines; i++) {
    if (state.doc.line(i).length > limit) {
      found = true;
      break;
    }
  }
  longLineCache.set(state.doc, { limit, long: found });
  return found;
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
    indentUnit.of(settings.insertSpaces ? " ".repeat(settings.tabSize) : "\t"),
    EditorState.tabSize.of(settings.tabSize),
  ];
}

/** 编辑器主题扩展（语法主题 + 字号，随配置热更新） */
function themeExtensions() {
  return editorThemeFor(settings.editorTheme, settings.editorFontSize);
}

/** 行号 / 活动行高亮（layout 配置可开关） */
function chromeExtensions() {
  const exts: Extension[] = [];
  if (settings.showLineNumbers) exts.push(lineNumbers());
  if (settings.showActiveLine) exts.push(highlightActiveLine(), highlightActiveLineGutter());
  return exts;
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
  const rainbowBracketsCompartment = new Compartment();
  const indentGuidesCompartment = new Compartment();
  const occurrenceCompartment = new Compartment();
  const columnSelectionCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const chromeCompartment = new Compartment();
  const wrapCompartment = new Compartment();

  /** loadDocument 期间抑制 dirty 回调 */
  let loading = false;
  let languageKey: string | null = null;
  let currentPath = "";
  let whitespaceOn = settings.showWhitespace;
  let wordWrapOn = settings.wordWrap;
  /** 当前生效的只读态（切换标签时随文档恢复） */
  let currentReadonly = false;

  /** 每标签独立的编辑状态：恢复时保住各自的撤销历史 / 光标，避免跨标签串台 */
  interface CachedState {
    state: EditorState;
    /** 缓存时的配置代数：代数一致说明无需重新配置扩展 */
    generation: number;
    /** 该状态实际生效的高亮语言（null = 纯文本 / 被性能保护禁用） */
    langKey: string | null;
    readonly: boolean;
  }
  const stateCache = new Map<string, CachedState>();
  const STATE_CACHE_LIMIT = 16;
  const STATE_CACHE_MAX_BYTES = 5 * 1024 * 1024;
  let activeDocKey: string | null = null;
  /** 配置（含空白 / 换行等开关）每次变更 +1，用于判断缓存状态是否过期 */
  let configGeneration = 0;

  function baseExtensions(): Extension[] {
    return [
      chromeCompartment.of(chromeExtensions()),
      drawSelection(),
      history(),
      // 列选择前提：允许多选区（rectangularSelection 来自 @codemirror/view 核心）
      EditorState.allowMultipleSelections.of(true),
      indentCompartment.of(indentationExtensions()),
      keymapCompartment.of(buildKeymap()),
      bracketCompartment.of(settings.bracketMatching ? bracketMatching() : []),
      rainbowBracketsCompartment.of(settings.rainbowBrackets ? rainbowBrackets() : []),
      indentGuidesCompartment.of(settings.indentGuides ? indentationMarkers() : []),
      columnSelectionCompartment.of(columnSelectionExtensions()),
      occurrenceCompartment.of(settings.occurrenceHighlight ? occurrences() : []),
      whitespaceCompartment.of(whitespaceOn ? highlightWhitespace() : []),
      wrapCompartment.of(wordWrapOn ? EditorView.lineWrapping : []),
      readOnlyCompartment.of(readOnlyExtensions(currentReadonly)),
      languageCompartment.of([]),
      themeCompartment.of(themeExtensions()),
      ...bookmarkGutter,
      ...searchExtensions(),
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
    ];
  }

  function createState(doc: string): EditorState {
    return EditorState.create({ doc, extensions: baseExtensions() });
  }

  /** 受配置影响的扩展：配置热更新与标签状态恢复时统一重配 */
  function dynamicEffects(): StateEffect<unknown>[] {
    return [
      chromeCompartment.reconfigure(chromeExtensions()),
      indentCompartment.reconfigure(indentationExtensions()),
      keymapCompartment.reconfigure(buildKeymap()),
      bracketCompartment.reconfigure(settings.bracketMatching ? bracketMatching() : []),
      rainbowBracketsCompartment.reconfigure(
        settings.rainbowBrackets ? rainbowBrackets() : [],
      ),
      indentGuidesCompartment.reconfigure(settings.indentGuides ? indentationMarkers() : []),
      columnSelectionCompartment.reconfigure(columnSelectionExtensions()),
      occurrenceCompartment.reconfigure(settings.occurrenceHighlight ? occurrences() : []),
      whitespaceCompartment.reconfigure(whitespaceOn ? highlightWhitespace() : []),
      wrapCompartment.reconfigure(wordWrapOn ? EditorView.lineWrapping : []),
      readOnlyCompartment.reconfigure(readOnlyExtensions(currentReadonly)),
      themeCompartment.reconfigure(themeExtensions()),
    ];
  }

  /** 缓存当前状态；超大文档不缓存，避免多标签叠加占用内存 */
  function cacheActiveState(key: string): void {
    const state = view.state;
    if (state.doc.length > STATE_CACHE_MAX_BYTES) return;
    stateCache.delete(key);
    stateCache.set(key, {
      state,
      generation: configGeneration,
      langKey: languageKey,
      readonly: currentReadonly,
    });
    while (stateCache.size > STATE_CACHE_LIMIT) {
      const oldest = stateCache.keys().next().value;
      if (oldest === undefined) break;
      stateCache.delete(oldest);
    }
  }

  const view = new EditorView({ parent, state: createState("") });

  /**
   * 应用高亮语言。
   * override：undefined = 按当前文件扩展名自动；null = 纯文本；字符串 = 指定语言键。
   * 性能保护（行数超限 / 超长行）优先于语言加载，命中时整篇降级纯文本。
   */
  async function applyLanguage(override: string | null | undefined): Promise<void> {
    const expectedKey = activeDocKey;
    const key = override === undefined ? languageKeyFromPath(currentPath) : override;
    languageKey = key;

    const tooManyLines = view.state.doc.lines > settings.highlighterDisabledOver;
    // 行数已超限时无需再逐行扫描超长行
    const longLine = !tooManyLines && hasLongLine(view.state);
    if (tooManyLines || longLine) {
      languageKey = null; // 高亮被性能保护禁用，状态栏按纯文本展示
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      callbacks.onHighlightDisabled?.(tooManyLines ? "lines" : "longLine");
      return;
    }
    const support = key ? await loadLanguage(key) : null;
    // 语言包加载期间可能已切换标签：过期结果丢弃，避免作用到其它标签
    if (activeDocKey !== expectedKey) return;
    view.dispatch({ effects: languageCompartment.reconfigure(support ? [support] : []) });
  }

  /** 手动广播光标信息：setState 不触发 updateListener，切标签后状态栏需主动刷新 */
  function notifyCursor(state: EditorState): void {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    callbacks.onCursorChange?.({
      line: line.number,
      col: head - line.from + 1,
      totalLines: state.doc.lines,
    });
  }

  async function loadDocument(
    path: string,
    content: string,
    readonly = false,
    languageOverride?: string | null,
    docId?: string,
  ): Promise<void> {
    const key = docId ?? null;
    const sameDoc =
      key !== null && activeDocKey === key && view.state.doc.toString() === content;
    loading = true;
    try {
      currentPath = path;
      currentReadonly = readonly;
      if (!sameDoc) {
        // 离开当前标签：先把状态（含撤销历史）存起来
        if (activeDocKey !== null) cacheActiveState(activeDocKey);
        const cached = key !== null ? stateCache.get(key) : undefined;
        if (key !== null) stateCache.delete(key);
        if (cached && cached.state.doc.toString() === content) {
          view.setState(cached.state);
          languageKey = cached.langKey;
          const scroll = EditorView.scrollIntoView(
            cached.state.selection.main.head,
            { y: "nearest" },
          );
          if (cached.generation === configGeneration) {
            // 快速路径：配置未变，仅补齐只读态（同一标签通常一致），无需重建扩展开关
            if (cached.readonly !== readonly) {
              view.dispatch({
                effects: [readOnlyCompartment.reconfigure(readOnlyExtensions(readonly)), scroll],
              });
            } else {
              view.dispatch({ effects: scroll });
            }
          } else {
            view.dispatch({ effects: [...dynamicEffects(), scroll] });
            await applyLanguage(languageOverride);
          }
        } else {
          // 新状态在创建时即按当前配置与只读态构建
          view.setState(createState(content));
          languageKey = null;
          await applyLanguage(languageOverride);
        }
        activeDocKey = key;
      } else {
        view.dispatch({ effects: dynamicEffects() });
        await applyLanguage(languageOverride);
      }
      // 快速连点标签时，晚到的载入不要覆盖当前标签的状态栏光标
      if (activeDocKey === key) notifyCursor(view.state);
    } finally {
      loading = false;
    }
  }

  /** 关闭标签时丢弃其缓存状态；若关闭的是当前标签，避免下次切换再把它写回缓存 */
  function forgetDocument(docId: string): void {
    stateCache.delete(docId);
    if (activeDocKey === docId) activeDocKey = null;
  }

  /** 配置热更新：将当前 settings 应用到编辑器各 Compartment */
  function applySettings(): void {
    whitespaceOn = settings.showWhitespace;
    wordWrapOn = settings.wordWrap;
    configGeneration++;
    view.dispatch({ effects: dynamicEffects() });
  }

  return {
    view,
    loadDocument,
    forgetDocument,
    setLanguage: applyLanguage,
    getContent: () => view.state.doc.toString(),
    toggleWhitespace: () => {
      whitespaceOn = !whitespaceOn;
      configGeneration++;
      view.dispatch({
        effects: whitespaceCompartment.reconfigure(whitespaceOn ? highlightWhitespace() : []),
      });
    },
    isWhitespaceOn: () => whitespaceOn,
    setWordWrap: (on: boolean) => {
      wordWrapOn = on;
      configGeneration++;
      view.dispatch({
        effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []),
      });
    },
    currentLanguage: () => languageKey,
    gotoLine: (line: number) => {
      const n = Math.min(Math.max(1, line), view.state.doc.lines);
      const from = view.state.doc.line(n).from;
      view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
      view.focus();
    },
    applySettings,
  };
}
