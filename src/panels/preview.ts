/**
 * 预览宿主（状态机）：
 * - Markdown：markdown-it(html:false) + DOMPurify + highlight.js（管线见 preview/markdownPipeline.ts，懒加载），
 *   块级元素打 data-line 标记，双栏滚动联动
 * - HTML：沙箱 iframe（allow-same-origin，未开启 allow-scripts，脚本不执行；CSS/图片正常渲染）
 * - 模式：编辑 / 预览 / 双栏（md/html 可切换；超过 20MB 禁用预览）
 * - 图片标签走 mode-image（渲染见 preview/imageViewer.ts）
 *
 * 导出（独立文档 / 打印 / HTML→Markdown）在 preview/export.ts，
 * 本地图片内联在 preview/localImages.ts。
 */

import type { EditorView } from "@codemirror/view";
import { pathKindOf as kindOf } from "./preview/pathKind";
import { loadMarkdownPipeline } from "./preview/markdownPipeline";
import { EXPORT_IMAGE_MAX_BYTES, inlineLocalImages } from "./preview/localImages";
import { renderImageViewer } from "./preview/imageViewer";
import { PreviewFindBar, type PreviewFindScope } from "./preview/findBar";
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
 * 一侧被程序滚动后，窗口内对侧抛出的 scroll 事件视为回显忽略，避免双向追赶。
 * 程序滚动事件 1~2 帧内必到；偶发超时只会让对侧多同步一次，不会振荡。
 */
const PREVIEW_ECHO_MS = 120;

export class PreviewHost {
  private mode: PreviewMode = "edit";
  private kind: PreviewKind = null;
  /** 预览内查找条（Markdown / HTML 生效，图片与编辑模式关闭） */
  private readonly findBar: PreviewFindBar;
  private activeId: string | null = null;
  private mdReady: Promise<void> | null = null;
  private md: { render(text: string): string } | null = null;
  private dompurify: { sanitize(html: string): string } | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private contentEl: HTMLElement;
  /** 已渲染到预览区的标签 id（HTML 同标签重渲染时保留滚动位置） */
  private renderedTabId: string | null = null;
  /** 渲染代际：await 后据此丢弃被更新渲染取代的旧结果 */
  private renderSeq = 0;

  // ---- 双栏滚动联动状态 ----
  /** 最近一次参与联动的编辑器视图（供重渲染 / 图片加载后校准用） */
  private syncView: EditorView | null = null;
  /** rAF 句柄：连续滚动每帧最多同步一次，保证末次事件必达（时间窗丢事件会累积偏移） */
  private syncRaf: number | null = null;
  /** 预览被本类程序滚动后，窗口内其 scroll 事件视为回显直接忽略 */
  private previewEchoUntil = 0;

  // ---- 块标记缓存（双栏滚动联动的热路径）----
  /** 块标记及其内容坐标（相对滚动内容原点）；null = 需重建 */
  private markerCache: { line: number; top: number }[] | null = null;
  /** 建缓存时的内容高度：图片加载 / 重渲染会改变它，作为失效信号 */
  private markerCacheHeight = -1;

  constructor(
    private pane: HTMLElement,
    private area: HTMLElement,
    private onScrollToLine: (line: number) => void,
    /**
     * HTML 预览渲染在 iframe 内，右键事件不会冒泡到宿主；
     * 通过同源访问 iframe 文档转发，坐标已换算为页面坐标。
     */
    private onContextMenu?: (x: number, y: number) => void,
    /** 图片标签的自然宽高回报（状态栏展示用） */
    private onImageSize?: (tabId: string, width: number, height: number) => void,
  ) {
    this.pane.innerHTML = '<div class="preview-content"></div>';
    this.contentEl = this.pane.querySelector<HTMLElement>(".preview-content")!;
    this.contentEl.addEventListener("scroll", () => this.onPreviewScroll());
    this.findBar = new PreviewFindBar(this.pane, () => this.findScope());
    // 窗口尺寸变化会改变块高度：丢弃标记缓存，下一帧重建
    window.addEventListener("resize", () => {
      this.markerCache = null;
    });
  }

  /** 移除预览区残留的图片工具条，避免连续打开图片时叠加 */
  private clearImageToolbar(): void {
    this.pane.querySelectorAll(".image-toolbar").forEach((el) => el.remove());
  }

