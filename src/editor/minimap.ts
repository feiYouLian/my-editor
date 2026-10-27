/**
 * 编辑器右侧 Minimap 缩略图（零依赖，canvas 实现）。
 *
 * 设计要点（见《编辑器Minimap缩略图_技术设计文档》）：
 * - 以 ViewPlugin 承载：view.setState() 会销毁旧 plugin 并重建，天然跟随标签切换；
 * - 作为 #editor 的 flex 兄弟节点（80px 固定列），不覆盖文本、不压住滚动条；
 * - 密度带按逻辑行累计进桶（文档行号近似）：条宽取桶内平均行长、透明度取非空行密度；
 *   视口框只信 scrollTop / scrollHeight 比例，因此折行、代码折叠下框位置依然正确；
 * - 着色为**启发式**（注释 / 字符串 / 关键字 / 数字 / 普通，见 classifyLine），
 *   不建语法树：全文档着色成本与灰度同量级，真语法色需解析树 + 视口增量，代价高一个数量级；
 * - 滚动期不重绘 canvas（视口框是独立 DOM，只改 transform），只在文档变更 / 重配时重建；
 * - 规模降级：> 5 万行改桶采样（成本恒定 ~0.2ms），> 20 万行只画视口框。
 */

import type { Extension, Text } from "@codemirror/state";
import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";

/** minimap 列宽（px） */
const WIDTH = 80;
/** 编辑区正文最小宽度：parent 宽度减去 minimap 后低于该值即隐藏 */
const MIN_CONTENT_WIDTH = 520;
/** 全量扫描行数上限，超过改桶采样 */
const MAX_SCAN_LINES = 50_000;
/** 密度带行数上限，超过只画视口框 */
const MAX_DENSITY_LINES = 200_000;
/** canvas 高度上限（桶数即高度），控制绘制与内存 */
const MAX_CANVAS_HEIGHT = 1200;
/** canvas 高度下限（编辑区很矮时仍可点击） */
const MIN_CANVAS_HEIGHT = 60;
/** devicePixelRatio 上限：内存 = 80 × h × 4 × dpr² */
const DPR_CAP = 2;
/** 条宽归一化的行长度上限（字符）：超长行不该把其余内容压成细线 */
const LINE_WIDTH_CAP = 120;
/**
 * 着色分类的行数上限：分类成本与行数线性（5 万行约 2.9ms），
 * 超过则按步长抽样分类——颜色只取桶内相对比例，抽样不影响观感，也保住重建预算。
 */
const CLASSIFY_MAX_LINES = 20_000;
/** 文档变更后重建密度的合并窗口（ms） */
const REBUILD_DELAY_MS = 150;

const DOM_CLASS = "cm-minimap";
const HIDDEN_CLASS = "cm-minimap-hidden";

/** 行分类（启发式着色用）：普通 / 注释 / 字符串 / 关键字 / 数字 */
const KIND_PLAIN = 0;
const KIND_COMMENT = 1;
const KIND_STRING = 2;
const KIND_KEYWORD = 3;
const KIND_NUMBER = 4;
const KIND_COUNT = 5;

/** 各分类的颜色变量（canvas 无法直接用 CSS 变量，绘制前解析一次） */
const KIND_VARS = ["--text-primary", "--mm-comment", "--mm-string", "--mm-keyword", "--mm-number"];
const KIND_FALLBACK = ["#e6e8ee", "#7d8799", "#98c379", "#c678dd", "#d19a66"];

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

/** 关键字按首字符分组：用 startsWith 判定，避免每行 slice 分配字符串 */
const KEYWORD_GROUPS = new Map<number, string[]>();
for (const keyword of KEYWORDS) {
  const head = keyword.charCodeAt(0);
  const group = KEYWORD_GROUPS.get(head);
  if (group) group.push(keyword);
  else KEYWORD_GROUPS.set(head, [keyword]);
}

/**
 * 行分类（只看行首最多 24 字符，成本与行长无关）：
 * 注释标记 → 注释；引号开头 → 字符串；数字开头 → 数字；首个标识符是关键字 → 关键字；其余普通。
 * 只有整行同色的近似，不做行内分词——缩略图每桶只 1px 高，行内混合看不出来。
 */
