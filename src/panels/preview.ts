/**
 * 预览宿主（状态机）：
 * - Markdown：markdown-it(html:false) + DOMPurify + highlight.js（管线见 preview/markdownPipeline.ts，懒加载），
 *   块级元素打 data-line 标记，双栏滚动联动
 * - HTML：沙箱 iframe（sandbox="" 禁用脚本，CSS/图片正常渲染）
 * - 模式：编辑 / 预览 / 双栏（md/html 可切换；≥20MB 禁用预览）
 * - 图片标签走 mode-image（渲染见 preview/imageViewer.ts）
 *
 * 导出（独立文档 / 打印 / HTML→Markdown）在 preview/export.ts，
 * 本地图片内联在 preview/localImages.ts。
 */

import type { EditorView } from "@codemirror/view";
import { pathKindOf as kindOf } from "./preview/pathKind";
import { loadMarkdownPipeline } from "./preview/markdownPipeline";
import { inlineLocalImages } from "./preview/localImages";
import { renderImageViewer } from "./preview/imageViewer";
import type { PreviewKind, PreviewMode, PreviewTab } from "./preview/types";

export type { PreviewKind, PreviewMode, PreviewTab };
export { pathKindOf } from "./preview/pathKind";
// 导出工具经此转发，保持既有导入路径可用（app/previewHost.ts）
export {
  buildStandaloneHtml,
  buildWordHtml,
  htmlToMarkdown,
  openPrintDialog,
} from "./preview/export";

/** 预览大小上限（超过则禁用预览） */
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** 双栏滚动联动：源行/块顶与各自视口顶之间保留的呼吸距离（px） */
const SYNC_TOP_MARGIN = 8;
/**
 * 双栏滚动联动：回显抑制窗口（ms）。
 * 一侧被程序滚动后，对方面板随之抛出的 scroll 事件在窗口内视为回显忽略，
 * 避免"你滚我滚"的死循环。程序滚动产生的 scroll 事件 1~2 帧内必到，
 * 120ms 足够覆盖；即便偶发超时也被当作一次真实滚动，计算结果相同、不会振荡，
 * 最多让对侧多同步一次（自收敛，无死循环）。
 */
const PREVIEW_ECHO_MS = 120;

export class PreviewHost {
  private mode: PreviewMode = "edit";
  private kind: PreviewKind = null;
  private activeId: string | null = null;
  private mdReady: Promise<void> | null = null;
  private md: { render(text: string): string } | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private contentEl: HTMLElement;

  // ---- 双栏滚动联动状态 ----
  /** 最近一次参与联动的编辑器视图（供重渲染 / 图片加载后校准用） */
  private syncView: EditorView | null = null;
  /** rAF 句柄：连续滚动每帧最多同步一次，保证末次事件必达（时间窗丢事件会累积偏移） */
  private syncRaf: number | null = null;
  /** 预览被本类程序滚动后，窗口内其 scroll 事件视为回显直接忽略 */
  private previewEchoUntil = 0;

  constructor(
    private pane: HTMLElement,
    private area: HTMLElement,
    private onScrollToLine: (line: number) => void,
    /**
     * HTML 预览渲染在 iframe 内，右键事件不会冒泡到宿主；
     * 通过同源访问 iframe 文档转发，坐标已换算为页面坐标。
     */
    private onContextMenu?: (x: number, y: number) => void,
  ) {
    this.pane.innerHTML = '<div class="preview-content"></div>';
    this.contentEl = this.pane.querySelector<HTMLElement>(".preview-content")!;
    this.contentEl.addEventListener("scroll", () => this.onPreviewScroll());
  }

  /** 移除预览区残留的图片工具条，避免连续打开图片时叠加 */
  private clearImageToolbar(): void {
    this.pane.querySelectorAll(".image-toolbar").forEach((el) => el.remove());
  }

  /** 标签/模式变化时调用：应用布局并按需渲染 */
  apply(tab: PreviewTab | null, mode: PreviewMode): void {
    this.activeId = tab?.id ?? null;
    this.clearImageToolbar();
    if (tab?.kind === "image") {
      this.kind = null;
      this.setAreaMode("image");
      renderImageViewer(this.pane, this.contentEl, tab);
      return;
    }
    this.kind = tab ? kindOf(tab.path) : null;
    this.mode = this.kind && mode !== "edit" ? mode : "edit";
    this.setAreaMode(this.mode);
    if (this.mode !== "edit" && tab && this.kind) {
      this.renderSafe(tab, this.kind);
    }
  }