  /** 标签/模式变化时调用：应用布局并按需渲染 */
  apply(tab: PreviewTab | null, mode: PreviewMode): void {
    const prevId = this.activeId;
    this.activeId = tab?.id ?? null;
    // 立即渲染会取代待触发的防抖渲染，避免同一内容渲染两次
    this.cancelScheduledRender();
    this.clearImageToolbar();
    if (tab?.kind === "image") {
      this.kind = null;
      this.renderedTabId = null;
      this.contentEl.classList.remove("md-doc");
      this.findBar.forget();
      this.setAreaMode("image");
      renderImageViewer(this.pane, this.contentEl, tab, (w, h) =>
        this.onImageSize?.(tab.id, w, h),
      );
      return;
    }
    this.kind = tab ? kindOf(tab.path) : null;
    // 非 md/html（或无标签）：上一次的渲染结果已无意义，立即释放 DOM。
    // 只切 CSS class 的话，整棵预览树（含 data URL 图片与 iframe 文档）会一直驻留。
    if (!this.kind) {
      this.releaseContent();
      this.findBar.forget();
      this.mode = "edit";
      this.setAreaMode("edit");
      return;
    }
    this.mode = mode;
    // 编辑模式下预览不可见：查找条收起（切回预览时由 renderNow 重建命中，不会自动弹出）
    if (mode === "edit") this.findBar.close();
    // 换到另一个标签且新模式是编辑：上一个标签的渲染结果不会再被复用。
    // 同一标签内 编辑/预览 互切仍保留（切回零延迟），属缓存而非泄漏。
    if (this.mode === "edit" && prevId !== this.activeId) this.releaseContent();
    this.setAreaMode(this.mode);
    if (this.mode !== "edit" && tab) {
      this.renderSafe(tab, this.kind);
    }
  }

  // ---- 预览内查找 ----

  /** 打开查找条；图片 / 编辑模式下的预览不可见，调用方应先自行判断 */
  openFind(): boolean {
    if (this.kind === null || this.mode === "edit") return false;
    this.findBar.open();
    return true;
  }

  closeFind(): void {
    this.findBar.close();
  }

  isFindOpen(): boolean {
    return this.findBar.isOpen();
  }

  /** 查找作用域：Markdown 为预览容器，HTML 为 iframe 文档（需已 load） */
  private findScope(): PreviewFindScope | null {
    if (this.kind === "md") {
      return {
        root: this.contentEl,
        win: window,
        reveal: (range) => {
          const rect = range.getBoundingClientRect();
          const box = this.contentEl.getBoundingClientRect();
          const top =
            this.contentEl.scrollTop + (rect.top - box.top) - this.contentEl.clientHeight / 2;
          this.contentEl.scrollTop = Math.max(0, top);
        },
      };
    }
    if (this.kind === "html") {
      const iframe = this.contentEl.querySelector("iframe");
      const win = iframe?.contentWindow;
      const doc = iframe?.contentDocument;
      if (!win || !doc?.body) return null;
      return {
        root: doc.body,
        win,
        reveal: (range) => {
          const rect = range.getBoundingClientRect();
          win.scrollTo({
            top: Math.max(0, win.scrollY + rect.top - win.innerHeight / 2),
            behavior: "auto",
          });
        },
      };
    }
    return null;
  }

  /** 关闭标签：若面板正展示它，释放其渲染结果 */
  forgetTab(tabId: string): void {
    if (this.activeId !== tabId) return;
    this.activeId = null;
    this.releaseContent();
    this.kind = null;
  }

  /** 释放预览 DOM：清空后 data URL 字符串与 iframe 文档树才会被回收。
   *  不重置 kind：调用方可能仍需为当前标签渲染，置空由 forgetTab / 不可预览分支负责 */
  private releaseContent(): void {
    this.cancelScheduledRender();
    // 先清高亮：Range 随 DOM 释放而失效，留着会在下次搜索时抛错
    this.findBar.forget();
    this.contentEl.innerHTML = "";
    this.contentEl.classList.remove("md-doc");
    this.clearImageToolbar();
    this.markerCache = null;
    this.renderedTabId = null;
  }