function classifyLine(text: string): number {
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i += 1;
  }
  if (i >= text.length) return KIND_PLAIN;
  const first = text.charCodeAt(i);
  const second = text.charCodeAt(i + 1);
  // 注释：// 、# 、-- 、* (块注释续行)、<!--
  if (
    (first === 47 && second === 47) ||
    first === 35 ||
    (first === 45 && second === 45) ||
    first === 42 ||
    (first === 60 && second === 33)
  ) {
    return KIND_COMMENT;
  }
  if (first === 34 || first === 39 || first === 96) return KIND_STRING;
  if (first >= 48 && first <= 57) return KIND_NUMBER;
  const group = KEYWORD_GROUPS.get(first);
  if (group) {
    for (const keyword of group) {
      if (!text.startsWith(keyword, i)) continue;
      const next = i + keyword.length;
      if (next >= text.length) return KIND_KEYWORD;
      const c = text.charCodeAt(next);
      const isWord =
        (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;
      if (!isWord) return KIND_KEYWORD;
    }
  }
  return KIND_PLAIN;
}

/**
 * 一个桶的统计：
 * - fill：非空行数（决定透明度，反映"这里有多少内容"）
 * - len：非空行总字符数（决定条宽，反映"行有多长"，是 minimap 的主要视觉特征）
 * - kinds：按分类累积的字符数（桶 × 分类），绘制时取前两类分段着色
 * 只有非空行都差不多长的文档，单看 fill 会得到几乎等宽的色块，故前两者结合。
 */
interface Bands {
  fill: Uint16Array;
  len: Float32Array;
  kinds: Uint16Array;
}

/**
 * 密度缓存：Text 不可变，同一份文档只扫一次。
 * 键用 state.doc（不是 EditorState），避免与 stateCache 的淘汰策略耦合。
 */
const densityCache = new WeakMap<object, { bands: Bands | null; height: number }>();

/** 全量扫描：每行累计到对应桶（成本 ≈ 行数，5 万行约 1ms） */
function scanFull(doc: Text, buckets: number): Bands {
  const fill = new Uint16Array(buckets);
  const len = new Float32Array(buckets);
  const kinds = new Uint16Array(buckets * KIND_COUNT);
  const lines = doc.lines;
  const stride = Math.max(1, Math.ceil(lines / CLASSIFY_MAX_LINES));
  let i = 0;
  for (const text of doc.iterLines()) {
    const bucket = Math.min(buckets - 1, Math.floor((i * buckets) / lines));
    if (text.length > 0) {
      fill[bucket] += 1;
      len[bucket] += text.length;
      // 大文档按步长抽样分类（颜色比例用桶内相对值，不影响观感）
      if (i % stride === 0) {
        kinds[bucket * KIND_COUNT + classifyLine(text)] += text.length;
      }
    }
    i += 1;
  }
  return { fill, len, kinds };
}

/** 桶采样：每桶只取一行（成本 ≈ 桶数，与文档规模无关） */
function scanSampled(doc: Text, buckets: number): Bands {
  const fill = new Uint16Array(buckets);
  const len = new Float32Array(buckets);
  const kinds = new Uint16Array(buckets * KIND_COUNT);
  const lines = doc.lines;
  const step = Math.max(1, Math.floor(lines / buckets));
  for (let n = 1; n <= lines; n += step) {
    const bucket = Math.min(buckets - 1, Math.floor(((n - 1) * buckets) / lines));
    const line = doc.line(n);
    if (line.length > 0) {
      fill[bucket] += 1;
      len[bucket] += line.length;
      kinds[bucket * KIND_COUNT + classifyLine(line.text)] += line.length;
    }
  }
  return { fill, len, kinds };
}

function buildDensity(doc: Text, buckets: number): Bands | null {
  if (doc.length === 0 || doc.lines > MAX_DENSITY_LINES) return null;
  const cached = densityCache.get(doc);
  if (cached && cached.height === buckets) return cached.bands;
  const bands =
    doc.lines <= MAX_SCAN_LINES ? scanFull(doc, buckets) : scanSampled(doc, buckets);
  densityCache.set(doc, { bands, height: buckets });
  return bands;
}

class MinimapPlugin implements PluginValue {
  private readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly viewportEl: HTMLElement;
  private readonly parent: HTMLElement;

  private bands: Bands | null = null;
  private hasDoc = false;
  private canvasHeight = 0;
  private canvasWidth = 0;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private rebuildTimer: number | null = null;
  private frame = 0;
  private dragFrame = 0;
  private dragY = 0;
  private dragging = false;
  private disposed = false;

