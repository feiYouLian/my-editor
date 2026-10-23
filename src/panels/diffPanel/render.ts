/**
 * 差异视图渲染：折叠未变动区段的条目展开 + 分帧 DOM 构建。
 * 大差异（数万行）一次性 append 会冻结主线程，这里每帧至多
 * RENDER_CHUNK 个节点；屏幕外的行再由 CSS content-visibility 跳过绘制。
 */

import type { DiffPayload, DiffRow } from "./types";

/** 未变动区段超过该行数时折叠 */
const COLLAPSE_OVER = 8;
/** 折叠时在区段首尾各保留的行数 */
const COLLAPSE_KEEP = 3;
/** 单帧最多构建的行数 */
const RENDER_CHUNK = 600;

/** 可折叠区段的起始行下标（未变动且长度超限的连续段） */
export function gapStarts(rows: DiffRow[]): number[] {
  const starts: number[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "equal") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "equal") j += 1;
    if (j - i > COLLAPSE_OVER) starts.push(i);
    i = j;
  }
  return starts;
}

/** 构建单个差异行元素（纯 DOM，无事件依赖） */
export function buildDiffRow(row: DiffRow): HTMLElement {
  const el = document.createElement("div");
  el.className = `df-row df-${row.kind}`;
  if (row.kind !== "equal") el.dataset.change = "1";

  const leftNo = document.createElement("span");
  leftNo.className = "df-no";
  leftNo.textContent = row.oldNo === null ? "" : `${row.oldNo}`;

  const leftText = document.createElement("span");
  leftText.className = "df-cell df-left";
  leftText.textContent = row.left;
  if (row.kind === "del" || row.kind === "change") leftText.title = row.left;

  const rightNo = document.createElement("span");
  rightNo.className = "df-no";
  rightNo.textContent = row.newNo === null ? "" : `${row.newNo}`;

  const rightText = document.createElement("span");
  rightText.className = "df-cell df-right";
  rightText.textContent = row.right;
  if (row.kind === "ins" || row.kind === "change") rightText.title = row.right;

  el.append(leftNo, leftText, rightNo, rightText);
  return el;
}

/** 折叠占位元素：点击展开该区段 */
function buildGap(start: number, hidden: number, onExpand: (start: number) => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "df-gap";
  el.textContent = `⋯ 展开 ${hidden} 行未变动`;
  el.title = "点击展开该区段";
  el.addEventListener("click", () => onExpand(start));
  return el;
}

export interface RenderDiffRowsOptions {
  body: HTMLElement;
  payload: DiffPayload;
  /** 已展开的折叠区段起始行 */
  expandedGaps: Set<number>;
  /** 折叠占位被点击 */
  onExpandGap: (start: number) => void;
  /** 本次渲染的代际号（面板持有计数器） */
  token: number;
  /** 代际校验：返回 true 表示已开始新一轮渲染，本次分帧应立即作废 */
  isStale: (token: number) => boolean;
}

/**
 * 展开条目序列（行 / 折叠占位）并分帧 append 到 body。
 * 行元素带 data-hunk 标记（该行是某差异块的起始行），供导航滚动定位。
 */
export function renderDiffRows(opts: RenderDiffRowsOptions): void {
  const { body, payload, expandedGaps, onExpandGap, token, isStale } = opts;
  const rows = payload.rows;
  const hunkOf = new Map<number, number>();
  payload.hunks.forEach((h, idx) => hunkOf.set(h.row, idx));

  body.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "diff-hint";
    empty.textContent = "无可比较内容";
    body.append(empty);
    return;
  }

  // 先展开成完整的条目序列（行 / 折叠占位），再分帧构建 DOM
  const items: HTMLElement[] = [];
  const push = (index: number) => {
    const el = buildDiffRow(rows[index]);
    const hunkIndex = hunkOf.get(index);
    if (hunkIndex !== undefined) el.dataset.hunk = `${hunkIndex}`;
    items.push(el);
  };

  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind === "equal") {
      let j = i;
      while (j < rows.length && rows[j].kind === "equal") j += 1;
      const run = j - i;
      if (run > COLLAPSE_OVER && !expandedGaps.has(i)) {
        for (let k = i; k < i + COLLAPSE_KEEP && k < j; k += 1) push(k);
        items.push(buildGap(i, run - COLLAPSE_KEEP * 2, onExpandGap));
        for (let k = j - COLLAPSE_KEEP; k < j; k += 1) push(k);
      } else {
        for (let k = i; k < j; k += 1) push(k);
      }
      i = j;
      continue;
    }
    push(i);
    i += 1;
  }

  // 分帧 append：每帧至多 RENDER_CHUNK 个节点，帧间让出主线程
  const step = (): void => {
    if (isStale(token)) return; // 已开始新一轮渲染
    const batch = items.splice(0, RENDER_CHUNK);
    if (batch.length === 0) return;
    body.append(...batch);
    if (items.length > 0) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
