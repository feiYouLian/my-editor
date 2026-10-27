/**
 * 大文件视图缩略图：按桶密度绘制行分布色带，
 * 过滤模式下叠加命中红线，末尾绘制当前视口指示。
 * 配色统一取自 CSS 变量（与编辑器内 minimap 一致），三套主题下都可辨。
 */

import { LINE_HEIGHT, MINIMAP_WIDTH } from "./constants";

export interface MinimapState {
  /** 每桶的非空行数（large_minimap 命令返回） */
  density: number[];
  /** 过滤命中行号（null = 未过滤）；Uint32Array 定长，避免大命中集的装箱开销 */
  matches: Uint32Array | null;
  /** 当前可滚动条目数（过滤模式为命中数，否则为总行数） */
  total: number;
  scrollTop: number;
  clientHeight: number;
}

/** 读主题色：canvas 在 DOM 中，CSS 变量可解析（主题切换后下一次绘制即生效） */
function readVar(canvas: HTMLCanvasElement, name: string, fallback: string): string {
  const value = getComputedStyle(canvas).getPropertyValue(name).trim();
  return value || fallback;
}

export function drawMinimap(canvas: HTMLCanvasElement, state: MinimapState): void {
  const height = Math.max(120, state.clientHeight);
  const width = MINIMAP_WIDTH;
  // 只在尺寸变化时重建画布（滚动期每帧都会调用本函数，避免反复 realloc）
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);

  const ink = readVar(canvas, "--text-primary", "#e6e8ee");
  const accent = readVar(canvas, "--accent", "#4c8dff");
  const danger = readVar(canvas, "--danger", "#ff6b6b");

  const buckets = state.density.length;
  const max = Math.max(1, ...state.density);
  ctx.fillStyle = ink;
  for (let i = 0; i < buckets; i += 1) {
    const y = (i / buckets) * height;
    const h = Math.max(1, height / buckets);
    const ratio = state.density[i] / max;
    ctx.globalAlpha = 0.12 + 0.35 * ratio;
    ctx.fillRect(0, y, Math.max(1, width * (0.3 + 0.7 * ratio)), h);
  }
  ctx.globalAlpha = 1;

  const total = state.total;
  if (state.matches && total > 0) {
    ctx.fillStyle = danger;
    ctx.globalAlpha = 0.95;
    const step = state.matches.length > 4000 ? Math.ceil(state.matches.length / 4000) : 1;
    for (let i = 0; i < state.matches.length; i += step) {
      const y = (state.matches[i] / total) * height;
      ctx.fillRect(0, y, width, 1);
    }
    ctx.globalAlpha = 1;
  }

  if (total > 0) {
    const contentHeight = total * LINE_HEIGHT;
    const viewH = Math.max(3, (state.clientHeight / contentHeight) * height);
    const top = (state.scrollTop / contentHeight) * height;
    const y = Math.max(0, Math.min(height - viewH, top));
    // 视口框：accent 半透明填充 + 上下描边（与编辑器 minimap 观感一致）
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.2;
    ctx.fillRect(0, y, width, viewH);
    ctx.globalAlpha = 0.6;
    ctx.fillRect(0, y, width, 1);
    ctx.fillRect(0, y + viewH - 1, width, 1);
    ctx.globalAlpha = 1;
  }
}
