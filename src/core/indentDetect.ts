/**
 * 缩进风格检测（纯函数，零依赖）。
 *
 * 目标：打开别人的文件时不用手改 Tab 宽度，避免"一按 Tab 就错位"。
 * 只做保守判断：样本不足或结论不明确时返回 confidence="low"，
 * 由调用方静默回退到全局配置（不打扰用户）。
 */

export interface IndentStyle {
  tabSize: number;
  insertSpaces: boolean;
  /** low = 回退全局 / 猜测不可靠（UI 不显示"已检测"） */
  confidence: "low" | "high";
}

/** 采样上限：超过这个行数的缩进分布无参考价值，且会拖慢打开速度 */
const MAX_SAMPLE_LINES = 400;
/** 样本太少不猜 */
const MIN_SAMPLES = 5;
/** 只认常见宽度，避免把 3 / 6 之类的偶然差值当缩进单元 */
const COMMON_WIDTHS = [2, 4, 8];

function indentWidth(indent: string, tabSize: number): number {
  let width = 0;
  for (const ch of indent) width += ch === "\t" ? tabSize : 1;
  return width;
}

export function detectIndent(text: string, fallback: { tabSize: number; insertSpaces: boolean }): IndentStyle {
  const lines = text.split("\n", MAX_SAMPLE_LINES);
  let tabIndented = 0;
  let spaceIndented = 0;
  let samples = 0;
  let prevWidth = -1;
  const deltas = new Map<number, number>();

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const m = /^[ \t]*/.exec(line);
    const indent = m ? m[0] : "";
    if (indent === "") {
      // 顶格行是"缩进回到 0"的锚点
      prevWidth = 0;
      continue;
    }
    samples++;
    if (indent.includes("\t")) tabIndented++;
    else spaceIndented++;

    const width = indentWidth(indent, fallback.tabSize);
    if (prevWidth >= 0 && width > prevWidth) {
      const delta = width - prevWidth;
      if (delta > 0 && delta <= 8) deltas.set(delta, (deltas.get(delta) ?? 0) + 1);
    }
    prevWidth = width;
  }

  if (samples < MIN_SAMPLES) {
    return { tabSize: fallback.tabSize, insertSpaces: fallback.insertSpaces, confidence: "low" };
  }

  // Tab 缩进占多数：直接判 Tab
  if (tabIndented > spaceIndented) {
    return { tabSize: fallback.tabSize, insertSpaces: false, confidence: "high" };
  }

  let bestDelta = 0;
  let bestCount = 0;
  for (const [delta, count] of deltas) {
    if (count > bestCount) {
      bestDelta = delta;
      bestCount = count;
    }
  }
  if (!COMMON_WIDTHS.includes(bestDelta)) {
    return { tabSize: fallback.tabSize, insertSpaces: true, confidence: "low" };
  }
  return {
    tabSize: bestDelta,
    insertSpaces: true,
    // 只出现过一次差值可能是巧合
    confidence: bestCount >= 2 ? "high" : "low",
  };
}
