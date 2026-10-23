/**
 * 大文件视图的行缓存与区间合并。
 * 缓存按 Map 插入序淘汰（最近使用的行被移到队尾）；
 * 缺失行合并为连续区间后一次 invoke 读一段，避免逐行 IPC。
 */

import type { LineWindow } from "./types";

const CACHE_LIMIT = 5000;

export class LineCache {
  private cache = new Map<number, string>();

  has(line: number): boolean {
    return this.cache.has(line);
  }

  get(line: number): string | undefined {
    return this.cache.get(line);
  }

  clear(): void {
    this.cache.clear();
  }

  /** 写入一个窗口；命中已存在的行时移到队尾（反映最近使用） */
  remember(win: LineWindow): void {
    win.lineNos.forEach((no, i) => {
      // 先删再设：让 Map 插入顺序反映最近使用，供下面按序淘汰
      this.cache.delete(no);
      this.cache.set(no, win.lines[i] ?? "");
    });
    // 按插入序淘汰最旧条目。整表 clear 会让滚动/过滤来回时反复回读，掉帧明显
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/**
 * 把行号集合合并为连续区间：[起始行, 行数]。
 * 相邻（差 1）或重叠的行并入同一段，段数即 invoke 次数。
 */
export function coalesceLines(lines: number[]): [number, number][] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const ln of sorted) {
    const last = runs[runs.length - 1];
    if (last && ln <= last[0] + last[1]) {
      last[1] = ln - last[0] + 1;
    } else {
      runs.push([ln, 1]);
    }
  }
  return runs;
}
