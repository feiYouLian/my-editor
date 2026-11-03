/**
 * 编辑器右侧 Minimap 缩略图（零依赖，canvas 实现）。
 *
 * 设计要点（见《编辑器Minimap缩略图_技术设计文档》）：
 * - 以 ViewPlugin 承载：view.setState() 会销毁旧 plugin 并重建，天然跟随标签切换；
 * - 作为 #editor 的 flex 兄弟节点（120px 固定列），不覆盖文本、不压住滚动条；
 * - **固定比例**：每逻辑行固定 2px（不随文档规模压缩）；内容高于列高时
 *   minimap 自己滚动（滚轮），但**不显示滚动条**，列的位置与宽度始终固定；
 * - 主体为**伪字符纹理**：按行 token 着色，在 120 列像素格上生成"字块 + 间隙"；
 * - 颜色优先取语法树 token（与编辑器高亮一致）；未解析到的行才退回逐行扫描，
 *   并采用当前编辑器主题的真实配色；
 * - 视口框只信 scrollTop / scrollHeight 比例；minimap 不跟随编辑器自动滚动，
 *   滚动只由用户在 minimap 上滚动产生，避免"位置一直在动"；
 * - 交互：hover 显示滑块、滚轮滚动 minimap、点击 / 拖拽跳转、悬停行预览、
 *   选区与搜索命中以叠加层绘制；
 * - 只画容器高度对应的可见行（约 800 行），文档再大绘制成本也不变。
 */

import { syntaxTree } from "@codemirror/language";
import { getSearchQuery, type SearchQuery } from "@codemirror/search";
import type { Extension, Line } from "@codemirror/state";
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { getStyleTags, tagHighlighter, tags as t } from "@lezer/highlight";
import { findUserTheme, getConfig } from "../config/settings";
import { customThemeName } from "../config/userThemes";

/** minimap 列宽（px）：与 VS Code 默认 maxColumn（120）对齐，能多看一截代码 */
const WIDTH = 120;
/** 编辑区正文最小宽度：parent 宽度减去 minimap 后低于该值即隐藏 */
const MIN_CONTENT_WIDTH = 520;
/** canvas 高度上限，控制绘制与内存 */
const MAX_CANVAS_HEIGHT = 1200;
/** canvas 高度下限（编辑区很矮时仍可点击） */
const MIN_CANVAS_HEIGHT = 60;
/** devicePixelRatio 上限：内存 = 80 × h × 4 × dpr² */
const DPR_CAP = 2;
/** 纹理扫描的字符上限：超长行不该把其余内容压成细线 */
const CHAR_LIMIT = 120;
/**
 * 固定缩放：每逻辑行在 minimap 上固定占 2px（与 VS Code scale=1 同量级）。
 * 内容高度 = 行数 × 2；超过列高时 minimap 自己滚动（滚轮），列本身不移动。
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
const K_TAG = 9;
const K_ATTRIBUTE = 10;
const K_INVALID = 11;
const K_ATOM = 12;
const K_DEFINITION = 13;

/** 各类型在 minimap 上的透明度：普通文本更淡，关键字 / 字符串更明显 */
const KIND_ALPHA = [
  0.55, 0.5, 0.75, 0.8, 0.72, 0.68, 0.78, 0.74, 0.6, 0.76, 0.68, 0.9, 0.75, 0.65,
];

type Rgb = [number, number, number];

/** 深色 / 高对比主题：one-dark 的语法色 */
const DARK_PALETTE: Rgb[] = [
  [171, 178, 191], // plain（ivory）
  [125, 135, 153], // comment（stone）
  [152, 195, 121], // string（sage）
  [198, 120, 221], // keyword（violet）
  [209, 154, 102], // number（whiskey）
  [224, 108, 117], // variable（coral）
  [97, 175, 239], // function（malibu）
  [229, 192, 123], // type / class（chalky）
  [86, 182, 194], // operator（cyan）
  [224, 108, 117], // tag（coral）
  [224, 108, 117], // property / attribute（coral）
  [255, 255, 255], // invalid
  [209, 154, 102], // atom / bool（whiskey）
  [171, 178, 191], // definition（one-dark 的 definition(name) 是 ivory）
];

