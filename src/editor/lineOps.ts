/**
 * 行操作的编辑器适配层：把"按行语义"翻译成文档变更。
 *
 * 语义（与 Notepad++ 的行操作一致）：
 * - 有选区：作用于选区**覆盖到的整行**（不能只改半行，否则排序结果不可预期）
 * - 无选区：作用于整篇
 *
 * 纯文本变换在 core/textOps.ts，本文件只负责范围计算与事务提交。
 */

import type { EditorView } from "@codemirror/view";
import {
  convertIndent,
  dedupeLines,
  removeEmptyLines,
  reverseLines,
  sortLines,
  trimTrailing,
  type SortOptions,
} from "../core/textOps";

export type LineOp =
  | { kind: "sort"; options: SortOptions }
  | { kind: "dedupe" }
  | { kind: "reverse" }
  | { kind: "removeEmpty" }
  | { kind: "trimTrailing" }
  | { kind: "indent"; toSpaces: boolean };

export interface LineOpResult {
  ok: boolean;
  message: string;
}

const LABELS: Record<LineOp["kind"], string> = {
  sort: "已排序",
  dedupe: "已去除重复行",
  reverse: "已反转行序",
  removeEmpty: "已删除空行",
  trimTrailing: "已删除行尾空白",
  indent: "已转换缩进",
};

function run(text: string, op: LineOp, tabSize: number): string {
  switch (op.kind) {
    case "sort":
      return sortLines(text, op.options);
    case "dedupe":
      return dedupeLines(text);
    case "reverse":
      return reverseLines(text);
    case "removeEmpty":
      return removeEmptyLines(text);
    case "trimTrailing":
      return trimTrailing(text);
    case "indent":
      return convertIndent(text, { tabSize, toSpaces: op.toSpaces });
  }
}

export function applyLineOp(view: EditorView, op: LineOp, tabSize: number): LineOpResult {
  const range = view.state.selection.main;
  // 行操作是"整行"语义：选区端点向外扩到行边界
  const from = range.empty ? 0 : view.state.doc.lineAt(range.from).from;
  const to = range.empty ? view.state.doc.length : view.state.doc.lineAt(range.to).to;
  if (from === to) return { ok: false, message: "当前没有可处理的行" };

  const text = view.state.sliceDoc(from, to);
  const next = run(text, op, tabSize);
  if (next === text) return { ok: true, message: "内容没有变化" };

  view.dispatch({
    changes: { from, to, insert: next },
    // 保持整段选中，便于连续操作（如先排序再去重）
    selection: { anchor: from, head: from + next.length },
    scrollIntoView: true,
  });
  return { ok: true, message: LABELS[op.kind] };
}
