/**
 * 命令搜索打分：标题模糊匹配打底，关键词与说明做加法。
 *
 * 纯函数、不依赖 DOM 与上层模块，供两处共用同一份实现：
 * - `src/panels/commandPalette.ts`（面板渲染与排序）
 * - `scripts/audit-discoverability.mjs`（C7 搜索可达性判据）
 *
 * 审计脚本过去另写了一份近似评分，面板调权重就会与判据漂移；
 * 抽到 core 后两边同源，改权重只需改这里。
 */
import { fuzzyMatch, fuzzyScore } from "./fuzzy";

/** 参与打分的命令字段（CommandItem / CommandDef 都满足该结构） */
export interface ScorableCommand {
  id?: string;
  title: string;
  description?: string;
  keywords?: string[];
}

export interface CommandScore {
  score: number;
  /** 标题里的命中位置（用于高亮）；只在关键词/说明命中时为空 */
  positions: number[];
}

/**
 * 精确关键词（如 "git apply"）权重最高——用户输入的是外部命令名或口语，
 * 这些词不会出现在标题里。
 * 命令 id 也参与匹配：命令索引里看到 `git.showHistory` 的人会直接拿它来搜。
 */
export function commandScore(query: string, item: ScorableCommand): CommandScore {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 1, positions: [] };

  const title = fuzzyMatch(q, item.title);
  let score = title?.score ?? 0;
  const positions = title?.positions ?? [];

  const id = item.id?.toLowerCase() ?? "";
  if (id) {
    if (id === q) score += 120;
    else if (id.includes(q)) score += 60;
  }

  for (const kw of item.keywords ?? []) {
    const k = kw.toLowerCase();
    if (k === q) score += 100;
    else if (k.includes(q)) score += 40;
  }

  const desc = item.description?.toLowerCase() ?? "";
  if (desc) {
    if (desc.includes(q)) score += 30;
    else score += fuzzyScore(q, desc) * 0.3;
  }

  return { score, positions };
}