/** 浅色主题：CM 默认高亮色（比正文更饱和，缩略图里才看得出来） */
const LIGHT_PALETTE: Rgb[] = [
  [31, 35, 40], // plain
  [153, 68, 0], // comment
  [170, 17, 17], // string
  [119, 0, 136], // keyword
  [17, 102, 68], // number
  [31, 35, 40], // variable（CM 默认不单独着色）
  [31, 35, 40], // function（CM 默认不给函数调用单独着色）
  [0, 136, 85], // type
  [31, 35, 40], // operator（CM 默认不单独着色）
  [31, 35, 40], // tag（CM 默认不单独着色）
  [31, 35, 40], // property / attribute（定义属性名单独走 K_DEFINITION）
  [255, 0, 0], // invalid
  [34, 17, 153], // atom / bool
  [0, 0, 255], // definition（CM 默认 definition(variableName) 是蓝色）
];

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

/**
 * 当前编辑器主题的 minimap 调色板。
 * 内置主题用 one-dark / CM 默认色；自定义主题直接取 theme.syntax，
 * 保证 minimap 与正文的语法色一致。
 */
function paletteForConfig(): Rgb[] {
  const setting = getConfig().editorTheme;
  if (setting === "light") return LIGHT_PALETTE;
  if (setting === "high-contrast") return DARK_PALETTE;
  const name = customThemeName(setting);
  const theme = name ? findUserTheme(name) : null;
  if (!theme) return DARK_PALETTE;
  const base = theme.dark ? DARK_PALETTE : LIGHT_PALETTE;
  const lookup = (value: string | undefined, fallback: Rgb): Rgb => {
    const parsed = value ? parseCssColor(value) : null;
    return parsed ?? fallback;
  };
  return [
    lookup(theme.ui.foreground, base[K_PLAIN]),
    lookup(theme.syntax.comment, base[K_COMMENT]),
    lookup(theme.syntax.string, base[K_STRING]),
    lookup(theme.syntax.keyword, base[K_KEYWORD]),
    lookup(theme.syntax.number, base[K_NUMBER]),
    lookup(theme.syntax.variableName, base[K_VARIABLE]),
    lookup(theme.syntax.function, base[K_FUNCTION]),
    lookup(theme.syntax.typeName, base[K_TYPE]),
    lookup(theme.syntax.operator, base[K_OPERATOR]),
    lookup(theme.syntax.tagName, base[K_TAG]),
    lookup(theme.syntax.attributeName ?? theme.syntax.propertyName, base[K_ATTRIBUTE]),
    lookup(theme.syntax.invalid, base[K_INVALID]),
    lookup(theme.syntax.number, base[K_ATOM]),
    lookup(theme.syntax.variableName, base[K_DEFINITION]),
  ];
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

/**
 * 语法树 → minimap 分类的映射。分类本身仍复用 K_*，
 * 这样调色板可以按「当前编辑器主题」统一取色。
 */
const MINIMAP_HIGHLIGHTER = tagHighlighter([
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword],
    class: "mm-kw",
  },
  { tag: [t.string, t.processingInstruction, t.inserted], class: "mm-str" },
  { tag: [t.number], class: "mm-num" },
  {
    tag: [
      t.bool,
      t.atom,
      t.null,
      t.constant(t.name),
      t.standard(t.name),
      t.color,
      t.special(t.variableName),
    ],
    class: "mm-atom",
  },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "mm-com" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
    class: "mm-fn",
  },
  { tag: [t.typeName, t.className, t.namespace, t.modifier, t.self], class: "mm-type" },
  { tag: [t.propertyName, t.attributeName, t.macroName], class: "mm-prop" },
  { tag: [t.tagName], class: "mm-tag" },
  {
    tag: [t.variableName, t.local(t.variableName), t.deleted, t.character],
    class: "mm-var",
  },
  {
    tag: [t.definition(t.variableName), t.definition(t.propertyName), t.definition(t.typeName)],
    class: "mm-def",
  },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.regexp, t.escape, t.special(t.string)],
    class: "mm-op",
  },
  { tag: [t.link], class: "mm-link" },
  { tag: [t.heading], class: "mm-head" },
  { tag: [t.meta], class: "mm-meta" },
  { tag: [t.invalid], class: "mm-bad" },
]);

