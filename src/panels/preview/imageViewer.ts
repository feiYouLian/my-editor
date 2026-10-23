/**
 * 图片查看器：kind=image 的标签在预览区的渲染（舞台 + 缩放工具条）。
 * 工具条挂在 pane 上（不随内容清空），内容区只放舞台。
 */

import type { PreviewTab } from "./types";

/** 在 pane 顶部渲染缩放工具条，在 contentEl 内渲染图片舞台 */
export function renderImageViewer(
  pane: HTMLElement,
  contentEl: HTMLElement,
  tab: PreviewTab,
): void {
  contentEl.innerHTML = "";
  const stage = document.createElement("div");
  stage.className = "image-stage";
  const img = document.createElement("img");
  img.src = tab.dataUrl ?? "";
  img.alt = tab.name;
  stage.append(img);

  const bar = document.createElement("div");
  bar.className = "image-toolbar";
  const label = document.createElement("span");
  const btn = (text: string, title: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", run);
    return b;
  };
  let scale = 1; // 100% = 适应宽度
  const apply = () => {
    img.style.width = `${scale * 100}%`;
    label.textContent = `${Math.round(scale * 100)}%`;
  };
  bar.append(
    btn("－", "缩小", () => {
      scale = Math.max(0.1, scale - 0.25);
      apply();
    }),
    label,
    btn("＋", "放大", () => {
      scale = Math.min(8, scale + 0.25);
      apply();
    }),
    btn("适应", "适应宽度", () => {
      scale = 1;
      apply();
    }),
  );
  apply();
  pane.prepend(bar);
  contentEl.append(stage);
}
