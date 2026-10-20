import type { EditorView } from "@codemirror/view";

/**
 * 文本变换：大小写 / 命名风格转换与 JSON 美化压缩。
 * 均作用于编辑器选区；无选区时整篇处理（仅 JSON），保持每行的缩进。
 */

export type CaseMode =
  | "upper"
  | "lower"
  | "title"
  | "camel"
  | "pascal"
  | "snake"
  | "kebab"
  | "constant";

export const CASE_LABELS: Record<CaseMode, string> = {
  upper: "全部大写",
  lower: "全部小写",
  title: "每词首字母大写",
  camel: "camelCase",
  pascal: "PascalCase",
  snake: "snake_case",
  kebab: "kebab-case",
  constant: "CONSTANT_CASE",
};

const capitalize = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** 切词：小写→大写边界、缩写边界与常见分隔符；中文按词字符保留（不受大小写影响） */
function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean);
}

/** 命名风格转换：逐行处理，保留行首缩进 */
export function convertCase(text: string, mode: CaseMode): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^(\s*)(.*)$/.exec(line);
      const indent = match?.[1] ?? "";
      const body = match?.[2] ?? "";
      const words = splitWords(body);
      if (words.length === 0) return line;
      let next: string;
      switch (mode) {
        case "upper":
          next = body.toUpperCase();
          break;
        case "lower":
          next = body.toLowerCase();
          break;
        case "title":
          next = body.replace(/\S+/g, (word) => capitalize(word));
          break;
        case "camel":
          next = words.map((word, i) => (i === 0 ? word.toLowerCase() : capitalize(word))).join("");
          break;
        case "pascal":
          next = words.map(capitalize).join("");
          break;
        case "snake":
          next = words.map((word) => word.toLowerCase()).join("_");
          break;
        case "kebab":
          next = words.map((word) => word.toLowerCase()).join("-");
          break;
        case "constant":
          next = words.map((word) => word.toUpperCase()).join("_");
          break;
      }
      return indent + next;
    })
    .join("\n");
}

/** 把选区（或整篇）文本交给 converter，结果替换回编辑器 */
function replaceRange(view: EditorView, converter: (text: string) => string | null): string | null {
  const range = view.state.selection.main;
  const from = range.empty ? 0 : range.from;
  const to = range.empty ? view.state.doc.length : range.to;
  const text = view.state.sliceDoc(from, to);
  const next = converter(text);
  if (next === null || next === text) return next;
  view.dispatch({
    changes: { from, to, insert: next },
    selection: { anchor: from, head: from + next.length },
  });
  return next;
}

/** 大小写 / 命名风格转换（需选中文本） */
export function applyCase(view: EditorView, mode: CaseMode): { ok: boolean; message: string } {
  if (view.state.selection.main.empty) {
    return { ok: false, message: "请先选择要转换的文本" };
  }
  const next = replaceRange(view, (text) => convertCase(text, mode));
  if (next === null) return { ok: false, message: "转换失败" };
  return { ok: true, message: `已转换为 ${CASE_LABELS[mode]}` };
}

/** JSON 美化 / 压缩：有选区处理选区，无选区处理整篇 */
export function applyJson(
  view: EditorView,
  minify: boolean,
  indent: string | number = 2,
): { ok: boolean; message: string } {
  let parseError: string | null = null;
  const next = replaceRange(view, (text) => {
    if (text.trim() === "") {
      parseError = "内容为空";
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indent);
    } catch (e) {
      parseError = String(e).split("\n")[0];
      return null;
    }
  });
  if (parseError) return { ok: false, message: `JSON 解析失败：${parseError}` };
  if (next === null) return { ok: false, message: "处理失败" };
  return { ok: true, message: minify ? "已压缩 JSON" : "已美化 JSON" };
}
