/**
 * 编辑器右侧 Minimap 缩略图（零依赖，canvas 实现）。
 *
 * 设计要点（见《编辑器Minimap缩略图_技术设计文档》）：
 * - 以 ViewPlugin 承载：view.setState() 会销毁旧 plugin 并重建，天然跟随标签切换；
 * - 作为 #editor 的 flex 兄弟节点（120px 固定列），不覆盖文本、不压住滚动条；
 * - **固定比例**：每逻辑行固定 2px（不随文档规模压缩），对应 VS Code 的
 *   `minimap.size: proportional` + `scale: 1`；内容高于列高时 Minimap 窗口随编辑器滚动，
 *   不显示独立滚动条，列的位置与宽度始终固定；
 * - 主体为**伪字符纹理**：按行 token 着色，字符格 1px × 2px，生成"字块 + 间隙"；
 * - 颜色优先取语法树 token（与编辑器高亮一致）；未解析到的行才退回逐行扫描，
 *   并采用当前编辑器主题的真实配色；
 * - 视口滑块按 VS Code 的 `computedSliderRatio` 计算：滑块高度 = 可见行数 × 行高，
 *   在窗口内按滚动比例移动；Minimap 内容窗口滚动到「视口首行落在滑块下方」的位置；
 * - 交互：hover 显示滑块、滚轮滚动**编辑器**、点击 / 拖拽跳转、悬停行预览、
 *   选区与搜索命中以叠加层绘制；
 * - 只画容器高度对应的可见行（约 400 行），文档再大绘制成本也不变。
 */

import { type HighlightStyle, syntaxTree } from "@codemirror/language";
import { getSearchQuery, type SearchQuery } from "@codemirror/search";
import type { Extension, Line } from "@codemirror/state";
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { getStyleTags, tags as t, type Tag } from "@lezer/highlight";
import { getConfig } from "../config/settings";
import { editorHighlightStyle } from "./theme";

/** minimap 列宽（px）：与 VS Code maxColumn=120 / scale=1 对齐，避免块状放大 */
const CANVAS_WIDTH = 120;
/** 每个字符在 minimap 上占的横向像素（1px 字符更像 VS Code 的纹理） */
const CHAR_WIDTH = 1;
/** 纹理列数：一行最多显示多少个字符 */
const COLUMNS = CANVAS_WIDTH / CHAR_WIDTH;
/** 编辑区正文最小宽度：parent 宽度减去 minimap 后低于该值即隐藏 */
const MIN_CONTENT_WIDTH = 520;
/** canvas 高度上限，控制绘制与内存 */
const MAX_CANVAS_HEIGHT = 1200;
/** canvas 高度下限（编辑区很矮时仍可点击） */
const MIN_CANVAS_HEIGHT = 60;
/** devicePixelRatio 上限：内存 = 120 × h × 4 × dpr² */
const DPR_CAP = 2;
/** 纹理扫描的字符上限：超长行不该把其余内容压成细线 */
const CHAR_LIMIT = 120;
/**
 * 固定缩放：每逻辑行在 minimap 上固定占 2px（VS Code scale=1 的量级）。
 * 字符格 1px × 2px，保持缩略图纹理感，不放大成块状。
 */
const LINE_HEIGHT = 2;
/** 搜索命中在 minimap 上最多标记多少处（大量命中时只标前 N 处） */
const MAX_SEARCH_MARKS = 2_000;
/** 搜索标记在右缘的宽度（px） */
const SEARCH_MARK_WIDTH = 3;
/** 文档变更后重建的合并窗口（ms） */
const REBUILD_DELAY_MS = 150;

const DOM_CLASS = "cm-minimap";
const HIDDEN_CLASS = "cm-minimap-hidden";

/** 纹理单元类型（K_EMPTY = 空白，不绘制） */
const K_EMPTY = 255;
const K_PLAIN = 0;
const K_COMMENT = 1;
const K_STRING = 2;
const K_KEYWORD = 3;
const K_NUMBER = 4;
const K_VARIABLE = 5;
const K_FUNCTION = 6;
const K_TYPE = 7;
const K_OPERATOR = 8;
const K_ATTRIBUTE = 10;

/** 未走语法树时的逐行扫描分类 → 实际高亮 tag（用于解析当前主题的真实颜色） */
const FALLBACK_TAGS: (readonly Tag[] | null)[] = [
  null, // K_PLAIN
  [t.comment],
  [t.string],
  [t.keyword],
  [t.number],
  [t.variableName],
  [t.function(t.variableName)],
  [t.typeName],
  [t.operator],
  [t.tagName],
  [t.attributeName],
  [t.invalid],
  [t.bool],
  [t.definition(t.variableName)],
];

type Rgb = [number, number, number];

/** 解析 CSS 颜色（主题配色可能是 hex / rgb / rgba） */
function parseCssColor(value: string): Rgb | null {
  const v = value.trim();
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(`${hex[0]}${hex[0]}`, 16);
      const g = parseInt(`${hex[1]}${hex[1]}`, 16);
      const b = parseInt(`${hex[2]}${hex[2]}`, 16);
      if (Number.isNaN(r + g + b)) return null;
      return [r, g, b];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (Number.isNaN(r + g + b)) return null;
      return [r, g, b];
    }
    return null;
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 搜索查询签名：查询内容 / 选项变化时重新扫描命中位置 */
function searchSignature(query: SearchQuery): string {
  if (!query.valid || query.search.length === 0) return "";
  return `${query.search}\u0001${query.caseSensitive ? 1 : 0}${query.regexp ? 1 : 0}${query.wholeWord ? 1 : 0}${query.literal ? 1 : 0}`;
}

