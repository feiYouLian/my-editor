/**
 * 行文本操作（纯函数，零依赖，可单测）。
 *
 * 全部操作都**保留原换行符**：CRLF 文件经 splitLines/joinLines 往返后不会变成 LF。
 * 调用方（editor/lineOps.ts）负责把选区扩展成整行。
 */

export interface LineParts {
  lines: string[];
  eol: string;
  /** 原文是否以换行结尾（往返时必须还原，否则会多删一行） */
  finalEol: boolean;
}

/** 识别并拆分行：eol 取首个出现的换行风格（CRLF / CR / LF） */
export function splitLines(text: string): LineParts {
  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
  const finalEol = text.endsWith(eol);
  const body = finalEol ? text.slice(0, -eol.length) : text;
  const lines = body === "" ? [] : body.split(eol);
  return { lines, eol, finalEol };
}

export function joinLines(parts: LineParts): string {
  const { lines, eol, finalEol } = parts;
  if (lines.length === 0) return finalEol ? eol : "";
  return finalEol ? lines.join(eol) + eol : lines.join(eol);
}

export interface SortOptions {
  desc?: boolean;
  caseSensitive?: boolean;
  /** 数字优先：两边都以数字开头时按数值比较（1 < 2 < 10） */
  numeric?: boolean;
}

function leadingNumber(s: string): number | null {
  const m = /^\s*(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

function compareLines(a: string, b: string, opts: SortOptions): number {
  const left = opts.caseSensitive ? a : a.toLowerCase();
  const right = opts.caseSensitive ? b : b.toLowerCase();
  if (opts.numeric) {
    const ln = leadingNumber(left);
    const rn = leadingNumber(right);
    if (ln !== null && rn !== null && ln !== rn) return ln - rn;
  }
  // 不用 localeCompare：它的结果依赖系统区域设置，同一份文件在不同机器上排序可能不同
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortLines(text: string, opts: SortOptions = {}): string {
  const parts = splitLines(text);
  if (parts.lines.length < 2) return text;
  const sorted = [...parts.lines].sort((a, b) => compareLines(a, b, opts));
  if (opts.desc) sorted.reverse();
  return joinLines({ ...parts, lines: sorted });
}

/** 去重：保留首次出现的顺序 */
export function dedupeLines(text: string, opts: { caseSensitive?: boolean } = {}): string {
  const parts = splitLines(text);
  if (parts.lines.length < 2) return text;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of parts.lines) {
    const key = opts.caseSensitive ? line : line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return joinLines({ ...parts, lines: out });
}

export function reverseLines(text: string): string {
  const parts = splitLines(text);
  if (parts.lines.length < 2) return text;
  return joinLines({ ...parts, lines: [...parts.lines].reverse() });
}

/** 删除空行（只含空白的行也算空行） */
export function removeEmptyLines(text: string): string {
  const parts = splitLines(text);
  const out = parts.lines.filter((line) => line.trim() !== "");
  if (out.length === parts.lines.length) return text;
  return joinLines({ ...parts, lines: out });
}

/** 删除行尾空白（含行尾制表符；不碰行首缩进） */
export function trimTrailing(text: string): string {
  const parts = splitLines(text);
  const out = parts.lines.map((line) => line.replace(/[ \t]+$/, ""));
  return joinLines({ ...parts, lines: out });
}

/** 保证文件以换行结尾（空文本保持空，不额外造一行） */
export function ensureFinalNewline(text: string, eol = "\n"): string {
  if (text === "" || text.endsWith("\n") || text.endsWith("\r")) return text;
  return text + eol;
}

/**
 * 缩进互转：只改行首缩进，不动行内空白。
 * toSpaces=true：Tab → N 空格；false：N 空格 → Tab（余数保留为空格）。
 */
export interface TextStats {
  lines: number;
  /** 空白分隔且含字母/数字的片段数（与常见编辑器的"词数"口径一致） */
  words: number;
  chars: number;
  charsNoBreak: number;
}

export function textStats(text: string): TextStats {
  const lines = text === "" ? 0 : text.split(/\r\n|\r|\n/).length;
  const words = (text.match(/[^\s]+/g) ?? []).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  return {
    lines,
    words,
    chars: text.length,
    charsNoBreak: text.replace(/[\r\n]/g, "").length,
  };
}

export function convertIndent(
  text: string,
  opts: { tabSize: number; toSpaces: boolean },
): string {
  const size = Math.max(1, opts.tabSize);
  const parts = splitLines(text);
  const out = parts.lines.map((line) => {
    const m = /^[ \t]*/.exec(line);
    const indent = m ? m[0] : "";
    const rest = line.slice(indent.length);
    if (opts.toSpaces) {
      return indent.replace(/\t/g, " ".repeat(size)) + rest;
    }
    let width = 0;
    for (const ch of indent) width += ch === "\t" ? size : 1;
    const tabs = Math.floor(width / size);
    const spaces = width % size;
    return "\t".repeat(tabs) + " ".repeat(spaces) + rest;
  });
  return joinLines({ ...parts, lines: out });
}