  /** 取消待触发的防抖渲染（立即渲染 / 释放内容时调用） */
  private cancelScheduledRender(): void {
    if (!this.renderTimer) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  /** 编辑内容变化后的防抖重渲染：内容快照由调用方在真正渲染时再取 */
  scheduleRender(getTab: () => PreviewTab): void {
    if (this.mode === "edit" || !this.kind) return;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      const kind = this.kind;
      if (!kind || this.mode === "edit") return;
      const tab = getTab();
      if (this.activeId !== tab.id) return;
      this.renderSafe(tab, kind);
    }, 300);
  }

  /** 渲染并兜底错误：组件加载失败时在预览区显示原因，绝不静默空白 */
  private renderSafe(tab: PreviewTab, kind: "md" | "html"): void {
    const seq = ++this.renderSeq;
    this.renderNow(tab, kind, seq).catch((e) => {
      if (this.isStale(tab, seq)) return;
      console.error("[preview] 渲染失败", e);
      this.findBar.close();
      this.contentEl.innerHTML = "";
      this.markerCache = null;
      this.renderedTabId = null;
      const note = document.createElement("div");
      note.className = "preview-note";
      note.textContent = String(e instanceof Error ? e.message : e);
      this.contentEl.append(note);
    });
  }

  /**
   * 编辑器滚动 → 预览滚动（双栏 Markdown）：
   * rAF 节流保证末次事件必达；高度图取顶部行，再按块标记插值到亚行精度。
   * 不用共享时间窗：手势末次事件被丢弃会让偏移永久累积。
   */
  syncFromEditor(view: EditorView): void {
    // 先记录视图：首次切到双栏时也能按编辑器当前滚动位置校准
    this.syncView = view;
    if (!this.canSync()) return;
    // 这里不能判断 previewEchoUntil：它标记的是"预览刚被本类滚动"，
    // 编辑器侧回显已由 PreviewController 在事件入口过滤，在此再判断会吞掉真实滚动。
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
      // 编辑器重建 / 销毁期间高度图可能不可用：跳过本轮，下一次滚动会重新触发
      return;
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
    const next = markers[idx + 1];
    if (!next) return Math.max(0, cur.top - SYNC_TOP_MARGIN);
    const span = Math.max(1, next.line - cur.line);
    const frac = Math.min(1, Math.max(0, (lineNo - cur.line) / span));
    return Math.max(0, cur.top + (next.top - cur.top) * frac - SYNC_TOP_MARGIN);
  }

  /**
   * 块标记（data-line）按内容坐标缓存：渲染 / 图片加载 / 尺寸变化后重建，
   * 滚动热路径只读数值数组，避免逐帧 querySelectorAll 与 getBoundingClientRect。
   */
  private lineMarkers(): { line: number; top: number }[] {
    const height = this.contentEl.scrollHeight;
    if (this.markerCache !== null && this.markerCacheHeight === height) {
      return this.markerCache;
    }
    const contentTop =
      this.contentEl.getBoundingClientRect().top - this.contentEl.scrollTop;
    const markers: { line: number; top: number }[] = [];
    for (const el of this.contentEl.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(el.dataset.line);
      if (!Number.isFinite(line)) continue;
      markers.push({ line, top: el.getBoundingClientRect().top - contentTop });
    }
    markers.sort((a, b) => a.top - b.top);
    this.markerCache = markers;
    this.markerCacheHeight = height;
    return markers;
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

  private async renderNow(
    tab: PreviewTab,
    kind: "md" | "html",
    seq: number,
  ): Promise<void> {
    if (this.isStale(tab, seq)) return;
    if (tab.size > PREVIEW_MAX_BYTES) {
      this.contentEl.innerHTML =
        '<div class="preview-note">文件过大（超过 20MB），预览已禁用</div>';
      this.markerCache = null;
      this.renderedTabId = null;
      return;
    }
    if (kind === "md") {
      this.contentEl.classList.add("md-doc");
      await this.ensureMarkdown();
      // 管线加载期间可能已切走：不必再渲染整篇文档
      if (this.isStale(tab, seq)) return;
      // 先渲染为 DOM：本地图片需在消毒前替换为 data URL
      // （盘符路径会被 DOMPurify 当作未知协议而移除 src）
      const holder = document.createElement("div");
      holder.innerHTML = this.md!.render(tab.content);
      await inlineLocalImages(holder, tab.path);
      // 解析期间可能已切标签 / 切模式，或已有更新的渲染：丢弃过期结果
      if (this.isStale(tab, seq)) return;
      // innerHTML 替换会重置滚动位置：先记录再恢复（双栏下随后按编辑器位置校准）
      const scrollTop = this.contentEl.scrollTop;
      // markdown-it html:false + DOMPurify 兜底消毒（data:image 在媒体标签上被允许）
      this.contentEl.innerHTML = this.dompurify!.sanitize(holder.innerHTML);
      this.contentEl.scrollTop = scrollTop;
      this.renderedTabId = tab.id;
      // 新内容：块标记缓存必须重建（scrollHeight 变化不一定能完全反映）
      this.markerCache = null;
      this.bindImageLoadResync();
      this.scheduleResync();
      // 内容已换：按当前查询重建命中（高亮的 Range 指向旧 DOM）
      this.findBar.revive();
    } else {
      this.contentEl.classList.remove("md-doc");
      // 同一标签重渲染（编辑停顿 / 模式切换）保留 iframe 滚动位置；换标签仍从顶部开始
      let prevScroll = 0;
      if (this.renderedTabId === tab.id) {
        try {
          prevScroll = this.contentEl.querySelector("iframe")?.contentWindow?.scrollY ?? 0;
        } catch {
          // iframe 内链接已跳到跨源页面：读不到滚动值
        }
      }
      // sandbox 仅放行 allow-same-origin 以便把右键事件转回宿主；
      // 未开启 allow-scripts，HTML 内脚本仍不执行
      this.contentEl.innerHTML =
        '<iframe class="preview-iframe" sandbox="allow-same-origin"></iframe>';
      const iframe = this.contentEl.querySelector("iframe")!;
      iframe.srcdoc = tab.content;
      iframe.addEventListener("load", () => {
        this.bindIframeContextMenu(iframe);
        // iframe 文档就绪后才能遍历文本
        this.findBar.revive();
      });
      if (prevScroll > 0) {
        // 只恢复首帧：iframe 内后续导航不应被拉回原位置
        iframe.addEventListener(
          "load",
          () => {
            try {
              iframe.contentWindow?.scrollTo(0, prevScroll);
            } catch {
              // 跨源页面无法恢复滚动
            }
          },
          { once: true },
        );
      }
      this.renderedTabId = tab.id;
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

  /** 异步渲染完成后判断标签 / 模式是否已变化，或已有更新的渲染 */
  private isStale(tab: PreviewTab, seq: number): boolean {
    return (
      seq !== this.renderSeq || this.activeId !== tab.id || this.mode === "edit"
    );
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
      await inlineLocalImages(holder, tab.path, EXPORT_IMAGE_MAX_BYTES);
      return this.dompurify!.sanitize(holder.innerHTML);
    }
    // html 类文件：导出/打印前也过一遍消毒，避免把原始内容里的
    // <script> / 事件属性原样写进导出文档或无 sandbox 的打印 iframe
    await this.ensureMarkdown();
    return this.dompurify!.sanitize(tab.content);
  }

  // ---- 预览滚动 → 编辑器滚动 ----

  /**
   * 预览滚动 → 编辑器滚动（双栏 Markdown）：
   * rAF 节流 + 顶部边缘所在块 + 块内插值出源行号，
   * 避免目标行未渲染或末次事件被丢弃时无法定位。
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
    // 全部用内容坐标比较：容器滚动量即"预览顶部边缘"在内容坐标中的位置
    // （scrollTop 与缓存的 top 同一坐标系，无需逐帧读取 rect）
    const threshold = this.contentEl.scrollTop + 2;
    let idx = -1;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].top <= threshold) idx = i;
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
        const span = next.top - cur.top;
        const frac =
          span > 0 ? Math.min(1, Math.max(0, (threshold - cur.top) / span)) : 0;
        line = cur.line + frac * (next.line - cur.line);
      }
    }
    this.onScrollToLine(line);
  }

  /** 图片异步加载会改变文档高度：加载完成后按编辑器位置重新校准 */
  private bindImageLoadResync(): void {
    for (const img of this.contentEl.querySelectorAll("img")) {
      if (img.complete) continue;
      img.addEventListener(
        "load",
        () => {
          // 高度变化：丢弃块标记缓存后再校准
          this.markerCache = null;
          this.scheduleResync();
        },
        { once: true },
      );
    }
  }
}
