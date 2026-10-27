/**
 * 模糊匹配打分：子序列匹配 + 连续匹配加分。
 * 返回 0 表示不匹配；命令面板与快速打开共用（避免两份近似实现漂移）。
 */
export function fuzzyScore(query: string, text: string): number {
  return fuzzyMatch(query, text)?.score ?? 0;
}

export interface FuzzyMatch {
  score: number;
  /** 命中字符在原字符串中的下标（升序），用于高亮 */
  positions: number[];
}

/**
 * 与 fuzzyScore 同一套打分逻辑，额外返回命中位置。
 * positions 的下标是**原字符串**下标（不是小写副本），可直接用于切片渲染。
 * 注意：toLowerCase() 对少数语言会改变长度（如 İ），这里以原串长度为界做保护。
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 1, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let lastMatch = -1;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return null;
    score += idx === lastMatch + 1 ? 2 : 1;
    lastMatch = idx;
    // 只在长度一致时记录位置，避免大小写折叠导致的下标错位
    if (t.length === text.length) positions.push(idx);
    ti = idx + 1;
  }
  return { score, positions };
}