  constructor(private readonly view: EditorView) {
    this.parent = view.dom.parentElement ?? view.dom;

    this.el = document.createElement("div");
    this.el.className = DOM_CLASS;
    this.el.setAttribute("aria-hidden", "true");

    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "cm-minimap-viewport";
    this.el.append(this.canvas, this.viewportEl);

    // 与编辑器并排（#editor 为 flex 容器），插在编辑器之后
    this.parent.insertBefore(this.el, view.dom.nextSibling);

    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.el.addEventListener("pointerdown", this.onPointerDown);
    this.el.addEventListener("pointermove", this.onPointerMove);
    this.el.addEventListener("pointerup", this.onPointerUp);
    this.el.addEventListener("pointercancel", this.onPointerUp);

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.parent);
    }
    // 应用主题（data-theme）切换不产生编辑器事务，单独观察以刷新 canvas 配色
    if (typeof MutationObserver === "function") {
      this.themeObserver = new MutationObserver(() => this.scheduleRebuild(true));
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }

    this.syncVisibility();
    // 同步首绘：切标签时 setState 会重建本插件，同步绘制可避免空列闪一帧
    this.rebuild();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.scheduleRebuild();
    } else if (update.transactions.some((tr) => tr.reconfigured)) {
      // 主题 / 字号等 Compartment 重配后重绘（canvas 配色取自 CSS 变量）
      this.scheduleRebuild(true);
    }
    if (update.geometryChanged || update.viewportChanged) this.scheduleViewport();
  }

  destroy(): void {
    this.disposed = true;
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.dragFrame) cancelAnimationFrame(this.dragFrame);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.el.removeEventListener("pointerdown", this.onPointerDown);
    this.el.removeEventListener("pointermove", this.onPointerMove);
    this.el.removeEventListener("pointerup", this.onPointerUp);
    this.el.removeEventListener("pointercancel", this.onPointerUp);
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.el.remove();
  }

  // ---------------------------------------------------------------- 调度

  private scheduleRebuild(immediate = false): void {
    if (this.rebuildTimer !== null) return;
    this.rebuildTimer = window.setTimeout(
      () => {
        this.rebuildTimer = null;
        if (!this.disposed) this.rebuild();
      },
      immediate ? 0 : REBUILD_DELAY_MS,
    );
  }

  private scheduleViewport(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed) this.updateViewport();
    });
  }

  private handleResize(): void {
    if (this.disposed) return;
    this.syncVisibility();
    this.scheduleRebuild(true);
    this.scheduleViewport();
  }

  /** 宽度不足时整列隐藏（split 模式可拖到编辑区仅剩 15%） */
  private syncVisibility(): void {
    const available = this.parent.getBoundingClientRect().width;
    const tooNarrow = available > 0 && available - WIDTH < MIN_CONTENT_WIDTH;
    this.el.classList.toggle(HIDDEN_CLASS, tooNarrow);
  }

  // ---------------------------------------------------------------- 绘制

  private rebuild(): void {
    const height = this.measureHeight();
    this.syncVisibility();
    this.hasDoc = this.view.state.doc.length > 0;
    this.bands = this.hasDoc
      ? buildDensity(this.view.state.doc, Math.max(1, height))
      : null;
    this.draw(height);
    this.updateViewport();
  }

  /** canvas 高度 = 编辑区可视高度（clamp），1 桶 ≈ 1px */
  private measureHeight(): number {
    const viewH = this.view.scrollDOM.clientHeight;
    return Math.max(MIN_CANVAS_HEIGHT, Math.min(MAX_CANVAS_HEIGHT, Math.round(viewH)));
  }

  /** 解析各分类的主题色（视口框配色走 CSS 的 --accent，不在此处） */
  private kindColors(): string[] {
    const style = getComputedStyle(this.el);
    return KIND_VARS.map(
      (name, i) => style.getPropertyValue(name).trim() || KIND_FALLBACK[i],
    );
  }

  private draw(height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    const w = WIDTH;
    if (this.canvasHeight !== height || this.canvasWidth !== w) {
      this.canvasHeight = height;
      this.canvasWidth = w;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${height}px`;
    }
    const pixelW = Math.round(w * dpr);
    const pixelH = Math.round(height * dpr);
    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW;
      this.canvas.height = pixelH;
    }

    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    this.viewportEl.style.display = this.hasDoc ? "" : "none";
    const bands = this.bands;
    if (!bands) return;

    const colors = this.kindColors();
    const buckets = bands.fill.length;
    // 归一化基准：平均行长与填充密度各自取最大值，避免一方主导视觉
    let maxAvgLen = 1;
    let maxFill = 1;
    for (let i = 0; i < buckets; i += 1) {
      const fill = bands.fill[i];
      if (!fill) continue;
      const avgLen = bands.len[i] / fill;
      if (avgLen > maxAvgLen) maxAvgLen = avgLen;
      if (fill > maxFill) maxFill = fill;
    }

    const rowH = height / buckets;
    const barH = Math.max(1, rowH);
    const lenBase = Math.max(1, Math.min(maxAvgLen, LINE_WIDTH_CAP));
    for (let i = 0; i < buckets; i += 1) {
      const fill = bands.fill[i];
      if (!fill) continue;
      // 行长截断，避免个别超长行把其余内容压成细线
      const avgLen = Math.min(bands.len[i] / fill, LINE_WIDTH_CAP);
      const widthRatio = avgLen / lenBase;
      const alphaRatio = fill / maxFill;
      const barW = Math.max(1, w * (0.12 + 0.88 * widthRatio));

      // 取本桶占比最高的两类分别着色，其余并入第二段：每桶最多 2 段，绘制量可控
      const base = i * KIND_COUNT;
      let k1 = -1;
      let v1 = 0;
      let k2 = -1;
      let v2 = 0;
      let total = 0;
      for (let k = 0; k < KIND_COUNT; k += 1) {
        const value = bands.kinds[base + k];
        if (!value) continue;
        total += value;
        if (value > v1) {
          k2 = k1;
          v2 = v1;
          k1 = k;
          v1 = value;
        } else if (value > v2) {
          k2 = k;
          v2 = value;
        }
      }
      const y = i * rowH;
      if (total === 0) {
        ctx.globalAlpha = 0.08 + 0.32 * alphaRatio;
        ctx.fillStyle = colors[KIND_PLAIN];
        ctx.fillRect(0, y, barW, barH);
        continue;
      }
      ctx.globalAlpha = 0.26 + 0.38 * alphaRatio;
      // 次要类型占比过小时不着色，避免整幅图出现大量 1px 彩色毛刺
      const hasSecond = k2 >= 0 && v2 / total >= 0.2;
      const w1 = hasSecond ? Math.max(1, Math.round((barW * v1) / total)) : barW;
      ctx.fillStyle = colors[k1];
      ctx.fillRect(0, y, w1, barH);
      if (hasSecond && barW - w1 > 0.5) {
        ctx.fillStyle = colors[k2];
        ctx.fillRect(w1, y, barW - w1, barH);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** 视口框：只信 scrollTop / scrollHeight，折行与折叠都自动正确 */
  private updateViewport(): void {
    const scroller = this.view.scrollDOM;
    const total = scroller.scrollHeight;
    const viewH = scroller.clientHeight;
    if (!this.hasDoc || total <= 0 || this.canvasHeight <= 0) {
      this.viewportEl.style.display = "none";
      return;
    }
    const boxH = Math.max(8, Math.min(this.canvasHeight, (viewH / total) * this.canvasHeight));
    const maxTop = Math.max(0, this.canvasHeight - boxH);
    const maxScroll = Math.max(0, total - viewH);
    const top = maxScroll > 0 ? (scroller.scrollTop / maxScroll) * maxTop : 0;
    this.viewportEl.style.display = "";
    this.viewportEl.style.height = `${boxH}px`;
    this.viewportEl.style.transform = `translateY(${top}px)`;
  }

  // ---------------------------------------------------------------- 交互

  private onScroll = (): void => {
    this.scheduleViewport();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    this.el.setPointerCapture(e.pointerId);
    this.jumpTo(e.clientY);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.queueJump(e.clientY);
  };

  private onPointerUp = (): void => {
    this.dragging = false;
  };

  /** 拖拽按帧合并：一帧内多次 pointermove 只写一次 scrollTop，避免预览侧抖动 */
  private queueJump(clientY: number): void {
    this.dragY = clientY;
    if (this.dragFrame) return;
    this.dragFrame = requestAnimationFrame(() => {
      this.dragFrame = 0;
      if (!this.disposed) this.jumpTo(this.dragY);
    });
  }

  /** 按比例反算目标 scrollTop；写入触发既有「编辑器 → 预览」联动，属期望行为 */
  private jumpTo(clientY: number): void {
    const rect = this.el.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const scroller = this.view.scrollDOM;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) return;
    scroller.scrollTop = ratio * maxScroll;
  }
}

/** 返回 minimap 扩展；是否启用由 Compartment（layout.minimap）决定 */
export function minimapExtension(): Extension {
  return ViewPlugin.fromClass(MinimapPlugin);
}
