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
 *
 * 设计要点：marker 不存行号，只借 RangeSet 记录位置。
 * 文档变更后 RangeSet.map 会自动搬移位置，行号在读取时用
 * doc.lineAt(位置).number 现算——存陈旧行号会同时导致跳错行
 * 和「删不掉」（过滤条件永远匹配不上）。
 */

/** 无状态 gutter 标记（位置信息由 RangeSet 承载） */
class BookmarkMarker extends GutterMarker {
  override eq(_other: BookmarkMarker): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-bookmark";
    span.textContent = "★";
    span.title = "书签";
    return span;
  }
}

export const addBookmark = StateEffect.define<number>();
/** 批量添加（搜索全部命中）：单事务一次 filter + 一次 add */
export const addBookmarks = StateEffect.define<number[]>();
export const removeBookmark = StateEffect.define<number>();

export const bookmarkField = StateField.define<RangeSet<BookmarkMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addBookmark)) {
        const lineNo = Math.min(Math.max(1, e.value), tr.state.doc.lines);
        const pos = tr.state.doc.line(lineNo).from;
        set = set.update({ filter: (from) => from !== pos });
        set = set.update({ add: [new BookmarkMarker().range(pos)] });
      } else if (e.is(addBookmarks)) {
        // 批量：先按位置去重过滤，再一次批量添加（避免逐行重建 RangeSet）
        let positions = e.value
          .map((lineNo) => Math.min(Math.max(1, lineNo), tr.state.doc.lines))
          .map((lineNo) => tr.state.doc.line(lineNo).from);
        positions.sort((a, b) => a - b);
        positions = [...new Set(positions)];
        const posSet = new Set(positions);
        set = set.update({ filter: (from) => !posSet.has(from) });
        set = set.update({
          add: positions.map((pos) => new BookmarkMarker().range(pos)),
        });
      } else if (e.is(removeBookmark)) {
        const lineNo = Math.min(Math.max(1, e.value), tr.state.doc.lines);
        const pos = tr.state.doc.line(lineNo).from;
        set = set.update({ filter: (from) => from !== pos });
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
    // 行号现算：marker 位置已随文档变更重映射
    lines.push(state.doc.lineAt(iter.from).number);
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
  const lines: number[] = [];
  const seen = new Set<number>();
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    const line = view.state.doc.lineAt(m.value.from).number;
    if (seen.has(line)) continue;
    if (seen.size >= 10000) break; // 达上限后不再遍历剩余命中
    seen.add(line);
    lines.push(line);
  }
  if (lines.length > 0) view.dispatch({ effects: addBookmarks.of(lines) });
}

export const bookmarkKeymap: readonly KeyBinding[] = [
  { key: "Ctrl-F2", preventDefault: true, run: (v) => (toggleBookmark(v), true) },
  { key: "F2", preventDefault: true, run: (v) => (gotoBookmark(v, 1), true) },
  { key: "Shift-F2", preventDefault: true, run: (v) => (gotoBookmark(v, -1), true) },
];
