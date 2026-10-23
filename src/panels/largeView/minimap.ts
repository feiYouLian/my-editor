/**
 * 大文件视图缩略图：按桶密度绘制行分布色带，
 * 过滤模式下叠加命中红线，末尾绘制当前视口指示。
 */

import { LINE_HEIGHT } from "./constants";

export interface MinimapState {
  /** 每桶的非空行数（large_minimap 命令返回） */
  density: number[];
  /** 过滤命中行号（null = 未过滤） */
  matches: number[] | null;
  /** 当前可滚动条目数（过滤模式为命中数，否则为总行数） */
  total: number;
  scrollTop: number;
  clientHeight: number;
}

export function drawMinimap(canvas: HTMLCanvasElement, state: MinimapState): void {
  const height = Math.max(120, state.clientHeight);
  const width = 64;
  canvas.width = width;
  canvas.height = height;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);

  const buckets = state.density.length;
  const max = Math.max(1, ...state.density);
  for (let i = 0; i < buckets; i += 1) {
    const y = (i / buckets) * height;
    const h = Math.max(1, height / buckets);
    const ratio = state.density[i] / max;
    ctx.fillStyle = `rgba(150, 162, 184, ${0.12 + 0.5 * ratio})`;
    ctx.fillRect(0, y, Math.max(1, 12 + 46 * ratio), h);
  }

  const total = state.total;
  if (state.matches && total > 0) {
    ctx.fillStyle = "rgba(217, 90, 80, 0.95)";
    const step = state.matches.length > 4000 ? Math.ceil(state.matches.length / 4000) : 1;
    for (let i = 0; i < state.matches.length; i += step) {
      const y = (state.matches[i] / total) * height;
      ctx.fillRect(0, y, width, 1);
    }
  }

  if (total > 0) {
    const viewH = Math.max(3, (state.clientHeight / (total * LINE_HEIGHT)) * height);
    const top = (state.scrollTop / (total * LINE_HEIGHT)) * height;
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.fillRect(0, Math.max(0, Math.min(height - viewH, top)), width, viewH);
  }
}