  /** 编辑内容变化后的防抖重渲染 */
  scheduleRender(tab: PreviewTab): void {
    if (this.mode === "edit" || !this.kind || this.activeId !== tab.id) return;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.renderSafe(tab, this.kind!), 300);
  }

  /** 渲染并兜底错误：组件加载失败时在预览区显示原因，绝不静默空白 */
  private renderSafe(tab: PreviewTab, kind: "md" | "html"): void {
    this.renderNow(tab, kind).catch((e) => {
      if (this.isStale(tab)) return;
      console.error("[preview] 渲染失败", e);
      this.contentEl.innerHTML = "";
      const note = document.createElement("div");
      note.className = "preview-note";
      note.textContent = String(e instanceof Error ? e.message : e);
      this.contentEl.append(note);
    });
  }

  /**
   * 编辑器滚动 → 预览滚动（双栏 Markdown）。
   *
   * 历史问题（滚动越久偏移越大）：
   * 1. 用 posAtCoords 取顶部行——快速拖动滚动条时该行常未渲染，返回 null 直接不同步；
   * 2. 时间窗（80ms）丢事件：一次滚动手势的最后一个事件落在窗口内就被丢弃，偏移永久残留；
   * 3. `[data-line="N"]` 精确匹配——行落在长段落中间时没有对应标记，同样不同步。
   *
   * 现在改为：rAF 节流（末次事件必达）+ 高度图取顶部可见行 + 最近标记 + 块内插值。
   */
  syncFromEditor(view: EditorView): void {
    if (!this.canSync()) return;
    // 注意：这里不能做回显抑制——previewEchoUntil 是本类自己滚动预览时打的
    // 标记，编辑器连续滚动时每一帧都会刷新它，若在这里判断会把真实滚动也吞掉
    // （每 200ms 才同步一次，且手势末次事件被丢弃，偏移再次累积）。
    // 回显抑制只属于 onPreviewScroll（预览侧）。
    this.syncView = view;
    this.scheduleSync(() => this.applyEditorToPreview());
  }

  /** 以编辑器顶部可见行为准，把预览滚到对应位置（块内按源行插值，滚动连续） */
  private applyEditorToPreview(): void {
    const view = this.syncView;
    if (!view || !this.canSync()) return;
    let line: number;
    try {
      const doc = view.state.doc;
      const scrollTop = view.scrollDOM.scrollTop;
      // lineBlockAtHeight 走高度图，不依赖坐标测量：目标行未渲染时同样可用。
      // +2 让"顶部边缘所在行"稳定落在视口内（0 时恰在行缝上会取到上一行）
      const block = view.lineBlockAtHeight(scrollTop + 2);
      // 视口顶落在该可视行内的比例 → 折算成小数源码行号；
      // 预览侧用同一套小数行号插值，双向对齐到亚行精度
      const frac =
        block.height > 0
          ? Math.min(1, Math.max(0, (scrollTop + 2 - block.top) / block.height))
          : 0;
      const pos = block.from + (block.to - block.from) * frac;
      const whole = doc.lineAt(Math.min(pos, doc.length)).number;
      const info = doc.line(whole);
      line = whole + (pos - info.from) / Math.max(1, info.to - info.from);
    } catch {
      return; // 视图已销毁等异常：放弃本次同步
    }
    const target = this.previewScrollTopForLine(line);
    if (target == null) return;
    this.previewEchoUntil = performance.now() + PREVIEW_ECHO_MS;
    this.contentEl.scrollTop = target;
  }

  /** 源码行号 → 预览滚动位置：取"起始行 ≤ lineNo"的最后一个块，块内线性插值 */
  private previewScrollTopForLine(lineNo: number): number | null {
    const markers = this.lineMarkers();
    if (markers.length === 0) return null;
    let idx = 0;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].line <= lineNo) idx = i;
      else break; // data-line 按文档序递增
    }
    const cur = markers[idx];
    const curTop = this.markerTop(cur.el);
    const next = markers[idx + 1];
    if (!next) return Math.max(0, curTop - SYNC_TOP_MARGIN);
    const nextTop = this.markerTop(next.el);
    const span = Math.max(1, next.line - cur.line);
    const frac = Math.min(1, Math.max(0, (lineNo - cur.line) / span));
    return Math.max(0, curTop + (nextTop - curTop) * frac - SYNC_TOP_MARGIN);
  }

  /** 块标记（data-line）按文档序收集 */
  private lineMarkers(): { el: HTMLElement; line: number }[] {
    const out: { el: HTMLElement; line: number }[] = [];
    for (const el of this.contentEl.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(el.dataset.line);
      if (Number.isFinite(line)) out.push({ el, line });
    }
    return out;
  }

  /** 标记元素相对滚动容器内容原点的顶部位置（rect 计算，不受 offsetParent 影响） */
  private markerTop(el: HTMLElement): number {
    return (
      el.getBoundingClientRect().top -
      this.contentEl.getBoundingClientRect().top +
      this.contentEl.scrollTop
    );
  }

  /** 重渲染 / 图片加载后：下一帧按编辑器位置重新校准预览滚动 */
  private scheduleResync(): void {
    this.scheduleSync(() => this.applyEditorToPreview());
  }

  /**
   * rAF 节流执行一次联动：同一帧内后到的事件更新鲜，取消前一次待执行任务，
   * 保证末次事件必达（时间窗丢事件是历史偏移累积的直接原因）。
   */
  private scheduleSync(run: () => void): void {
    if (this.syncRaf !== null) cancelAnimationFrame(this.syncRaf);
    this.syncRaf = requestAnimationFrame(() => {
      this.syncRaf = null;
      run();
    });
  }

  /** 联动条件：双栏 + Markdown + 管线就绪 */
  private canSync(): boolean {
    return this.mode === "split" && this.kind === "md" && this.md !== null;
  }

  private setAreaMode(mode: "edit" | "preview" | "split" | "image"): void {
    this.area.classList.remove("mode-edit", "mode-preview", "mode-split", "mode-image");
    this.area.classList.add(`mode-${mode}`);
  }

  private async renderNow(tab: PreviewTab, kind: "md" | "html"): Promise<void> {
    if (this.activeId !== tab.id || this.mode === "edit") return;
    if (tab.size > PREVIEW_MAX_BYTES) {
      this.contentEl.innerHTML = '<div class="preview-note">文件过大（≥20MB），预览已禁用</div>';
      return;
    }
    if (kind === "md") {
      await this.ensureMarkdown();
      // 先渲染为 DOM：本地图片需在消毒前替换为 data URL
      // （盘符路径会被 DOMPurify 当作未知协议而移除 src）
      const holder = document.createElement("div");
      holder.innerHTML = this.md!.render(tab.content);
      await inlineLocalImages(holder, tab.path);
      // 解析期间可能已切标签 / 切模式：丢弃过期结果
      if (this.isStale(tab)) return;
      // innerHTML 整体替换会把滚动位置重置为 0（输入期间预览"跳回顶部"的元凶）：
      // 先记录再恢复，随后以编辑器位置重新校准
      const scrollTop = this.contentEl.scrollTop;
      // markdown-it html:false + DOMPurify 兜底消毒（data:image 在媒体标签上被允许）
      this.contentEl.innerHTML = this.dompurify!.sanitize(holder.innerHTML);
      this.contentEl.scrollTop = scrollTop;
      this.bindImageLoadResync();
      this.scheduleResync();
    } else {
      // sandbox 仅放行 allow-same-origin 以便把右键事件转回宿主；
      // 未开启 allow-scripts，HTML 内脚本仍不执行
      this.contentEl.innerHTML =
        '<iframe class="preview-iframe" sandbox="allow-same-origin"></iframe>';
      const iframe = this.contentEl.querySelector("iframe")!;
      iframe.srcdoc = tab.content;
      iframe.addEventListener("load", () => this.bindIframeContextMenu(iframe));
    }
  }

  /** 把 iframe 内的右键菜单请求转发给宿主（坐标叠加 iframe 在页面中的位置） */
  private bindIframeContextMenu(iframe: HTMLIFrameElement): void {
    if (!this.onContextMenu) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const rect = iframe.getBoundingClientRect();
      this.onContextMenu?.(rect.left + event.clientX, rect.top + event.clientY);
    });
  }

  /** 异步渲染完成后判断标签 / 模式是否已变化 */
  private isStale(tab: PreviewTab): boolean {
    return this.activeId !== tab.id || this.mode === "edit";
  }

  private async ensureMarkdown(): Promise<void> {
    if (this.md) return;
    if (!this.mdReady) {
      this.mdReady = (async () => {
        try {
          await loadMarkdownPipeline(this);
        } catch (e) {
          // 加载失败（离线 / 缓存损坏）：清空缓存允许重试，抛出友好错误，
          // 避免调用方在 this.md! 上崩溃或静默无预览
          this.md = null;
          this.dompurify = null;
          throw new Error(
            `预览组件加载失败: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })().catch((e) => {
        this.mdReady = null;
        throw e;
      });
    }
    await this.mdReady;
  }

  private dompurify: { sanitize(html: string): string } | null = null;

  /** 管线构建完成后安装（供 loadMarkdownPipeline 回调） */
  installMarkdown(
    md: { render(text: string): string },
    dompurify: { sanitize(html: string): string },
  ): void {
    this.md = md;
    this.dompurify = dompurify;
  }

  /** 导出用：返回消毒后的正文 HTML（md 渲染并内联本地图片；html 先消毒） */
  async getExportBody(tab: PreviewTab): Promise<string> {
    if (kindOf(tab.path) === "md") {
      await this.ensureMarkdown();
      const holder = document.createElement("div");
      holder.innerHTML = this.md!.render(tab.content);
      // 导出文件可能被保存到任意目录：本地图片转 data URL，保证打开即可见
      await inlineLocalImages(holder, tab.path);
      return this.dompurify!.sanitize(holder.innerHTML);
    }
    // html 类文件：导出/打印前也过一遍消毒，避免把原始内容里的
    // <script> / 事件属性原样写进导出文档或无 sandbox 的打印 iframe
    await this.ensureMarkdown();
    return this.dompurify!.sanitize(tab.content);
  }

  // ---- 预览滚动 → 编辑器滚动 ----

  /**
   * 预览滚动 → 编辑器滚动。
   *
   * 历史问题：时间窗（150ms）与 syncFromEditor 的 80ms 共用 lastSyncAt，
   * 滚动手势末尾的事件落在窗口内被丢弃 → 编辑器永久落后一截；
   * 且 onScrollToLine 用 coordsAtPos 定位，目标行未渲染时返回 null，
   * 快速拖动预览滚动条时编辑器完全不动 → 偏移持续放大。
   *
   * 现在改为：rAF 节流 + 顶部边缘所在块 + 块内插值出源行号。
   */
  private onPreviewScroll(): void {
    if (!this.canSync()) return;
    if (performance.now() < this.previewEchoUntil) return;
    this.scheduleSync(() => this.applyPreviewToEditor());
  }

  /** 取预览顶部边缘所在的块，插值出源码行号（支持小数）交给编辑器滚动 */
  private applyPreviewToEditor(): void {
    const markers = this.lineMarkers();
    if (markers.length === 0) return;
    // 全部用视口坐标（getBoundingClientRect）比较：容器顶边与元素顶边同处
    // 一个坐标系。注意不能拿内容坐标（相对滚动原点）和 paneTop 混用。
    // 顶部边缘所在的块 = 最后一个 rect.top <= paneTop 的标记
    // （比"第一个在边缘下方"的标记更稳：预览在块内滚动时编辑器连续跟随，不跳块）
    const paneTop = this.contentEl.getBoundingClientRect().top;
    let idx = -1;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].el.getBoundingClientRect().top <= paneTop + 2) idx = i;
      else break;
    }
    let line: number;
    if (idx < 0) {
      line = markers[0].line;
    } else {
      const cur = markers[idx];
      const next = markers[idx + 1];
      if (!next) {
        line = cur.line;
      } else {
        const curTop = cur.el.getBoundingClientRect().top;
        const nextTop = next.el.getBoundingClientRect().top;
        const frac =
          nextTop > curTop
            ? Math.min(1, Math.max(0, (paneTop - curTop) / (nextTop - curTop)))
            : 0;
        line = cur.line + frac * (next.line - cur.line);
      }
    }
    this.onScrollToLine(line);
  }

  /** 图片异步加载会改变文档高度：加载完成后按编辑器位置重新校准 */
  private bindImageLoadResync(): void {
    for (const img of this.contentEl.querySelectorAll("img")) {
      if (img.complete) continue;
      img.addEventListener("load", () => this.scheduleResync(), { once: true });
    }
  }
}
