/**
 * 图片查看器：kind=image 的标签在预览区的渲染（舞台 + 缩放工具条）。
 * 工具条挂在 pane 上（不随内容清空），内容区只放舞台。
 *
 * 缩放模型：默认「适应窗口」——整图落在可视区域内且不放大超过原图（100%），
 * 避免大图/竖图一打开就要滚动查看；点放大/缩小/1:1 后转为手动倍率，
 * 「适应」可随时回到自适应。舞台尺寸变化（窗口缩放、侧栏折叠、分栏拖动）
 * 时由 ResizeObserver 在自适应状态下重算。
 */

import type { PreviewTab } from "./types";

/** 适应窗口时舞台四周留白（px），避免图片贴边 */
const FIT_PADDING = 16;
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;

/** 在 pane 顶部渲染缩放工具条，在 contentEl 内渲染图片舞台。
 *  onNaturalSize：图片解码完成后回报自然宽高（状态栏展示用，避免二次解码 data URL） */
export function renderImageViewer(
  pane: HTMLElement,
  contentEl: HTMLElement,
  tab: PreviewTab,
  onNaturalSize?: (width: number, height: number) => void,
): void {
  contentEl.innerHTML = "";
  const stage = document.createElement("div");
  stage.className = "image-stage";
  const img = document.createElement("img");
  img.alt = tab.name;
  stage.append(img);

  const bar = document.createElement("div");
  bar.className = "image-toolbar";
  const label = document.createElement("span");
  label.textContent = "适应"; // 解码完成前先占位，load 后写成百分比
  const btn = (text: string, title: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", run);
    return b;
  };

  /** 自适应 = 跟随舞台尺寸；手动 = 按 scale 相对原图缩放 */
  let fit = true;
  let scale = 1;

  /** 舞台内可视尺寸能容纳整图的比例（只缩小，不放大：小图保持原始像素，避免发虚） */
  const fitScale = (): number => {
    const cw = stage.clientWidth - FIT_PADDING * 2;
    const ch = stage.clientHeight - FIT_PADDING * 2;
    if (!img.naturalWidth || !img.naturalHeight || cw <= 0 || ch <= 0) return 1;
    return Math.min(cw / img.naturalWidth, ch / img.naturalHeight, 1);
  };

  const apply = (): void => {
    if (!img.naturalWidth) return; // 尚未解码：等 load 后由调用方再触发
    if (fit) scale = fitScale();
    img.style.width = `${Math.max(1, Math.round(img.naturalWidth * scale))}px`;
    img.style.height = "auto";
    label.textContent = `${Math.round(scale * 100)}%`;
  };

  const zoomBy = (delta: number): void => {
    fit = false;
    scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale + delta));
    apply();
  };

  bar.append(
    btn("－", "缩小", () => zoomBy(-ZOOM_STEP)),
    label,
    btn("＋", "放大", () => zoomBy(ZOOM_STEP)),
    btn("适应", "适应窗口（整图可见）", () => {
      fit = true;
      apply();
    }),
    btn("1:1", "实际大小（100%）", () => {
      fit = false;
      scale = 1;
      apply();
    }),
  );

  /** 尺寸只回报一次（缓存命中时 complete 分支与 load 事件可能都走到） */
  let reported = false;
  const reportSize = (): void => {
    if (reported || !img.naturalWidth) return;
    reported = true;
    onNaturalSize?.(img.naturalWidth, img.naturalHeight);
  };

  img.addEventListener(
    "load",
    () => {
      apply();
      reportSize();
    },
    { once: true },
  );
  img.src = tab.dataUrl ?? "";

  // 舞台尺寸变化：自适应状态下重算；stage 已被移除时断开，避免观察器滞留
  const observer = new ResizeObserver(() => {
    if (!stage.isConnected) {
      observer.disconnect();
      return;
    }
    if (fit) apply();
  });
  observer.observe(stage);

  pane.prepend(bar);
  contentEl.append(stage);
  // data URL 命中缓存时 load 可能已过：补齐首帧渲染
  if (img.complete && img.naturalWidth > 0) {
    apply();
    reportSize();
  }
}