/** 关键字表：多语言并集，只用于缩略图着色，误判无副作用 */
const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
  "case", "break", "continue", "class", "extends", "new", "try", "catch", "finally", "throw",
  "async", "await", "yield", "import", "export", "from", "as", "default", "interface", "type",
  "enum", "public", "private", "protected", "static", "void", "def", "elif", "lambda", "pass",
  "with", "in", "is", "not", "and", "or", "fn", "impl", "match", "struct", "use", "mod", "pub",
  "package", "func", "go", "defer", "select", "range", "end", "then", "local", "insert", "update",
  "delete", "where", "null", "true", "false", "undefined",
]);

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code);
}

/** 真正需要着色的运算符；括号 / 逗号 / 分号等标点保持正文色，避免缩略图过花 */
const OPERATOR_CODES = new Set([
  43, // +
  45, // -
  42, // *
  47, // /
  37, // %
  61, // =
  60, // <
  62, // >
  33, // !
  38, // &
  124, // |
  94, // ^
  126, // ~
  63, // ?
]);

class MinimapPlugin implements PluginValue {
  private readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  /** 装饰层：选区 / 搜索命中单独画一层，避免搜索变化时重绘纹理 */
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D | null;
  /** 离屏纹理：先在 120 × 列高 的像素网格上生成字块，再一次性绘制 */
  private readonly textureCanvas: HTMLCanvasElement;
  private readonly textureCtx: CanvasRenderingContext2D | null;
  private textureImage: ImageData | null = null;
  private readonly viewportEl: HTMLElement;
  private readonly hoverEl: HTMLElement;
  private readonly parent: HTMLElement;
  /** 逐行 token 的临时数组（复用，避免每次绘制分配） */
  private readonly charKinds = new Uint8Array(CHAR_LIMIT);

  private hasDoc = false;
  private canvasHeight = 0;
  private canvasWidth = 0;
  /** 内容高度（固定比例）：行数 × LINE_HEIGHT；可能大于列高 */
  private contentHeight = 0;
  /** Minimap 内容窗口的滚动位置（内容坐标，0 = 文档顶部）；由编辑器滚动驱动 */
  private minimapScroll = 0;
  /** 当前编辑器主题实际使用的 HighlightStyle（class 名由它生成） */
  private editorStyle: HighlightStyle | null = null;
  /** 隐藏探针：把 HighlightStyle 生成的 class 解析成真实 CSS 颜色 */
  private readonly colorProbe: HTMLSpanElement;
  /** class 组合 → 颜色槽（0 = 正文色） */
  private readonly classSlots = new Map<string, number>();
  private readonly colorSlots: Rgb[] = [];
  private readonly slotAlpha: number[] = [];
  /** 逐行扫描分类 → 颜色槽（语法树没覆盖到的行用） */
  private readonly fallbackSlots = new Array<number>(FALLBACK_TAGS.length).fill(0);
  /** 叠加层配色（--accent / --warning） */
  private overlayAccent = "#6aa6ff";
  private overlayWarning = "#e0b25c";
  private colorsLoaded = false;
  private overlayHeight = 0;
  /** 上次写入的视口框显隐 */
  private vpVisible: boolean | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  /** 父容器宽度缓存：ResizeObserver 已给出尺寸，拖拽分栏时不再逐帧 getBoundingClientRect */
  private parentWidth = 0;
  private rebuildTimer: number | null = null;
  /** 空闲回调句柄：重建被推迟到浏览器空闲时执行（见 scheduleRebuild） */
  private idleHandle: number | null = null;
  private frame = 0;
  private textureFrame = 0;
  private overlayFrame = 0;
  private dragFrame = 0;
  private dragY = 0;
  private dragging = false;
  /** 按下位置在滑块内部时按位移拖拽（与 VS Code getDesiredScrollTopFromDelta 一致） */
  private draggingSlider = false;
  private dragStartScrollTop = 0;
  private dragStartY = 0;
  /** 拖拽 minimap 空白处时锁定内容坐标基准，避免「跳转 → 指针落在新行」的反馈跑飞 */
  private dragBaseScroll = 0;
  /** 滑块位移 → 编辑器滚动位移的比例（VS Code computedSliderRatio） */
  private sliderRatio = 0;
  private disposed = false;

  /** 搜索命中所在行（升序、去重），只存行号，绘制时再映射到 y */
  private searchLines: number[] = [];
  private searchSig = "";
  private searchTimer: number | null = null;
  private searchIdle: number | null = null;
  /** 悬停预览：显示指针所在文档行，避免误以为 minimap 是纯装饰 */
  private hoverFrame = 0;
  private hoverVisible = false;
  private hoverX = 0;
  private hoverY = 0;
  private hoverLine = 0;
  /** 上一次是否有非空选区：空选区时不再无谓重绘叠加层 */
  private hadSelection = false;

