import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import type { EditorView, KeyBinding } from "@codemirror/view";
import { getSearchQuery } from "@codemirror/search";

/**
 * 书签：
 * 命中行加书签、Next Bookmark 顺序跳转。
 * @codemirror/search 不含书签能力，故自研 gutter + state field。
 * 快捷键：Ctrl+F2 切换、F2 下一个、Shift+F2 上一个。
 */

class BookmarkMarker extends GutterMarker {
  constructor(readonly line: number) {
    super();
  }

  override eq(other: BookmarkMarker): boolean {
    return this.line === other.line;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-bookmark";
    span.textContent = "★";
    span.title = `书签：第 ${this.line} 行`;
    return span;
  }
}

export const addBookmark = StateEffect.define<number>();
export const removeBookmark = StateEffect.define<number>();

export const bookmarkField = StateField.define<RangeSet<BookmarkMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addBookmark)) {
        const lineNo = Math.min(Math.max(1, e.value), tr.state.doc.lines);
        const line = tr.state.doc.line(lineNo);
        set = set.update({ filter: (_f, _t, m) => m.line !== lineNo });
        set = set.update({ add: [new BookmarkMarker(lineNo).range(line.from)] });
      } else if (e.is(removeBookmark)) {
        const lineNo = Math.min(Math.max(1, e.value), tr.state.doc.lines);
        set = set.update({ filter: (_f, _t, m) => m.line !== lineNo });
      }
    }
    return set;
  },
});

/** 书签 gutter：markers 接受 (view) => RangeSet（已核实 @codemirror/view 6.43 签名） */
export const bookmarkGutter = [
  bookmarkField,
  gutter({
    class: "cm-bookmark-gutter",
    markers: (view: EditorView) => view.state.field(bookmarkField),
  }),
];

function bookmarkLines(state: EditorState): number[] {
  const lines: number[] = [];
  const iter = state.field(bookmarkField).iter();
  while (iter.value) {
    lines.push(iter.value.line);
    iter.next();
  }
  return lines;
}

function hasBookmark(state: EditorState, line: number): boolean {
  const pos = state.doc.line(line).from;
  let found = false;
  state.field(bookmarkField).between(pos, pos, () => {
    found = true;
  });
  return found;
}

/** 切换光标所在行的书签 */
export function toggleBookmark(view: EditorView): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  view.dispatch({
    effects: hasBookmark(view.state, line) ? removeBookmark.of(line) : addBookmark.of(line),
  });
}

/** 跳转下一个/上一个书签（循环） */
export function gotoBookmark(view: EditorView, direction: 1 | -1): void {
  const lines = bookmarkLines(view.state);
  if (lines.length === 0) return;
  const current = view.state.doc.lineAt(view.state.selection.main.head).number;
  let target: number;
  if (direction === 1) {
    target = lines.find((l) => l > current) ?? lines[0];
  } else {
    target = [...lines].reverse().find((l) => l < current) ?? lines[lines.length - 1];
  }
  const line = view.state.doc.line(target);
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
}

/** 把当前搜索的所有命中行标记为书签（去重，上限 1 万行） */
export function bookmarkAllMatches(view: EditorView): void {
  const query = getSearchQuery(view.state);
  if (!query) return;
  const cursor = query.getCursor(view.state);
  const effects: StateEffect<number>[] = [];
  const seen = new Set<number>();
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    const line = view.state.doc.lineAt(m.value.from).number;
    if (seen.has(line) || seen.size >= 10000) continue;
    seen.add(line);
    effects.push(addBookmark.of(line));
  }
  if (effects.length > 0) view.dispatch({ effects });
}

export const bookmarkKeymap: readonly KeyBinding[] = [
  { key: "Ctrl-F2", preventDefault: true, run: (v) => (toggleBookmark(v), true) },
  { key: "F2", preventDefault: true, run: (v) => (gotoBookmark(v, 1), true) },
  { key: "Shift-F2", preventDefault: true, run: (v) => (gotoBookmark(v, -1), true) },
];