const CLASS_KIND = new Map<string, number>([
  ["mm-kw", K_KEYWORD],
  ["mm-str", K_STRING],
  ["mm-num", K_NUMBER],
  ["mm-atom", K_ATOM],
  ["mm-com", K_COMMENT],
  ["mm-fn", K_FUNCTION],
  ["mm-type", K_TYPE],
  ["mm-prop", K_ATTRIBUTE],
  ["mm-tag", K_TAG],
  ["mm-var", K_VARIABLE],
  ["mm-def", K_DEFINITION],
  ["mm-op", K_OPERATOR],
  ["mm-link", K_COMMENT],
  ["mm-head", K_VARIABLE],
  ["mm-meta", K_COMMENT],
  ["mm-bad", K_INVALID],
]);

/** class 字符串 → 分类的缓存（class 组合有限，避免每个节点都 split） */
const CLASS_KIND_CACHE = new Map<string, number | null>();

function kindFromClasses(classes: string | null): number | null {
  if (!classes) return null;
  if (CLASS_KIND_CACHE.has(classes)) return CLASS_KIND_CACHE.get(classes) ?? null;
  let kind: number | null = null;
  for (const cls of classes.split(" ")) {
    const mapped = CLASS_KIND.get(cls);
    if (mapped !== undefined) {
      kind = mapped;
      break;
    }
  }
  CLASS_KIND_CACHE.set(classes, kind);
  return kind;
}

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
  /** 离屏纹理：先在 80 × 列高 的像素网格上生成字块，再一次性绘制 */
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
  /** minimap 自身的滚动位置（内容坐标，0 = 文档顶部）；只由用户滚轮改变 */
  private minimapScroll = 0;
  /** 当前主题的 minimap 调色板 */
  private palette: Rgb[] | null = null;
  /** 叠加层配色（--accent / --warning） */
  private overlayAccent = "#6aa6ff";
  private overlayWarning = "#e0b25c";
  private colorsLoaded = false;
  private overlayHeight = 0;
  /** 上次写入的视口框高度与显隐：滚动时高度不变，避免每帧写 style 触发布局失效 */
  private vpHeight = -1;
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
  /** 按下位置在滑块内部时记录偏移：拖拽不再把指针位置当作滑块顶 */
  private draggingSlider = false;
  private dragOffset = 0;
  /** 拖拽期间锁定 minimap 滚动基准：避免「跳转 → 指针落在新行」的反馈跑飞 */
  private dragBaseScroll = 0;
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

    // 同步首绘：切标签时 setState 会重建本插件，同步绘制可避免空列闪一帧
    // 先算搜索命中：setState 切标签不触发 update，若新状态里搜索框仍开着，首绘要带上标记
    this.refreshSearchMarks();
    this.rebuild();
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
      if (!this.disposed) this.updateViewport();
    });
  }

  /** 文本 + 叠加层一起重绘（minimap 自身滚动时用） */
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
    const tooNarrow = available > 0 && available - WIDTH < MIN_CONTENT_WIDTH;
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
    if (this.canvasHeight !== height || this.canvasWidth !== WIDTH) {
      this.canvasHeight = height;
      this.canvasWidth = WIDTH;
      this.canvas.style.width = `${WIDTH}px`;
      this.canvas.style.height = `${height}px`;
    }
    const pixelW = Math.round(WIDTH * dpr);
    const pixelH = Math.round(height * dpr);
    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW;
      this.canvas.height = pixelH;
    }
  }

  private resetColors(): void {
    this.colorsLoaded = false;
    this.palette = null;
  }

  /** 读取叠加层 CSS 配色，并按当前编辑器主题生成 minimap 调色板 */
  private loadColors(): void {
    if (this.colorsLoaded) return;
    this.colorsLoaded = true;
    const style = getComputedStyle(this.el);
    this.overlayAccent = style.getPropertyValue("--accent").trim() || "#6aa6ff";
    this.overlayWarning = style.getPropertyValue("--warning").trim() || "#e0b25c";
    this.palette = paletteForConfig();
    // 缩略图底色跟随编辑器主题（UI 主题与编辑器主题可以不同，用 --bg-panel 会不匹配）
    const editorBg = getComputedStyle(this.view.dom).backgroundColor;
    if (editorBg && editorBg !== "rgba(0, 0, 0, 0)") this.el.style.background = editorBg;
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
    ctx.clearRect(0, 0, WIDTH, height);
    const doc = this.view.state.doc;
    if (!this.hasDoc || doc.lines === 0 || height <= 0) return;

    const texture = this.textureCtx;
    if (!texture) return;
    this.loadColors();
    const palette = this.palette ?? DARK_PALETTE;

    if (this.textureCanvas.width !== WIDTH || this.textureCanvas.height !== height) {
      this.textureCanvas.width = WIDTH;
      this.textureCanvas.height = height;
      this.textureImage = null;
    }
    if (!this.textureImage) {
      this.textureImage = texture.createImageData(WIDTH, height);
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
      if (hasLanguage && line.from + limit <= treeLength) {
        // 已解析到的行：直接用语法树 token，颜色与编辑器一致
        this.fillTreeKinds(tree, line, limit);
      } else {
        // 未解析 / 无语言：退回逐行 token 扫描（纯文本不把每个词染成变量色）
        this.tokenizeLine(text, limit, !hasLanguage);
      }

      if (text.length <= WIDTH) {
        let col = 0;
        for (let i = 0; i < text.length && col < WIDTH; i += 1) {
          const code = text.charCodeAt(i);
          if (code === 9) {
            col += 4;
            continue;
          }
          const kind = this.charKinds[i];
          if (kind !== K_EMPTY && code !== 32) {
            for (let row = rowStart; row < rowEnd; row += 1) {
              this.writePixel(data, row, col, palette[kind], kind);
            }
          }
          col += 1;
        }
        continue;
      }

      // 长行按列等距采样（超长行不把整行压成一条实线）
      for (let x = 0; x < WIDTH; x += 1) {
        const i = Math.floor((x * limit) / WIDTH);
        const code = text.charCodeAt(i);
        if (code === 32 || code === 9) continue;
        const kind = this.charKinds[i];
        if (kind === K_EMPTY) continue;
        for (let row = rowStart; row < rowEnd; row += 1) {
          this.writePixel(data, row, x, palette[kind], kind);
        }
      }
    }
    texture.putImageData(this.textureImage, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.textureCanvas, 0, 0, WIDTH, height);
  }

  /** 语法树覆盖的行：把节点 tag 写进 charKinds（内层节点覆盖外层） */
  private fillTreeKinds(tree: Tree, line: Line, limit: number): void {
    const out = this.charKinds;
    out.fill(K_PLAIN, 0, limit);
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
        const kind = kindFromClasses(MINIMAP_HIGHLIGHTER.style(style.tags));
        if (kind !== null) {
          const start = Math.max(node.from, from) - from;
          const end = Math.min(node.to, to) - from;
          for (let i = start; i < end; i += 1) out[i] = kind;
        }
        // opaque：内部不再分词（字符串 / 注释等整体同色）
        return style.opaque ? false : undefined;
      },
    });
  }

  private writePixel(
    data: Uint8ClampedArray,
    y: number,
    x: number,
    color: Rgb | undefined,
    kind: number,
  ): void {
    if (!color) return;
    const p = (y * WIDTH + x) * 4;
    data[p] = color[0];
    data[p + 1] = color[1];
    data[p + 2] = color[2];
    data[p + 3] = Math.round((KIND_ALPHA[kind] ?? 0.6) * 255);
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

  /** 叠加层：选区 + 搜索命中；坐标随 minimap 自身滚动 */
  private drawOverlay(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const w = WIDTH;
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
   * minimap 自身的滚动位置不自动跟随编辑器（位置固定），
   * 视口框超出当前可见窗口时直接隐藏，用户滚回来看得到。
   */
  private updateViewport(): void {
    const scroller = this.view.scrollDOM;
    const total = scroller.scrollHeight;
    const viewH = scroller.clientHeight;
    if (!this.hasDoc || total <= 0 || this.canvasHeight <= 0 || this.contentHeight <= 0) {
      if (this.vpVisible !== false) {
        this.vpVisible = false;
        this.viewportEl.style.display = "none";
      }
      return;
    }
    const contentH = this.contentHeight;
    const boxH = Math.max(8, Math.min(contentH, (viewH / total) * contentH));
    const maxBoxTop = Math.max(0, contentH - boxH);
    const maxScroll = Math.max(0, total - viewH);
    const boxTop = maxScroll > 0 ? (scroller.scrollTop / maxScroll) * maxBoxTop : 0;

    const visualTop = boxTop - this.minimapScroll;
    const visualHeight = Math.min(this.canvasHeight, boxH);
    if (visualTop + visualHeight <= 0 || visualTop >= this.canvasHeight) {
      if (this.vpVisible !== false) {
        this.vpVisible = false;
        this.viewportEl.style.display = "none";
      }
      // 仍记录真实高度，滚回可见窗口时滑块尺寸立即正确
      if (this.vpHeight !== boxH) this.vpHeight = boxH;
      return;
    }

    if (this.vpVisible !== true) {
      this.vpVisible = true;
      this.viewportEl.style.display = "";
    }
    // 高度写值会作废布局：滚动过程中它其实不变，只在变化时写一次。
    // 注意隐藏期间 vpHeight 仍会更新，所以显示时不能只看 vpHeight 是否变化。
    this.vpHeight = boxH;
    const heightText = `${visualHeight}px`;
    if (this.viewportEl.style.height !== heightText) {
      this.viewportEl.style.height = heightText;
    }
    const top = Math.min(this.canvasHeight - visualHeight, Math.max(0, visualTop));
    this.viewportEl.style.transform = `translateY(${top}px)`;
  }

  // ---------------------------------------------------------------- 交互

  private onScroll = (): void => {
    this.scheduleViewport();
    // 滚动期间指针下的行已经变了，旧的预览会误导；等下一次 pointermove 再显示
    this.hideHover();
  };

  /**
   * 滚轮在 minimap 上滚动 minimap 自身（内容高于列高时）。
   * 内容不足一屏时退回滚动编辑器，保持原有便利。
   */
  private onWheel = (e: WheelEvent): void => {
    const maxMini = this.maxMinimapScroll();
    if (maxMini > 0) {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? this.canvasHeight : 1;
      const next = Math.round(this.minimapScroll + e.deltaY * unit);
      this.minimapScroll = Math.max(0, Math.min(maxMini, next));
      this.updateViewport();
      this.scheduleTexture();
      return;
    }
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
    // 按在滑块上：保持按下点与滑块顶的偏移，拖拽不会先跳一下
    const onSlider = vp.height > 0 && e.clientY >= vp.top && e.clientY <= vp.bottom;
    this.dragging = true;
    this.draggingSlider = onSlider;
    this.dragBaseScroll = this.minimapScroll;
    this.dragOffset = onSlider ? e.clientY - vp.top : 0;
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
    this.dragOffset = 0;
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

  /** 拖拽视口滑块：按内容坐标换算，保持按下点与滑块顶的偏移 */
  private dragSliderTo(clientY: number): void {
    const rect = this.el.getBoundingClientRect();
    if (rect.height <= 0) return;
    const boxH = Math.max(1, this.vpHeight);
    const maxBoxTop = Math.max(1, this.contentHeight - boxH);
    const contentY = clientY - rect.top + this.dragBaseScroll - this.dragOffset;
    const ratio = Math.min(1, Math.max(0, contentY / maxBoxTop));
    const scroller = this.view.scrollDOM;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) return;
    scroller.scrollTop = ratio * maxScroll;
  }

  /** 点击 minimap 时，把对应逻辑行定位到编辑器视口顶部 */
  private jumpToLine(line: number): void {
    const doc = this.view.state.doc;
    const target = Math.max(1, Math.min(doc.lines, line));
    const block = this.view.lineBlockAt(doc.line(target).from);
    const scroller = this.view.scrollDOM;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) return;
    scroller.scrollTop = Math.max(0, Math.min(maxScroll, block.top));
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