  constructor(private readonly view: EditorView) {
    this.parent = view.dom.parentElement ?? view.dom;

    this.el = document.createElement("div");
    this.el.className = DOM_CLASS;
    this.el.setAttribute("aria-hidden", "true");

    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.overlay = document.createElement("canvas");
    this.overlay.className = "cm-minimap-overlay";
    this.overlayCtx = this.overlay.getContext("2d");
    this.textureCanvas = document.createElement("canvas");
    this.textureCtx = this.textureCanvas.getContext("2d");
    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "cm-minimap-viewport";
    this.el.append(this.canvas, this.overlay, this.viewportEl);

    this.hoverEl = document.createElement("div");
    this.hoverEl.className = "cm-minimap-hover";
    this.hoverEl.setAttribute("aria-hidden", "true");

    // 颜色探针：放在 .cm-editor 内，保证主题注入的 HighlightStyle class 规则能命中；
    // 只读 getComputedStyle，不参与布局。
    this.colorProbe = document.createElement("span");
    this.colorProbe.className = "cm-minimap-color-probe";
    this.colorProbe.setAttribute("aria-hidden", "true");
    this.colorProbe.style.cssText =
      "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:pre;";
    this.view.dom.appendChild(this.colorProbe);

    // 单例保护：ViewPlugin 构造抛异常时 CM 不会调用 destroy，DOM 会残留；
    // 这里先清掉同父容器里的旧 minimap，避免「每打开一个文件多一列」。
    for (const old of this.parent.querySelectorAll(`:scope > .${DOM_CLASS}`)) {
      old.remove();
    }
    for (const old of document.querySelectorAll(".cm-minimap-hover")) {
      old.remove();
    }
    for (const old of document.querySelectorAll(".cm-minimap-color-probe")) {
      if (old !== this.colorProbe) old.remove();
    }

    // 与编辑器并排（#editor 为 flex 容器），插在编辑器之后
    this.parent.insertBefore(this.el, view.dom.nextSibling);
    document.body.append(this.hoverEl);

    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.el.addEventListener("pointerdown", this.onPointerDown);
    this.el.addEventListener("pointermove", this.onPointerMove);
    this.el.addEventListener("pointerup", this.onPointerUp);
    this.el.addEventListener("pointercancel", this.onPointerUp);
    this.el.addEventListener("pointerleave", this.onPointerLeave);
    this.el.addEventListener("wheel", this.onWheel, { passive: false });

    this.parentWidth = this.parent.getBoundingClientRect().width;
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver((entries) => {
        this.parentWidth = entries[0]?.contentRect.width ?? this.parentWidth;
        this.handleResize();
      });
      this.resizeObserver.observe(this.parent);
    }
    // 应用主题（data-theme）或编辑器主题切换不产生等价事务：
    // UI 主题走 MutationObserver，编辑器主题走 update() 的 reconfigure 分支。
    if (typeof MutationObserver === "function") {
      this.themeObserver = new MutationObserver(() => {
        this.resetColors();
        this.scheduleRebuild(true);
      });
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }

    // 先算搜索命中：setState 切标签不触发 update，若新状态里搜索框仍开着，首绘要带上标记
    this.refreshSearchMarks();
    // 注意：插件构造发生在 view.setState / Compartment 重配的 update 内部，
    // 此时 CodeMirror 禁止读取编辑器布局（lineBlockAtHeight 会抛
    // "Reading the editor layout isn't allowed during an update"）。
    // 因此首绘延后到当前 update 结束后的宏任务，而不是在构造函数里同步 rebuild。
    this.scheduleRebuild(true);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      // 文档变了：搜索命中的行号要重算，纹理也要重建
      this.searchSig = "";
      this.searchLines = [];
      this.scheduleRebuild();
      this.scheduleSearchRefresh();
    } else if (update.transactions.some((tr) => tr.reconfigured)) {
      // 主题 / 字号等 Compartment 重配后重绘（调色板取自当前编辑器主题）
      this.resetColors();
      this.scheduleRebuild(true);
    }
    if (update.selectionSet) {
      // 空选区之间来回移动光标不必重绘叠加层；首次产生 / 清除选区时才画一次
      const hasSelection = update.state.selection.ranges.some((range) => !range.empty);
      if (hasSelection || this.hadSelection) {
        this.hadSelection = hasSelection;
        this.scheduleOverlay();
      }
    }
    const sig = searchSignature(getSearchQuery(update.state));
    if (sig !== this.searchSig) {
      this.searchSig = sig;
      if (!sig) this.searchLines = [];
      this.scheduleSearchRefresh();
    }
    // 后台解析推进时语法树会变化（没有 docChanged）：颜色要跟着刷新
    if (syntaxTree(update.state) !== syntaxTree(update.startState)) {
      this.scheduleTexture();
    }
    if (update.geometryChanged || update.viewportChanged) this.scheduleViewport();
  }

  destroy(): void {
    this.disposed = true;
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    if (this.idleHandle !== null) window.cancelIdleCallback(this.idleHandle);
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    if (this.searchIdle !== null) window.cancelIdleCallback(this.searchIdle);
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.textureFrame) cancelAnimationFrame(this.textureFrame);
    if (this.overlayFrame) cancelAnimationFrame(this.overlayFrame);
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.el.removeEventListener("pointerdown", this.onPointerDown);
    this.el.removeEventListener("pointermove", this.onPointerMove);
    this.el.removeEventListener("pointerup", this.onPointerUp);
    this.el.removeEventListener("pointercancel", this.onPointerUp);
    this.el.removeEventListener("pointerleave", this.onPointerLeave);
    this.el.removeEventListener("wheel", this.onWheel);
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.el.remove();
    this.hoverEl.remove();
    this.colorProbe.remove();
  }

  // ---------------------------------------------------------------- 调度

  private scheduleRebuild(immediate = false): void {
    // 已有待执行的重建：文档变更会读到最新内容，不必再排一次
    if (this.rebuildTimer !== null || this.idleHandle !== null) return;
    if (immediate) {
      this.rebuildTimer = window.setTimeout(() => {
        this.rebuildTimer = null;
        if (!this.disposed) this.rebuild();
      }, 0);
      return;
    }
    // 文档变更：先合并连续输入（150ms），再尽量在浏览器空闲时重建。
    // 固定比例后每次只画可见行窗口，但连续输入仍没必要每键重绘一次。
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      if (this.disposed) return;
      if (typeof window.requestIdleCallback === "function") {
        this.idleHandle = window.requestIdleCallback(
          () => {
            this.idleHandle = null;
            if (!this.disposed) this.rebuild();
          },
          // 兜底：持续有交互时也不能让 minimap 永远停在旧内容
          { timeout: 400 },
        );
      } else {
        this.rebuild();
      }
    }, REBUILD_DELAY_MS);
  }

  private scheduleViewport(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed) return;
      // minimap 跟随编辑器滚动：同帧重绘，避免纹理比视口慢一拍
      if (this.updateViewport()) {
        this.drawTexture();
        this.drawOverlay();
      }
    });
  }

  /** 文本 + 叠加层一起重绘（搜索 / 解析等非滚动场景用） */
  private scheduleTexture(): void {
    if (this.textureFrame) return;
    this.textureFrame = requestAnimationFrame(() => {
      this.textureFrame = 0;
      if (this.disposed) return;
      this.drawTexture();
      this.drawOverlay();
      if (this.hoverVisible) this.updateHover();
    });
  }

  /** 选区变化只重绘叠加层（搜索命中行仍沿用上次结果） */
  private scheduleOverlay(): void {
    if (this.overlayFrame) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = 0;
      if (!this.disposed) this.drawOverlay();
    });
  }

  /**
   * 搜索命中扫描：查询变化后合并 200ms 再放到空闲时段执行。
   * 命中数封顶，避免 "单字符搜索" 在超大文档上扫全篇。
   */
  private scheduleSearchRefresh(): void {
    if (this.searchTimer !== null || this.searchIdle !== null) return;
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      if (this.disposed) return;
      const run = (): void => {
        this.searchIdle = null;
        if (this.disposed) return;
        this.refreshSearchMarks();
        this.drawOverlay();
      };
      if (typeof window.requestIdleCallback === "function") {
        this.searchIdle = window.requestIdleCallback(run, { timeout: 400 });
      } else {
        run();
      }
    }, 200);
  }

  private handleResize(): void {
    if (this.disposed) return;
    this.syncVisibility();
    // 宽度变化只影响可见性（纹理宽度固定），高度变化才需要重绘可见行窗口
    if (this.measureHeight() !== this.canvasHeight) this.scheduleRebuild(true);
    this.scheduleViewport();
  }

  /** 宽度不足时整列隐藏（split 模式可拖到编辑区仅剩 15%） */
  private syncVisibility(): void {
    const available = this.parentWidth;
    const tooNarrow = available > 0 && available - CANVAS_WIDTH < MIN_CONTENT_WIDTH;
    this.el.classList.toggle(HIDDEN_CLASS, tooNarrow);
    if (tooNarrow) this.hideHover();
  }

  // ---------------------------------------------------------------- 绘制

  private rebuild(): void {
    const height = this.measureHeight();
    this.syncVisibility();
    this.ensureCanvasSize(height);
    this.hasDoc = this.view.state.doc.length > 0;
    this.contentHeight = this.hasDoc ? this.view.state.doc.lines * LINE_HEIGHT : 0;
    this.clampMinimapScroll();
    this.updateViewport();
    this.drawTexture();
    this.drawOverlay();
  }

  /** canvas 高度 = 编辑区可视高度（clamp），纹理行高固定 */
  private measureHeight(): number {
    const viewH = this.view.scrollDOM.clientHeight;
    return Math.max(MIN_CANVAS_HEIGHT, Math.min(MAX_CANVAS_HEIGHT, Math.round(viewH)));
  }

  private ensureCanvasSize(height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    if (this.canvasHeight !== height || this.canvasWidth !== CANVAS_WIDTH) {
      this.canvasHeight = height;
      this.canvasWidth = CANVAS_WIDTH;
      this.canvas.style.width = `${CANVAS_WIDTH}px`;
      this.canvas.style.height = `${height}px`;
    }
    const pixelW = Math.round(CANVAS_WIDTH * dpr);
    const pixelH = Math.round(height * dpr);
    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW;
      this.canvas.height = pixelH;
    }
  }

  private resetColors(): void {
    this.colorsLoaded = false;
    this.editorStyle = null;
    this.classSlots.clear();
    this.colorSlots.length = 0;
    this.slotAlpha.length = 0;
    this.fallbackSlots.fill(0);
  }

  /** 用编辑器实际 HighlightStyle 解析颜色 */
  private loadColors(): void {
    if (this.colorsLoaded) return;
    this.colorsLoaded = true;
    const ui = getComputedStyle(this.el);
    this.overlayAccent = ui.getPropertyValue("--accent").trim() || "#6aa6ff";
    this.overlayWarning = ui.getPropertyValue("--warning").trim() || "#e0b25c";

    this.editorStyle = editorHighlightStyle(getConfig().editorTheme);
    const editorComputed = getComputedStyle(this.view.dom);
    const plain =
      parseCssColor(getComputedStyle(this.view.contentDOM).color) ??
      parseCssColor(editorComputed.color) ??
      ([200, 200, 200] as Rgb);

    this.classSlots.clear();
    this.colorSlots.length = 0;
    this.colorSlots.push(plain);
    this.slotAlpha.length = 0;
    this.slotAlpha.push(0.62);

    // 逐行扫描分类也走同一套 HighlightStyle：颜色与编辑器一致
    for (let kind = 0; kind < FALLBACK_TAGS.length; kind += 1) {
      if (kind === K_PLAIN) {
        this.fallbackSlots[kind] = 0;
        continue;
      }
      const tags = FALLBACK_TAGS[kind];
      const classes = tags && this.editorStyle ? this.editorStyle.style(tags) : null;
      this.fallbackSlots[kind] = this.slotForClasses(classes);
    }

    // 缩略图底色跟随编辑器主题（UI 主题与编辑器主题可以不同，用 --bg-panel 会不匹配）
    const editorBg = editorComputed.backgroundColor;
    if (editorBg && editorBg !== "rgba(0, 0, 0, 0)") this.el.style.background = editorBg;
  }

  /** 把 HighlightStyle 生成的 class 组合解析成真实 CSS 颜色槽 */
  private slotForClasses(classes: string | null): number {
    if (!classes) return 0;
    const cached = this.classSlots.get(classes);
    if (cached !== undefined) return cached;
    // 槽位上限 255（charKinds 是 Uint8Array；255 留给“空白”）
    if (this.colorSlots.length >= 255) return 0;
    this.colorProbe.className = classes;
    const color =
      parseCssColor(getComputedStyle(this.colorProbe).color) ?? this.colorSlots[0];
    const slot = this.colorSlots.length;
    this.colorSlots.push(color);
    // 接近不透明：保证色相与正文一致；只比正文略淡，避免抢视觉焦点
    this.slotAlpha.push(0.92);
    this.classSlots.set(classes, slot);
    return slot;
  }

  private maxMinimapScroll(): number {
    return Math.max(0, this.contentHeight - this.canvasHeight);
  }

  private clampMinimapScroll(): void {
    this.minimapScroll = Math.max(0, Math.min(this.maxMinimapScroll(), this.minimapScroll));
  }

  /** 绘制当前滚动窗口内的字符纹理（成本只与容器高度有关） */
  private drawTexture(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const height = this.canvasHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS_WIDTH, height);
    const doc = this.view.state.doc;
    if (!this.hasDoc || doc.lines === 0 || height <= 0) return;

    const texture = this.textureCtx;
    if (!texture) return;
    this.loadColors();

    if (this.textureCanvas.width !== CANVAS_WIDTH || this.textureCanvas.height !== height) {
      this.textureCanvas.width = CANVAS_WIDTH;
      this.textureCanvas.height = height;
      this.textureImage = null;
    }
    if (!this.textureImage) {
      this.textureImage = texture.createImageData(CANVAS_WIDTH, height);
    }
    const data = this.textureImage.data;
    data.fill(0);

    const tree = syntaxTree(this.view.state);
    const treeLength = tree.length;
    const hasLanguage = treeLength > 0;
    const scroll = this.minimapScroll;
    const firstLine = Math.max(1, Math.floor(scroll / LINE_HEIGHT) + 1);
    const lastLine = Math.min(
      doc.lines,
      Math.ceil((scroll + height) / LINE_HEIGHT),
    );

    for (let lineNo = firstLine; lineNo <= lastLine; lineNo += 1) {
      const line = doc.line(lineNo);
      const text = line.text;
      if (text.length === 0) continue;
      const y = (lineNo - 1) * LINE_HEIGHT - scroll;
      const rowStart = Math.max(0, Math.floor(y));
      const rowEnd = Math.min(height, Math.ceil(y + LINE_HEIGHT));
      if (rowStart >= rowEnd) continue;

      const limit = Math.min(text.length, CHAR_LIMIT);
      let treeMode = false;
      if (hasLanguage && line.from + limit <= treeLength) {
        // 已解析到的行：直接用语法树 token 对应的真实颜色槽
        this.fillTreeKinds(tree, line, limit);
        treeMode = true;
      } else {
        // 未解析 / 无语言：退回逐行 token 扫描（纯文本不把每个词染成变量色）
        this.tokenizeLine(text, limit, !hasLanguage);
      }

      if (text.length <= COLUMNS) {
        let col = 0;
        for (let i = 0; i < text.length && col < COLUMNS; i += 1) {
          const code = text.charCodeAt(i);
          if (code === 9) {
            col += 4;
            continue;
          }
          const raw = this.charKinds[i];
          if (raw !== K_EMPTY && code !== 32) {
            const slot = treeMode ? raw : (this.fallbackSlots[raw] ?? 0);
            for (let row = rowStart; row < rowEnd; row += 1) {
              this.writeGlyph(data, row, col, slot);
            }
          }
          col += 1;
        }
        continue;
      }

      // 长行按列等距采样（超长行不把整行压成一条实线）
      for (let x = 0; x < COLUMNS; x += 1) {
        const i = Math.floor((x * limit) / COLUMNS);
        const code = text.charCodeAt(i);
        if (code === 32 || code === 9) continue;
        const raw = this.charKinds[i];
        if (raw === K_EMPTY) continue;
        const slot = treeMode ? raw : (this.fallbackSlots[raw] ?? 0);
        for (let row = rowStart; row < rowEnd; row += 1) {
          this.writeGlyph(data, row, x, slot);
        }
      }
    }
    texture.putImageData(this.textureImage, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.textureCanvas, 0, 0, CANVAS_WIDTH, height);
  }

  /** 语法树覆盖的行：把节点对应的真实颜色槽写进 charKinds（内层覆盖外层） */
  private fillTreeKinds(tree: Tree, line: Line, limit: number): void {
    const out = this.charKinds;
    out.fill(0, 0, limit);
    const from = line.from;
    const to = from + limit;
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const style = getStyleTags(node);
        if (!style) return;
        // inherit：颜色由父节点决定，子节点不再重复覆盖
        if (style.inherit) return;
        const classes = this.editorStyle ? this.editorStyle.style(style.tags) : null;
        const slot = this.slotForClasses(classes);
        const start = Math.max(node.from, from) - from;
        const end = Math.min(node.to, to) - from;
        for (let i = start; i < end; i += 1) out[i] = slot;
        // opaque：内部不再分词（字符串 / 注释等整体同色）
        return style.opaque ? false : undefined;
      },
    });
  }

  /** 写一个字符格：横向 CHAR_WIDTH 像素，纵向由调用方按行高铺满 */
  private writeGlyph(
    data: Uint8ClampedArray,
    y: number,
    col: number,
    slot: number,
  ): void {
    const color = this.colorSlots[slot];
    if (!color) return;
    const alpha = Math.round((this.slotAlpha[slot] ?? 0.72) * 255);
    const start = (y * CANVAS_WIDTH + col * CHAR_WIDTH) * 4;
    for (let dx = 0; dx < CHAR_WIDTH; dx += 1) {
      const p = start + dx * 4;
      data[p] = color[0];
      data[p + 1] = color[1];
      data[p + 2] = color[2];
      data[p + 3] = alpha;
    }
  }

  /**
   * 逐行扫描 token：注释 / 字符串 / 数字 / 关键字 / 函数 / 类型 / 属性 / 运算符。
   * 只处理前 limit 个字符，结果写入复用的 charKinds；空白位置留 K_EMPTY。
   * 这是缩略图着色，不是语法树级解析：目标是颜色多样且接近正文，误判无副作用。
   */
  private tokenizeLine(text: string, limit: number, variablesPlain: boolean): void {
    const out = this.charKinds;
    out.fill(K_EMPTY, 0, limit);
    let i = 0;
    let started = false;

    while (i < limit) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9) {
        i += 1;
        continue;
      }

      // 行首注释：`#` 后必须是空白（避免把 CSS 的 `#header` / `#fff` 当注释）。
      // 刻意不把 `--` / `*` 当注释：CSS 自定义属性 `--color: red`、Markdown 列表 `* item`
      // 都很常见，误判代价高于收益。
      if (!started) {
        if (
          c === 35 &&
          (i + 1 >= limit ||
            text.charCodeAt(i + 1) === 32 ||
            text.charCodeAt(i + 1) === 9)
        ) {
          for (; i < limit; i += 1) out[i] = K_COMMENT;
          return;
        }
      }

      // 行内注释：//、/* 与 <!--
      if (c === 47 && i + 1 < limit) {
        const next = text.charCodeAt(i + 1);
        if (next === 47 || next === 42) {
          for (; i < limit; i += 1) out[i] = K_COMMENT;
          return;
        }
      }
      if (
        c === 60 &&
        i + 3 < limit &&
        text.charCodeAt(i + 1) === 33 &&
        text.charCodeAt(i + 2) === 45 &&
        text.charCodeAt(i + 3) === 45
      ) {
        for (; i < limit; i += 1) out[i] = K_COMMENT;
        return;
      }

      started = true;

      if (c === 34 || c === 39 || c === 96) {
        const quote = c;
        out[i] = K_STRING;
        i += 1;
        while (i < limit) {
          const ch = text.charCodeAt(i);
          out[i] = K_STRING;
          i += 1;
          if (ch === 92) {
            if (i < limit) {
              out[i] = K_STRING;
              i += 1;
            }
            continue;
          }
          if (ch === quote) break;
        }
        continue;
      }

      if (isDigit(c) || (c === 46 && i + 1 < limit && isDigit(text.charCodeAt(i + 1)))) {
        out[i] = K_NUMBER;
        i += 1;
        while (i < limit) {
          const ch = text.charCodeAt(i);
          if (isIdentPart(ch) || ch === 46) {
            out[i] = K_NUMBER;
            i += 1;
            continue;
          }
          break;
        }
        continue;
      }

      if (isIdentStart(c)) {
        const start = i;
        i += 1;
        while (i < limit && isIdentPart(text.charCodeAt(i))) i += 1;
        const word = text.slice(start, i);
        if (variablesPlain) {
          // 纯文本 / 无语言：不把普通单词染成变量色
          for (let k = start; k < i; k += 1) out[k] = K_PLAIN;
          continue;
        }
        let kind = K_VARIABLE;
        if (KEYWORDS.has(word)) {
          kind = K_KEYWORD;
        } else {
          // 前一个非空白字符是 '.' → 属性
          let p = start - 1;
          while (p >= 0 && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) p -= 1;
          const prev = p >= 0 ? text.charCodeAt(p) : -1;
          if (prev === 46) {
            kind = K_ATTRIBUTE;
          } else {
            // 后一个非空白字符是 '(' → 函数调用
            let j = i;
            while (j < limit && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j += 1;
            if (text.charCodeAt(j) === 40) kind = K_FUNCTION;
            else if (word.charCodeAt(0) >= 65 && word.charCodeAt(0) <= 90) kind = K_TYPE;
          }
        }
        for (let k = start; k < i; k += 1) out[k] = kind;
        continue;
      }

      out[i] = OPERATOR_CODES.has(c) ? K_OPERATOR : K_PLAIN;
      i += 1;
    }
  }

  /** 叠加层：选区 + 搜索命中；坐标随 Minimap 内容窗口滚动 */
  private drawOverlay(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const w = CANVAS_WIDTH;
    const height = this.canvasHeight;
    if (height <= 0) return;
    if (this.overlayHeight !== height) {
      this.overlayHeight = height;
      this.overlay.style.width = `${w}px`;
      this.overlay.style.height = `${height}px`;
    }
    const pixelW = Math.round(w * dpr);
    const pixelH = Math.round(height * dpr);
    if (this.overlay.width !== pixelW || this.overlay.height !== pixelH) {
      this.overlay.width = pixelW;
      this.overlay.height = pixelH;
    }
    const ctx = this.overlayCtx;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    ctx.globalAlpha = 1;
    if (!this.hasDoc || this.contentHeight <= 0) return;

    this.loadColors();
    const doc = this.view.state.doc;
    const scroll = this.minimapScroll;

    // 选区：整行范围的半透明 accent 覆盖（多选也逐个画，数量由编辑器本身限制）
    let hasSelection = false;
    for (const range of this.view.state.selection.ranges) {
      if (range.empty) continue;
      hasSelection = true;
      const fromLine = doc.lineAt(Math.min(range.from, range.to)).number;
      const toLine = doc.lineAt(Math.max(range.from, range.to)).number;
      const y = (fromLine - 1) * LINE_HEIGHT - scroll;
      const h = Math.max(1, (toLine - fromLine + 1) * LINE_HEIGHT);
      ctx.fillStyle = this.overlayAccent;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(0, y, w, h);
    }
    if (hasSelection) ctx.globalAlpha = 1;

    // 搜索命中：右缘 3px 标记，连续行合并成一段，避免大量 fillRect
    const marks = this.searchLines;
    if (marks.length > 0) {
      ctx.fillStyle = this.overlayWarning;
      ctx.globalAlpha = 0.9;
      let start = marks[0];
      let prev = start;
      for (let i = 1; i < marks.length; i += 1) {
        const line = marks[i];
        if (line === prev + 1) {
          prev = line;
          continue;
        }
        this.fillSearchMark(ctx, start, prev, scroll, w, height);
        start = line;
        prev = line;
      }
      this.fillSearchMark(ctx, start, prev, scroll, w, height);
      ctx.globalAlpha = 1;
    }
  }

  private fillSearchMark(
    ctx: CanvasRenderingContext2D,
    startLine: number,
    endLine: number,
    scroll: number,
    width: number,
    height: number,
  ): void {
    const y = (startLine - 1) * LINE_HEIGHT - scroll;
    const h = (endLine - startLine + 1) * LINE_HEIGHT;
    // 屏幕外的整段直接跳过（命中可能很多）
    if (y + h < 0 || y > height) return;
    ctx.fillRect(width - SEARCH_MARK_WIDTH, y, SEARCH_MARK_WIDTH, h);
  }

  /** 扫描当前搜索查询的命中行（封顶 MAX_SEARCH_MARKS 个命中） */
  private refreshSearchMarks(): void {
    const query = getSearchQuery(this.view.state);
    this.searchSig = searchSignature(query);
    if (!query.valid || query.search.length === 0) {
      this.searchLines = [];
      return;
    }
    const lines: number[] = [];
    let lastLine = -1;
    let count = 0;
    try {
      const cursor = query.getCursor(this.view.state);
      let next = cursor.next();
      while (!next.done) {
        const line = this.view.state.doc.lineAt(next.value.from).number;
        if (line !== lastLine) {
          lines.push(line);
          lastLine = line;
        }
        count += 1;
        if (count >= MAX_SEARCH_MARKS) break;
        next = cursor.next();
      }
    } catch {
      // 正则非法 / 文档中途变化：保持上一轮命中，下一轮再算
      return;
    }
    this.searchLines = lines;
  }

  // ---------------------------------------------------------------- 视口

  /**
   * 视口框：只信 scrollTop / scrollHeight，折行与折叠都自动正确。
   * 与 VS Code 的 proportional Minimap 一致：内容按固定行高排布，
   * Minimap 窗口跟随编辑器滚动，让视口框尽可能居中（文档首尾处自然贴边）。
   * @returns Minimap 滚动位置是否变化（调用方据此重绘可见行窗口）
   */
  private updateViewport(): boolean {
    const scroller = this.view.scrollDOM;
    const total = scroller.scrollHeight;
    const viewH = scroller.clientHeight;
    if (!this.hasDoc || total <= 0 || this.canvasHeight <= 0 || this.contentHeight <= 0) {
      if (this.vpVisible !== false) {
        this.vpVisible = false;
        this.viewportEl.style.display = "none";
      }
      return false;
    }
    const contentH = this.contentHeight;
    const maxScroll = Math.max(0, total - viewH);
    // VS Code proportional Minimap：
    // 滑块高度 = 编辑器可见行数 × minimap 行高；滑块在可见窗口内按滚动比例移动，
    // 内容窗口则滚动到「视口首行正好落在滑块下方」的位置。
    const editorLineH = Math.max(1, this.view.defaultLineHeight);
    const sliderHeight = Math.max(
      1,
      Math.min(contentH, (viewH / editorLineH) * LINE_HEIGHT),
    );
    const maxSliderTop = Math.max(
      0,
      Math.min(this.canvasHeight - sliderHeight, contentH - sliderHeight),
    );
    this.sliderRatio = maxScroll > 0 ? maxSliderTop / maxScroll : 0;
    const sliderTop = Math.max(
      0,
      Math.min(maxSliderTop, scroller.scrollTop * this.sliderRatio),
    );

    // 编辑器视口首行：用 CM 的真实布局，折行 / 折叠下也准。
    // 防御：若本方法被同步调到 view.update() 内部，读取布局会被 CM 拒绝；
    // 此时退回 viewport.from 估算，等之后的 rAF / rebuild 再校正。
    const doc = this.view.state.doc;
    let firstLine: number;
    try {
      if (this.view.viewportLineBlocks.length > 0) {
        const firstBlock = this.view.lineBlockAtHeight(scroller.scrollTop);
        firstLine = doc.lineAt(Math.min(firstBlock.from, doc.length)).number;
      } else {
        firstLine = doc.lineAt(Math.min(this.view.viewport.from, doc.length)).number;
      }
    } catch {
      firstLine = doc.lineAt(Math.min(this.view.viewport.from, doc.length)).number;
    }
    const firstLineY = (firstLine - 1) * LINE_HEIGHT;

    // 让首行渲染在 sliderTop 下方；顶部 / 底部越界时 clamp，滑块自然贴边
    const maxMini = this.maxMinimapScroll();
    const next = Math.round(
      Math.max(0, Math.min(maxMini, firstLineY - sliderTop)),
    );
    const scrollChanged = next !== this.minimapScroll;
    this.minimapScroll = next;

    const visualTop = firstLineY - next;
    const visualHeight = Math.min(this.canvasHeight, sliderHeight);
    if (this.vpVisible !== true) {
      this.vpVisible = true;
      this.viewportEl.style.display = "";
    }
    // 高度写值会作废布局：滚动过程中它其实不变，只在变化时写一次。
    const heightText = `${visualHeight}px`;
    if (this.viewportEl.style.height !== heightText) {
      this.viewportEl.style.height = heightText;
    }
    const top = Math.min(this.canvasHeight - visualHeight, Math.max(0, visualTop));
    this.viewportEl.style.transform = `translateY(${top}px)`;
    return scrollChanged;
  }

  // ---------------------------------------------------------------- 交互

  private onScroll = (): void => {
    this.scheduleViewport();
    // 滚动期间指针下的行已经变了，旧的预览会误导；等下一次 pointermove 再显示
    this.hideHover();
  };

  /** 滚轮在 minimap 上滚动的是编辑器；Minimap 跟随滚动并重绘可见行窗口 */
  private onWheel = (e: WheelEvent): void => {
    const scroller = this.view.scrollDOM;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1;
    const next = scroller.scrollTop + e.deltaY * unit;
    scroller.scrollTop = Math.max(0, Math.min(maxScroll, next));
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const vp = this.viewportEl.getBoundingClientRect();
    // 按在滑块上：按位移拖拽（VS Code getDesiredScrollTopFromDelta）
    const onSlider = vp.height > 0 && e.clientY >= vp.top && e.clientY <= vp.bottom;
    this.dragging = true;
    this.draggingSlider = onSlider;
    this.dragBaseScroll = this.minimapScroll;
    this.dragStartY = e.clientY;
    this.dragStartScrollTop = this.view.scrollDOM.scrollTop;
    this.el.classList.add("cm-minimap-dragging");
    this.el.setPointerCapture(e.pointerId);
    if (onSlider) {
      this.queueHover(e.clientX, e.clientY);
    } else {
      this.jumpToLine(this.lineAtClientY(e.clientY, this.dragBaseScroll));
      this.queueHover(e.clientX, e.clientY);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragging) this.queueDrag(e.clientY);
    this.queueHover(e.clientX, e.clientY);
  };

  private onPointerUp = (): void => {
    this.dragging = false;
    this.draggingSlider = false;
    this.el.classList.remove("cm-minimap-dragging");
  };

  private onPointerLeave = (): void => {
    this.hideHover();
  };

  /** 拖拽按帧合并：一帧内多次 pointermove 只写一次 scrollTop，避免预览侧抖动 */
  private queueDrag(clientY: number): void {
    this.dragY = clientY;
    if (this.dragFrame) return;
    this.dragFrame = requestAnimationFrame(() => {
      this.dragFrame = 0;
      if (this.disposed || !this.dragging) return;
      if (this.draggingSlider) this.dragSliderTo(this.dragY);
      else this.jumpToLine(this.lineAtClientY(this.dragY, this.dragBaseScroll));
    });
  }

  /** 拖拽视口滑块：按位移换算（VS Code getDesiredScrollTopFromDelta 同款） */
  private dragSliderTo(clientY: number): void {
    const scroller = this.view.scrollDOM;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0 || this.sliderRatio <= 0) return;
    const next =
      this.dragStartScrollTop + (clientY - this.dragStartY) / this.sliderRatio;
    scroller.scrollTop = Math.max(0, Math.min(maxScroll, next));
  }

  /** 点击 / 拖拽 minimap 空白处：把对应逻辑行放到编辑器视口中央 */
  private jumpToLine(line: number): void {
    const doc = this.view.state.doc;
    const target = Math.max(1, Math.min(doc.lines, line));
    const block = this.view.lineBlockAt(doc.line(target).from);
    const scroller = this.view.scrollDOM;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) return;
    const centered = block.top - (scroller.clientHeight - block.height) / 2;
    scroller.scrollTop = Math.max(0, Math.min(maxScroll, centered));
  }

  private lineAtClientY(clientY: number, baseScroll = this.minimapScroll): number {
    const rect = this.el.getBoundingClientRect();
    const contentY = clientY - rect.top + baseScroll;
    return Math.floor(contentY / LINE_HEIGHT) + 1;
  }

  private queueHover(clientX: number, clientY: number): void {
    this.hoverX = clientX;
    this.hoverY = clientY;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      if (!this.disposed) this.updateHover();
    });
  }

  /** 悬停预览：显示指针所在文档行（含缩略内容），避免 minimap 只能靠盲点 */
  private updateHover(): void {
    if (this.draggingSlider) {
      this.hideHover();
      return;
    }
    if (!this.hasDoc || this.contentHeight <= 0) {
      this.hideHover();
      return;
    }
    const rect = this.el.getBoundingClientRect();
    if (rect.height <= 0) {
      this.hideHover();
      return;
    }
    const baseScroll = this.dragging ? this.dragBaseScroll : this.minimapScroll;
    const contentY = this.hoverY - rect.top + baseScroll;
    if (contentY < 0 || contentY >= this.contentHeight) {
      this.hideHover();
      return;
    }
    const lines = this.view.state.doc.lines;
    const line = Math.min(lines, Math.max(1, Math.floor(contentY / LINE_HEIGHT) + 1));
    if (line !== this.hoverLine) {
      const text = this.view.state.doc.line(line).text.replace(/\s+/g, " ").trim();
      this.hoverEl.textContent = text
        ? `第 ${line} 行 · ${text.slice(0, 100)}`
        : `第 ${line} 行 · （空行）`;
      this.hoverLine = line;
    }
    if (!this.hoverVisible) {
      this.hoverVisible = true;
      this.hoverEl.classList.add("visible");
    }
    // 固定宽度上限已知，不需要 offsetWidth（避免悬停时反复强制布局）
    const maxX = Math.max(8, window.innerWidth - 440);
    const maxY = Math.max(8, window.innerHeight - 56);
    this.hoverEl.style.left = `${Math.max(8, Math.min(this.hoverX + 14, maxX))}px`;
    this.hoverEl.style.top = `${Math.max(8, Math.min(this.hoverY + 16, maxY))}px`;
  }

  private hideHover(): void {
    if (!this.hoverVisible) return;
    this.hoverVisible = false;
    this.hoverEl.classList.remove("visible");
    this.hoverLine = 0;
  }
}

/** 返回 minimap 扩展；是否启用由 Compartment（layout.minimap）决定 */
export function minimapExtension(): Extension {
  return ViewPlugin.fromClass(MinimapPlugin);
}
