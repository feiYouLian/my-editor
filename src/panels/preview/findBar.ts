/**
 * 预览面板查找条：输入框 + 命中计数 + 上一个 / 下一个 / 关闭。
 *
 * 高亮用 CSS Custom Highlight API（不往文本里插 `<mark>`）：
 * - 改 DOM 会改变 `scrollHeight`，破坏双栏滚动联动的块标记缓存，也会被下次重渲染冲掉；
 * - Highlight 只挂 Range，内容重建后重扫一遍即可，且对 `<pre>` 的排版零影响。
 * 不支持该 API 时（老 WebKitGTK）退化为「只跳转不高亮」，不影响可用性。
 */

/** 一次搜索的作用域：Markdown 是预览容器，HTML 是 iframe 文档 */
export interface PreviewFindScope {
  /** 搜索根节点（遍历其下文本节点） */
  root: Node;
  /** 高亮注册与滚动所在的 window（HTML 预览为 iframe 的 contentWindow） */
  win: Window;
  /** 把某条命中滚到视口中部 */
  reveal(range: Range): void;
}

/** 命中上限：超过后只保留前 N 条，避免超长文档把主线程拖住 */
const MAX_MATCHES = 2000;
/** 输入防抖（对齐侧栏查找的 150ms 量级） */
const DEBOUNCE_MS = 120;
const HL_ALL = "preview-find";
const HL_CURRENT = "preview-find-current";
/** 这些标签内的文本不参与搜索 */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "SVG", "CANVAS", "IFRAME"]);

/** 跨 document 的 Highlight 注册表（TS 的 lib.dom 未覆盖，统一窄类型） */
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
type HighlightCtor = new (...ranges: Range[]) => unknown;

export class PreviewFindBar {
  private readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private ranges: Range[] = [];
  /** 当前命中下标（-1 = 尚未定位） */
  private current = -1;
  private timer: number | null = null;
  private opened = false;
  /** 已注册高亮的 window：关闭 / 释放时从这里清理，避免跨 iframe 残留 */
  private hlWin: Window | null = null;

  constructor(
    private readonly pane: HTMLElement,
    /** 每次搜索时重新取作用域：HTML 预览的 iframe 文档可能在渲染后才就绪 */
    private readonly getScope: () => PreviewFindScope | null,
  ) {
    this.el = document.createElement("div");
    this.el.className = "preview-findbar hidden";

    this.input = document.createElement("input");
    this.input.className = "preview-find-input";
    this.input.type = "text";
    this.input.placeholder = "在预览中查找";
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "在预览中查找");

    this.countEl = document.createElement("span");
    this.countEl.className = "preview-find-count";

    const prev = this.button("↑", "上一个（Shift+Enter）");
    const next = this.button("↓", "下一个（Enter）");
    const close = this.button("×", "关闭（Esc）");

    prev.addEventListener("click", () => this.step(-1));
    next.addEventListener("click", () => this.step(1));
    close.addEventListener("click", () => this.close());

