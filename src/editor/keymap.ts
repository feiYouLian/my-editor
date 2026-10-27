/**
 * 编辑器键位表：行操作覆盖键、双段 Home、列编辑器快捷键（随配置热更新）。
 */

import {
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  deleteLine,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { keymap, type EditorView, type KeyBinding } from "@codemirror/view";
import { foldKeymap } from "@codemirror/language";
import { settings } from "../config/settings";
import { openColumnEditor } from "./columnEditor";
import { bookmarkKeymap } from "./bookmarks";
import { closeBracketsKeymap } from "./input";

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
export function buildKeymap() {
  return keymap.of([
    indentWithTab,
    ...lineEditKeys(),
    // 必须排在 defaultKeymap 之前：否则 Backspace 走 deleteCharBackward，
    // 闭合括号不会成对删除
    ...closeBracketsKeymap,
    ...foldKeymap,
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
