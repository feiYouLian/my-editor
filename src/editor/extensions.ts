/**
 * 编辑器的配置驱动扩展：全部受配置影响的扩展置于 Compartment，
 * 配置载入/变更后 reconfigure 热更新，无需重建编辑器。
 */

import { Compartment, EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { bracketMatching, codeFolding, foldGutter, indentUnit } from "@codemirror/language";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { history } from "@codemirror/commands";
import { settings, type ColumnModifier } from "../config/settings";
import type { IndentStyle } from "../core/indentDetect";
import { autoCloseExtensions, autoIndentExtension, completionExtensions } from "./input";
import { rulerExtension } from "./rulers";
import { editorThemeFor } from "./theme";
import { occurrences } from "./occurrences";
import { rainbowBrackets } from "./rainbowBrackets";
import { buildKeymap } from "./keymap";
import { searchExtensions } from "./search";
import { bookmarkGutter } from "./bookmarks";
import { minimapExtension } from "./minimap";

export interface EditorCompartments {
  language: Compartment;
  whitespace: Compartment;
  indent: Compartment;
  keymap: Compartment;
  /** 自动闭合括号 / 引号 */
  autoClose: Compartment;
  /** 输入时自动缩进 */
  autoIndent: Compartment;
  /** 文档内单词补全 */
  completion: Compartment;
  bracket: Compartment;
  rainbowBrackets: Compartment;
  indentGuides: Compartment;
  occurrence: Compartment;
  columnSelection: Compartment;
  readOnly: Compartment;
  theme: Compartment;
  chrome: Compartment;
  wrap: Compartment;
  folding: Compartment;
  minimap: Compartment;
}

export function createCompartments(): EditorCompartments {
  return {
    language: new Compartment(),
    whitespace: new Compartment(),
    indent: new Compartment(),
    keymap: new Compartment(),
    autoClose: new Compartment(),
    autoIndent: new Compartment(),
    completion: new Compartment(),
    bracket: new Compartment(),
    rainbowBrackets: new Compartment(),
    indentGuides: new Compartment(),
    occurrence: new Compartment(),
    columnSelection: new Compartment(),
    readOnly: new Compartment(),
    theme: new Compartment(),
    chrome: new Compartment(),
    wrap: new Compartment(),
    folding: new Compartment(),
    minimap: new Compartment(),
  };
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
export function hasLongLine(state: EditorState): boolean {
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

/** 全局缩进配置（未检测 / 检测失败时的兜底） */
export function globalIndentStyle(): IndentStyle {
  return { tabSize: settings.tabSize, insertSpaces: settings.insertSpaces, confidence: "high" };
}

function indentationExtensions(indent: IndentStyle): Extension[] {
  return [
    indentUnit.of(indent.insertSpaces ? " ".repeat(indent.tabSize) : "\t"),
    EditorState.tabSize.of(indent.tabSize),
  ];
}

/** 编辑器主题扩展（语法主题 + 字号，随配置热更新） */
function themeExtensions(): Extension[] {
  return editorThemeFor(settings.editorTheme, settings.editorFontSize);
}

/** 行号 / 活动行高亮 / 列标尺（随配置热更新，走 chrome Compartment） */
function chromeExtensions(): Extension[] {
  const exts: Extension[] = [];
  if (settings.showLineNumbers) exts.push(lineNumbers());
  if (settings.showActiveLine) exts.push(highlightActiveLine(), highlightActiveLineGutter());
  exts.push(...rulerExtension());
  return exts;
}

function columnSelectionExtensions(): Extension[] {
  if (!settings.columnSelection) return [];
  return [
    rectangularSelection({
      eventFilter: (e) => modifierActive(e, settings.columnSelectionModifier),
    }),
    crosshairCursor({ key: settings.columnSelectionModifier }),
  ];
}

/** 只读态：readOnly 拦截文档变更事务，editable 关闭输入（含 IME 与粘贴） */
export function readOnlyExtensions(readonly: boolean): Extension[] {
  return [
    EditorState.readOnly.of(readonly),
    EditorView.editable.of(!readonly),
  ];
}

/** 空白 / 换行开关（界面即时切换，独立于 applySettings） */
export function whitespaceExtension(on: boolean): Extension[] {
  return on ? [highlightWhitespace()] : [];
}

export function wrapExtension(on: boolean): Extension {
  return on ? EditorView.lineWrapping : [];
}

/** 代码折叠：行内折叠区间 + gutter 折叠标记（键位在 keymap 里，始终可用） */
function foldingExtensions(): Extension[] {
  if (!settings.codeFolding) return [];
  return [
    codeFolding(),
    foldGutter({
      markerDOM: (open) => {
        const span = document.createElement("span");
        span.className = `cm-fold-marker${open ? " open" : " closed"}`;
        span.textContent = open ? "⌄" : "›";
        span.title = open ? "折叠" : "展开";
        return span;
      },
    }),
  ];
}

/** Minimap：关闭时置空，开启时挂 ViewPlugin（见 minimap.ts） */
function minimapExtensions(): Extension[] {
  return settings.minimap ? [minimapExtension()] : [];
}

/** 各 Compartment 的初始内容 */
export function initialExtensions(
  c: EditorCompartments,
  opts: { whitespaceOn: boolean; wordWrapOn: boolean; readonly: boolean; indent?: IndentStyle },
): Extension[] {
  return [
    c.chrome.of(chromeExtensions()),
    drawSelection(),
    history(),
    // 列选择前提：允许多选区（rectangularSelection 来自 @codemirror/view 核心）
    EditorState.allowMultipleSelections.of(true),
    c.indent.of(indentationExtensions(opts.indent ?? globalIndentStyle())),
    c.autoClose.of(autoCloseExtensions(settings.autoCloseBrackets && !opts.readonly)),
    c.autoIndent.of(autoIndentExtension(settings.autoIndent && !opts.readonly)),
    c.completion.of(completionExtensions({ readonly: opts.readonly })),
    c.keymap.of(buildKeymap()),
    c.bracket.of(settings.bracketMatching ? bracketMatching() : []),
    c.rainbowBrackets.of(settings.rainbowBrackets ? rainbowBrackets() : []),
    c.indentGuides.of(settings.indentGuides ? indentationMarkers() : []),
    c.columnSelection.of(columnSelectionExtensions()),
    c.occurrence.of(settings.occurrenceHighlight ? occurrences() : []),
    c.whitespace.of(whitespaceExtension(opts.whitespaceOn)),
    c.wrap.of(wrapExtension(opts.wordWrapOn)),
    c.folding.of(foldingExtensions()),
    c.readOnly.of(readOnlyExtensions(opts.readonly)),
    c.language.of([]),
    c.theme.of(themeExtensions()),
    c.minimap.of(minimapExtensions()),
    ...bookmarkGutter,
    ...searchExtensions(),
  ];
}

/**
 * 随"当前文档"变化而必须重配的扩展（缩进 / 自动闭合 / 补全）。
 * 缓存状态快速路径（setup.loadDocument）也要单独调用它 —— 否则快速切标签时
 * 这些按文档生效的扩展会停留在上一个文档的值上。
 */
export function perDocumentEffects(
  c: EditorCompartments,
  opts: { readonly: boolean; indent?: IndentStyle },
): StateEffect<unknown>[] {
  return [
    c.indent.reconfigure(indentationExtensions(opts.indent ?? globalIndentStyle())),
    c.autoClose.reconfigure(autoCloseExtensions(settings.autoCloseBrackets && !opts.readonly)),
    c.autoIndent.reconfigure(autoIndentExtension(settings.autoIndent && !opts.readonly)),
    c.completion.reconfigure(completionExtensions({ readonly: opts.readonly })),
  ];
}

/** 受配置影响的扩展：配置热更新与标签状态恢复时统一重配 */
export function dynamicEffects(
  c: EditorCompartments,
  opts: { whitespaceOn: boolean; wordWrapOn: boolean; readonly: boolean; indent?: IndentStyle },
): StateEffect<unknown>[] {
  return [
    c.chrome.reconfigure(chromeExtensions()),
    c.indent.reconfigure(indentationExtensions(opts.indent ?? globalIndentStyle())),
    c.autoClose.reconfigure(autoCloseExtensions(settings.autoCloseBrackets && !opts.readonly)),
    c.autoIndent.reconfigure(autoIndentExtension(settings.autoIndent && !opts.readonly)),
    c.completion.reconfigure(completionExtensions({ readonly: opts.readonly })),
    c.keymap.reconfigure(buildKeymap()),
    c.bracket.reconfigure(settings.bracketMatching ? bracketMatching() : []),
    c.rainbowBrackets.reconfigure(settings.rainbowBrackets ? rainbowBrackets() : []),
    c.indentGuides.reconfigure(settings.indentGuides ? indentationMarkers() : []),
    c.columnSelection.reconfigure(columnSelectionExtensions()),
    c.occurrence.reconfigure(settings.occurrenceHighlight ? occurrences() : []),
    c.whitespace.reconfigure(whitespaceExtension(opts.whitespaceOn)),
    c.wrap.reconfigure(wrapExtension(opts.wordWrapOn)),
    c.folding.reconfigure(foldingExtensions()),
    c.readOnly.reconfigure(readOnlyExtensions(opts.readonly)),
    c.theme.reconfigure(themeExtensions()),
    c.minimap.reconfigure(minimapExtensions()),
  ];
}