    this.input.addEventListener("input", () => this.scheduleSearch());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
      // 查找条内的按键不再外溢给全局分发器 / 编辑器
      e.stopPropagation();
    });

    this.el.append(this.input, this.countEl, prev, next, close);
    this.pane.prepend(this.el);
  }

  private button(label: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preview-find-btn";
    b.textContent = label;
    b.title = title;
    return b;
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** 打开并聚焦；已有查询时立即重跑 */
  open(): void {
    this.opened = true;
    this.el.classList.remove("hidden");
    // 面板隐藏时布局为 0，滚动定位要等一帧后再做（这里只负责高亮与聚焦）
    this.input.focus();
    this.input.select();
    if (this.input.value.trim()) this.runSearch(true);
    else this.renderCount();
  }

  /** 关闭：隐藏并清除高亮，保留查询词（再次打开可继续） */
  close(): void {
    this.opened = false;
    this.el.classList.add("hidden");
    this.clearHighlights();
    this.ranges = [];
    this.current = -1;
    this.renderCount();
  }

  /** 内容释放 / 切到不可预览的标签：关闭并清空查询 */
  forget(): void {
    this.close();
    this.input.value = "";
    this.renderCount();
  }

  /** 预览内容重渲染后调用：按当前查询重新扫描（高亮的 Range 已随 DOM 失效） */
  revive(): void {
    if (!this.opened) return;
    if (!this.input.value.trim()) {
      this.clearHighlights();
      this.ranges = [];
      this.current = -1;
      this.renderCount();
      return;
    }
    this.runSearch(true);
  }

  // ------------------------------------------------------------------ 搜索

  private scheduleSearch(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.runSearch(true);
    }, DEBOUNCE_MS);
  }

  private runSearch(resetIndex: boolean): void {
    this.clearHighlights();
    this.ranges = [];
    this.current = -1;

    const query = this.input.value.trim();
    if (!query) {
      this.renderCount();
      return;
    }
    const scope = this.getScope();
    if (!scope) {
      this.renderCount();
      return;
    }

    const doc = scope.root.ownerDocument ?? document;
    const needle = query.toLowerCase();
    const walker = doc.createTreeWalker(scope.root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        // 查找条自身（Markdown 场景下就在同一文档里）
        if (parent.closest(".preview-findbar, .image-toolbar")) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    outer: for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      const haystack = text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        const range = doc.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + query.length);
        this.ranges.push(range);
        if (this.ranges.length >= MAX_MATCHES) break outer;
        from = at + Math.max(1, needle.length);
      }
    }

    if (resetIndex) this.current = this.ranges.length > 0 ? 0 : -1;
    this.applyHighlights();
    this.renderCount();
    if (this.current >= 0) this.getScope()?.reveal(this.ranges[this.current]);
  }

  /** 上一个 / 下一个；未定位时从第一条开始 */
  private step(delta: number): void {
    if (this.ranges.length === 0) return;
    if (this.current < 0) this.current = delta > 0 ? 0 : this.ranges.length - 1;
    else this.current = (this.current + delta + this.ranges.length) % this.ranges.length;
    this.applyHighlights();
    this.renderCount();
    const range = this.ranges[this.current];
    this.getScope()?.reveal(range);
  }

  private renderCount(): void {
    const query = this.input.value.trim();
    if (!query) {
      this.countEl.textContent = "";
      return;
    }
    if (this.ranges.length === 0) {
      this.countEl.textContent = "无结果";
      return;
    }
    this.countEl.textContent = `${this.current + 1}/${this.ranges.length}`;
  }

  // ------------------------------------------------------------------ 高亮

  private applyHighlights(): void {
    const scope = this.getScope();
    if (!scope) return;
    const { registry, Highlight } = highlightApi(scope.win);
    if (!registry || !Highlight) return;
    this.clearHighlights();
    this.ensureScopeStyle(scope);
    registry.set(HL_ALL, new Highlight(...this.ranges));
    const range = this.ranges[this.current];
    if (range) registry.set(HL_CURRENT, new Highlight(range));
    this.hlWin = scope.win;
  }

  private clearHighlights(): void {
    const win = this.hlWin;
    if (!win) return;
    const { registry } = highlightApi(win);
    registry?.delete(HL_ALL);
    registry?.delete(HL_CURRENT);
    this.hlWin = null;
  }

  /**
   * iframe 文档没有宿主的样式表：把 `::highlight()` 规则注入它的 head。
   * Markdown 场景的规则写在本文件的 main.css 里，这里跳过。
   */
  private ensureScopeStyle(scope: PreviewFindScope): void {
    if (scope.win === window) return;
    const doc = scope.root.ownerDocument;
    if (!doc?.head || doc.getElementById("preview-find-style")) return;
    const style = doc.createElement("style");
    style.id = "preview-find-style";
    style.textContent = `::highlight(${HL_ALL}){background-color:rgba(76,141,255,0.35);color:inherit}
::highlight(${HL_CURRENT}){background-color:rgba(255,176,46,0.9);color:#1b1d23}`;
    doc.head.append(style);
  }
}

/** 取目标 window 的 Highlight 能力（老引擎缺任一即退化为只跳转） */
function highlightApi(win: Window): { registry: HighlightRegistry | null; Highlight: HighlightCtor | null } {
  const scope = win as unknown as {
    CSS?: { highlights?: HighlightRegistry };
    Highlight?: HighlightCtor;
  };
  const registry = scope.CSS?.highlights ?? null;
  const Highlight = typeof scope.Highlight === "function" ? scope.Highlight : null;
  return { registry: registry && Highlight ? registry : null, Highlight };
}
