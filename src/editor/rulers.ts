/**
 * 列标尺（editor.rulers 的等价物）：在指定字符列画一条竖线。
 *
 * 实现要点：
 * - 画在 `.cm-scroller` 里（CM6 不管理它的子节点），**不能**挂到 `.cm-content`：
 *   后者由 CM 自己 diff 维护，外来节点会被冲掉。
 * - 用 `view.defaultCharacterWidth` 换算像素，不测 DOM，窗口缩放/字体变更后由
 *   `geometryChanged` 触发重算。
 * - 线是"可见区域全高"，所以不需要跟随滚动重绘。
 */

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { settings } from "../config/settings";

const rulerTheme = EditorView.theme({
  ".cm-rulers": {
    position: "absolute",
    top: "0",
    bottom: "0",
    pointerEvents: "none",
    zIndex: "1",
  },
  ".cm-ruler": {
    position: "absolute",
    top: "0",
    bottom: "0",
    width: "1px",
    background: "var(--border)",
    opacity: "0.7",
  },
});

class RulerView {
  private layer: HTMLDivElement;

  constructor(private view: EditorView) {
    this.layer = document.createElement("div");
    this.layer.className = "cm-rulers";
    this.layer.setAttribute("aria-hidden", "true");
    this.view.scrollDOM.append(this.layer);
    this.sync();
  }

  update(update: ViewUpdate): void {
    if (update.geometryChanged || update.viewportChanged) this.sync();
  }

  destroy(): void {
    this.layer.remove();
  }

  private sync(): void {
    const columns = settings.rulers;
    // 数量很少（通常 1–2 条），直接重建比做差异更便宜
    this.layer.textContent = "";
    if (columns.length === 0) return;
    const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
    const contentRect = this.view.contentDOM.getBoundingClientRect();
    const startLeft = contentRect.left - scrollerRect.left;
    const charWidth = this.view.defaultCharacterWidth;
    for (const col of columns) {
      if (!Number.isFinite(col) || col <= 0) continue;
      const line = document.createElement("div");
      line.className = "cm-ruler";
      line.style.left = `${Math.round(startLeft + col * charWidth)}px`;
      this.layer.append(line);
    }
  }
}

/** 配置为空时返回 []，避免无谓的插件实例 */
export function rulerExtension() {
  if (!settings.rulers || settings.rulers.length === 0) return [];
  return [rulerTheme, ViewPlugin.fromClass(RulerView)];
}
