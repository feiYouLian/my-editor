/**
 * 模糊匹配打分：子序列匹配 + 连续匹配加分。
 * 返回 0 表示不匹配；命令面板与快速打开共用（避免两份近似实现漂移）。
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let lastMatch = -1;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    score += idx === lastMatch + 1 ? 2 : 1;
    lastMatch = idx;
    ti = idx + 1;
  }
  return score;
}
