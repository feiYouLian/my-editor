/**
 * 侧栏分区（VS Code 风格折叠列表）：
 * 「正在打开的文件 / 文件 / 搜索 / 大纲 / 源代码管理」标题纵向排列。
 *
 * 布局规则（双段式，锚点 = 最后一个展开的分区）：
 * - 锚点及其上方贴顶，锚点之后整体沉底（沉底段由首元素 margin-top:auto 吸住）；
 *   全部分区收起时没有锚点，一律 30px 标题行从顶部依次吸附；
 * - 「正在打开的文件」高度按内容实时计算（有上限，不挤掉其它展开区），
 *   与「文件」一起锁定：不可拖拽、不写回配置；
 * - 「文件」（未展开时退化为锚点分区）作为填充区吸收上方剩余空间，
 *   把沉底段压到最底部；锚点分区一旦被手拖过就改用固定高度；
 * - 「搜索 / 大纲 / 源代码管理」展开后高度可拖：两侧都可调时在二者之间分配，
 *   只有一侧可调时只改那一侧；双击按内容复位；↑ / ↓ 微调；
 * - 展开组合 / 手调高度写回 config.json，启动时按此恢复（
 *   config.layout.sidebarView 仍记录当前分区）。
 */

export type SidebarView = "open" | "git" | "files" | "search" | "outline";

/** 全部合法分区 id（用于校验 config.json 这类外部输入） */
const SIDEBAR_VIEWS: readonly SidebarView[] = ["open", "git", "files", "search", "outline"];

/** 锁定分区：高度由计算得出，不响应拖拽、不写回配置 */
const LOCKED_VIEWS: readonly SidebarView[] = ["open", "files"];

/**
 * 分区标题行高度的兜底值（CSS 里由 `--section-head-h` 定义）。
 *
 * 这里**不再写死一个常量**：历史上 CSS 与 JS 各写一份（30px / 24px 不同步），
 * 结果是收起的分区多出一段空白、总高溢出还多出滚动条。现在实际高度从 DOM 量，
 * 常量只用于"侧栏当前不可见、量不到"的兜底。
 */
const HEAD_H_FALLBACK = 26;

/** 分隔线高度（与 main.css 的 .sidebar-sash 一致） */
const SASH_H = 4;

/** 可拖分区最小高度：标题行 + 至少一行内容 */
const MIN_SECTION_PX = 60;

/** 「文件」分区保底高度（px 兜底） */
const FILES_MIN_PX = 80;

/**
 * 「文件」优先保留的可用高度比例：它是主区域，其它分区再挤也要给它留下这么多。
 * 同时打开多个分区的情况不常见，这里宁可压缩「搜索 / 大纲 / 源代码管理」。
 */
const FILES_MIN_RATIO = 0.4;

/** 可拖分区首次展开、内容还量不出高度时的兜底值 */
const DEFAULT_SECTION_PX = 150;

/** 「正在打开的文件」最多占侧栏可用高度的比例 */
const OPEN_MAX_RATIO = 0.5;

/** 未配置时的默认展开组合 */
const DEFAULT_EXPANDED: readonly SidebarView[] = ["files"];

/** 从 config.layout 读入的侧栏布局（外部输入：值在 restore 里校验） */
export interface SidebarLayoutConfig {
  /** 当前分区：命令 / 快捷键与刷新逻辑瞄准的分区（不在展开组合里则忽略） */
  sidebarView?: string;
  sidebarExpanded?: string[];
  sidebarSizes?: Record<string, number>;
}

/** 需要写回 config.layout 的侧栏布局（来自内部状态，值必然合法） */
export interface SidebarLayoutPatch {
  sidebarExpanded: SidebarView[];
  sidebarSizes: Record<string, number>;
}

/** 只保留合法分区 id（去重，保持传入顺序） */
function knownViews(values: readonly string[] | undefined): SidebarView[] {
  const out: SidebarView[] = [];
  for (const value of values ?? []) {
    const view = value as SidebarView;
    if (SIDEBAR_VIEWS.includes(view) && !out.includes(view)) out.push(view);
  }
  return out;
}

/** 分区高度是否由计算得出（不响应拖拽、不写回配置） */
function isLocked(view: SidebarView): boolean {
  return LOCKED_VIEWS.includes(view);
}

/** 从分区容器元素取视图标识（分隔线等非分区元素返回 null） */
function viewOfSection(el: Element | null): SidebarView | null {
  if (!(el instanceof HTMLElement) || !el.classList.contains("sidebar-section")) return null;
  const view = el.querySelector<HTMLElement>(".sidebar-section-head")?.dataset.view;
  return (view as SidebarView | undefined) ?? null;
}

/** 数值夹紧到 [min, max] */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * 区域的内容自然高度。
 *
 * 不能直接读 scrollHeight：面板被 flex 拉伸后，scrollHeight / clientHeight 都等于
 * 当前分配高度，量不到真实内容（关闭标签后列表变短、高度却收不回来的根源）。
 * 这里逐个把子元素的伸缩临时去掉再读（读之前清、读完还原，同一任务内完成，
 * 不会出现可见跳动），子元素数量有限，代价可接受；没有子元素时才退回 scrollHeight。
 */
function contentHeight(el: HTMLElement): number {
  const children = el.children;
  if (children.length === 0) return el.scrollHeight;
  // 子元素很多（文件树这类长列表）时逐个改写 flex 代价太高；这些节点是流式排布，
  // scrollHeight 相加就是内容高度，不会出现被拉伸的问题
  if (children.length > 20) {
    let sum = 0;
    for (const child of children) {
      if (child instanceof HTMLElement) sum += child.scrollHeight;
    }
    return sum;
  }
  let sum = 0;
  for (const child of children) {
    if (!(child instanceof HTMLElement)) continue;
    const inlineFlex = child.style.flex;
    child.style.flex = "0 0 auto";
    sum += Math.max(child.offsetHeight, child.scrollHeight);
    child.style.flex = inlineFlex;
  }
  return sum;
}

/** 一次布局计算所需的几何信息（避免各处重复推导锚点与分组） */
interface SidebarGeometry {
  /** DOM 顺序的分区 id */
  order: SidebarView[];
  /** 锚点：最后一个展开分区在 order 里的下标（全收起为 -1） */
  anchor: number;
  /** 贴顶段：order[0..anchor] */
  topViews: SidebarView[];
  /** 沉底段：order(anchor..] */
  sunk: SidebarView[];
  /** 贴顶段里展开的分区 */
  topExpanded: SidebarView[];
  /** 贴顶段展开分区可用的总高度 */
  topAvail: number;
}

export interface SidebarViewsDeps {
  /** 用户操作后通知（写回 config.layout.sidebarView + 刷新对应视图） */
  onChange: (view: SidebarView) => void;
  /** 布局变化（展开组合 / 高度）→ 写回 config.json */
  onLayout: (patch: SidebarLayoutPatch) => void;
}

export class SidebarViews {
  /** 当前展开的分区集合（可多个） */
  private expanded = new Set<SidebarView>();
  /** 最后操作的分区：命令 / 快捷键定位用，也是持久化的值 */
  private lastActive: SidebarView = "files";
  /** 视图 → 分区容器（标题 + 内容）：分隔线拖拽与高度计算都要用 */
  private readonly sections = new Map<SidebarView, HTMLElement>();
  /** 手调高度（px）：只对可拖分区有意义 */
  private readonly sizes = new Map<SidebarView, number>();
  /** 用户手拖过的分区：高度只认用户设定，内容变化时不再自动贴合 */
  private readonly manual = new Set<SidebarView>();
  /** 可拖分区按内容算出的自然高度（缓存：拖拽每帧都要读，不能每帧量 DOM） */
  private readonly natural = new Map<SidebarView, number>();
  /** 「正在打开的文件」内容高度缓存（同上，拖拽每帧读，内容变化时由观察器刷新） */
  private openContentH = 0;

  /** 分隔线拖拽中的状态（pointermove / pointerup 挂在 window 上） */
  private drag: {
    /** 上侧可调分区（锁定或收起为 null） */
    upper: SidebarView | null;
    /** 下侧可调分区（锁定或收起为 null） */
    lower: SidebarView | null;
    /** 两侧都可调：在二者之间分配高度，总高不变 */
    pair: boolean;
    startY: number;
    upperPx: number;
    lowerPx: number;
    /** 可调高度的上限 */
    budget: number;
  } | null = null;

  constructor(
    private sectionsEl: HTMLElement,
    private panes: Record<SidebarView, HTMLElement>,
    private deps: SidebarViewsDeps,
  ) {
    for (const [view, el] of Object.entries(panes) as [SidebarView, HTMLElement][]) {
      const section = el.closest<HTMLElement>(".sidebar-section");
      if (section) this.sections.set(view, section);
    }
    this.sectionsEl.querySelectorAll<HTMLElement>(".sidebar-section-head").forEach((btn) => {
      const view = btn.dataset.view as SidebarView | undefined;
      if (!view) return;
      btn.addEventListener("click", () => this.toggle(view));
    });
    this.initSashes();
    // 侧栏高度变化（窗口缩放 / 终端面板开合）：重新分配（挤不下时按比例压缩可拖区）
    new ResizeObserver(() => {
      // 拖拽中重排会和光标抢高度，等松手再统一处理（见 endDrag）
      if (this.drag) return;
      // 缩放/换主题可能改变标题行实际高度，缓存随尺寸变化失效
      this.headHeightPx = 0;
      this.applySizes();
    }).observe(this.sectionsEl);
    this.observeContent();
    // 配置在 bootstrap 载入后由 restore 覆盖：先用默认布局渲染
    this.restore({});
  }

  /**
   * 内容变化 → 重算分区高度。
   * 典型场景：关闭标签后「正在打开的文件」列表变短，固定高度不变就会在列表下方
   * 留出空行；Git 刷新后条目变少同理。用 MutationObserver 统一兜底（各视图渲染
   * 入口分散在 panels 里，逐个加调用既漏又散），一次宏任务内合并成一次重排
   * （用 setTimeout 而非 rAF：窗口最小化 / 无渲染帧时 rAF 会停，高度就再也跟不上）。
   * 手拖过的分区由 manual 保护，不参与自动贴合。
   */
  private observeContent(): void {
    const pending = new Set<SidebarView>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      let changed = false;
      for (const view of pending) {
        // 「正在打开的文件」高度实时跟随内容（标签增减、脏标记变化）
        if (view === "open") {
          if (this.measureOpen()) changed = true;
          continue;
        }
        if (this.manual.has(view)) continue;
        if (this.measure(view)) changed = true;
      }
      pending.clear();
      if (changed) this.applySizes();
    };
    for (const [view, body] of Object.entries(this.panes) as [SidebarView, HTMLElement][]) {
      new MutationObserver(() => {
        pending.add(view);
        if (timer === null) timer = setTimeout(flush, 0);
      }).observe(body, { childList: true, subtree: true, characterData: true });
    }
  }

  /** 最后操作的分区（供预览 / 大纲刷新判断） */
  get view(): SidebarView {
    return this.lastActive;
  }

  /** 命令 / 快捷键：展开指定分区并记录为当前分区（不收起其他分区） */
  switch(view: SidebarView): void {
    this.lastActive = view;
    if (this.expanded.has(view)) {
      this.apply();
    } else {
      this.open(view);
    }
    this.deps.onChange(view);
    this.persistLayout();
  }

  /** 启动 / 配置变更时恢复布局：展开组合 + 高度（外部输入一律校验） */
  restore(cfg: SidebarLayoutConfig): void {
    const expanded = knownViews(cfg.sidebarExpanded);
    this.expanded = new Set(expanded.length > 0 ? expanded : DEFAULT_EXPANDED);
    this.sizes.clear();
    this.manual.clear();
    this.natural.clear();
    for (const [id, px] of Object.entries(cfg.sidebarSizes ?? {})) {
      const view = id as SidebarView;
      // open / files 的高度是算出来的：旧配置里的残留值直接丢弃，避免带着过期高度启动
      if (isLocked(view)) continue;
      if (!this.expanded.has(view) || !Number.isFinite(px) || px <= 0) continue;
      this.sizes.set(view, px);
      // 持久化下来的高度都来自用户手拖（见 persistLayout），恢复后继续尊重
      this.manual.add(view);
    }
    const active = cfg.sidebarView as SidebarView | undefined;
    this.lastActive =
      active && this.expanded.has(active)
        ? active
        : (this.domOrder().find((view) => this.expanded.has(view)) ?? "files");
    // display:none 的分区量不到内容高度：先亮出内容再测
    for (const view of this.expanded) this.panes[view].classList.remove("hidden");
    for (const view of this.expanded) this.measure(view);
    this.measureOpen();
    this.apply();
  }

  /** 点击标题：独立展开 / 收起（收起不改变持久化的当前分区） */
  private toggle(view: SidebarView): void {
    if (this.expanded.has(view)) {
      this.expanded.delete(view);
      // 收起只影响布局：手调高度留着，下次展开按记录恢复
      this.apply();
    } else {
      this.lastActive = view;
      this.open(view);
      this.deps.onChange(view);
    }
    this.persistLayout();
  }

  /** 展开一个分区：先亮出内容，再量一次自然高度 */
  private open(view: SidebarView): void {
    this.expanded.add(view);
    this.panes[view].classList.remove("hidden");
    if (view === "open") this.measureOpen();
    else this.measure(view);
    this.apply();
  }

  private apply(): void {
    this.sectionsEl
      .querySelectorAll<HTMLButtonElement>(".sidebar-section-head")
      .forEach((btn) => {
        const view = btn.dataset.view as SidebarView | undefined;
        if (!view) return;
        const open = this.expanded.has(view);
        btn.classList.toggle("active", open);
        btn.setAttribute("aria-expanded", String(open));
        btn.closest(".sidebar-section")?.classList.toggle("expanded", open);
        const chevron = btn.querySelector<HTMLElement>(".chevron");
        if (chevron) chevron.textContent = open ? "⌄" : "›";
      });
    for (const [view, el] of Object.entries(this.panes) as [SidebarView, HTMLElement][]) {
      el.classList.toggle("hidden", !this.expanded.has(view));
    }
    this.applySizes();
  }

  // ---- 几何 ----

  /** 标题行实际高度缓存（量不到时用兜底值，不写死常量以免与 CSS 漂移） */
  private headHeightPx = 0;

  /** 分区标题行高度：从 DOM 量（CSS 的 --section-head-h 是唯一真源） */
  private headH(): number {
    if (this.headHeightPx > 0) return this.headHeightPx;
    const head = this.sectionsEl.querySelector<HTMLElement>(".sidebar-section-head");
    const measured = head ? head.getBoundingClientRect().height : 0;
    // 侧栏隐藏（宽 0 / display:none）时量不到：先用兜底，等 ResizeObserver 之后重算
    if (measured <= 0) return HEAD_H_FALLBACK;
    this.headHeightPx = measured;
    return measured;
  }

  /** 推导锚点 / 贴顶段 / 沉底段 / 可用高度 */
  private geometry(): SidebarGeometry {
    const order = this.domOrder();
    const anchor = this.anchorIndex(order);
    const topViews = anchor >= 0 ? order.slice(0, anchor + 1) : order;
    const sunk = anchor >= 0 ? order.slice(anchor + 1) : [];
    const topExpanded = topViews.filter((view) => this.expanded.has(view));
    const collapsedInTop = topViews.length - topExpanded.length;
    const sashH = Math.max(0, order.length - 1) * SASH_H;
    const headH = this.headH();
    const topAvail = Math.max(
      0,
      this.sectionsEl.clientHeight - sashH - sunk.length * headH - collapsedInTop * headH,
    );
    return { order, anchor, topViews, sunk, topExpanded, topAvail };
  }

  /** 锚点 = DOM 序里最后一个展开分区的下标（全收起为 -1，此时整栏贴顶） */
  private anchorIndex(order: SidebarView[]): number {
    for (let i = order.length - 1; i >= 0; i -= 1) {
      if (this.expanded.has(order[i])) return i;
    }
    return -1;
  }

  /**
   * 弹性分区（吸收贴顶段剩余空间、把沉底段压到底部）：
   * - 「文件」展开就由它承担——它是主区域，优先占用空间；
   * - 否则退化为锚点分区（贴顶段最后一个），但被手拖过就改固定高度；
   * - 「正在打开的文件」永远不弹性（高度由内容实时决定）。
   */
  private elasticTarget(geo: SidebarGeometry): SidebarView | null {
    if (geo.topExpanded.includes("files")) return "files";
    const tail = geo.anchor >= 0 ? geo.order[geo.anchor] : null;
    if (!tail || tail === "open" || this.manual.has(tail)) return null;
    return tail;
  }

  /** 弹性分区的保底高度：「文件」按比例 + 绝对值兜底，其它分区只留一行 */
  private elasticMin(geo: SidebarGeometry, elastic: SidebarView | null): number {
    if (elastic === "files") return Math.max(FILES_MIN_PX, geo.topAvail * FILES_MIN_RATIO);
    return MIN_SECTION_PX;
  }

  // ---- 高度分配 ----

  /**
   * 计算贴顶段每个展开分区的高度（px）。
   *
   * 优先级：「正在打开的文件」按内容实时算 → 「文件」优先保足（保底比例，富余全归它）
   * → 其余可拖分区按内容 / 手拖值，空间不够时按比例压缩。
   * 压缩只影响本次布局，不写回 sizes：窗口恢复后手拖值仍然生效。
   */
  private planHeights(
    geo: SidebarGeometry,
    elastic: SidebarView | null,
  ): Map<SidebarView, number> {
    const plan = new Map<SidebarView, number>();
    const hasOpen = geo.topExpanded.includes("open");
    const openH = hasOpen ? this.openHeight(geo) : 0;
    if (hasOpen) plan.set("open", openH);

    const fixed = geo.topExpanded.filter((view) => view !== "open" && view !== elastic);
    const desired = fixed.map((view) => this.heightFor(view, geo));
    const desiredSum = desired.reduce((sum, px) => sum + px, 0);
    const room = Math.max(0, geo.topAvail - openH - this.elasticMin(geo, elastic));

    let fixedTotal = desiredSum;
    if (desiredSum > room) {
      // 先给每块扣掉 MIN 保底，再把剩余额度按「期望值 - MIN」的比例分出去。
      // 直接按期望值比例缩会每块都撞 MIN 保底，总和反过来超出 room（整栏溢出滚动）。
      const minTotal = fixed.length * MIN_SECTION_PX;
      if (minTotal >= room) {
        fixed.forEach((view) => plan.set(view, MIN_SECTION_PX));
      } else {
        const spare = room - minTotal;
        const extraSum = desiredSum - minTotal;
        fixed.forEach((view, i) => {
          const extra = desired[i] - MIN_SECTION_PX;
          const share = extraSum > 0 ? (extra / extraSum) * spare : 0;
          plan.set(view, Math.round(MIN_SECTION_PX + share));
        });
      }
      fixedTotal = fixed.reduce((sum, view) => sum + (plan.get(view) ?? 0), 0);
    } else {
      fixed.forEach((view, i) => plan.set(view, desired[i]));
    }

    if (elastic) {
      // 极窄窗口下连保底都放不下：弹性分区允许跌破比例保底（但不低于一行），
      // 宁可它小一点，也不要整栏溢出
      const px = geo.topAvail - openH - fixedTotal;
      plan.set(elastic, Math.max(MIN_SECTION_PX, Math.round(px)));
    }
    return plan;
  }

  /**
   * 应用高度：
   * - 收起分区（含整个沉底段）只占标题行，贴顶 / 沉底由 flex 与 margin-top:auto 决定；
   * - 弹性分区 flex:1 吸收剩余（min-height 兜底，窗口缩放时自动跟随）；
   * - 其余展开分区用固定像素（手调值或按内容算出的值）。
   */
  private applySizes(): void {
    const geo = this.geometry();
    const elastic = this.elasticTarget(geo);
    const plan = this.planHeights(geo, elastic);
    const sunkFirst = geo.sunk[0] ?? null;

    for (const view of geo.order) {
      const section = this.sections.get(view);
      if (!section) continue;
      const first = view === sunkFirst;
      // auto margin 落在沉底段之前的那根分隔线上：让"线 + 沉底段"一起被推到最底部，
      // 否则线会孤零零浮在中间（margin 只作用于分区时，它前面的 sash 留在原处）
      const prev = section.previousElementSibling;
      const line =
        prev instanceof HTMLElement && prev.classList.contains("sidebar-sash") ? prev : null;
      if (line) line.classList.toggle("is-sunk-first", first);
      section.classList.toggle("is-sunk-first", first && line === null);
    }

    for (const [view, section] of this.sections) {
      section.style.minHeight = "";
      if (!this.expanded.has(view) || !geo.topViews.includes(view)) {
        // 收起分区 / 沉底段分区：只占标题行
        section.style.flex = "0 0 auto";
        continue;
      }
      const px = plan.get(view) ?? MIN_SECTION_PX;
      if (view === elastic) {
        section.style.flex = "1 1 auto";
        section.style.minHeight = `${px}px`;
        continue;
      }
      section.style.flex = `0 0 ${px}px`;
    }
    this.syncSashes();
  }

  /** 某个展开分区按内容 / 手拖值该占多高（open 与弹性分区走单独路径） */
  private heightFor(view: SidebarView, geo: SidebarGeometry): number {
    const px = this.sizes.get(view) ?? this.natural.get(view) ?? DEFAULT_SECTION_PX;
    return Math.round(clamp(px, MIN_SECTION_PX, Math.max(MIN_SECTION_PX, geo.topAvail)));
  }

  /**
   * 「正在打开的文件」高度：按内容实时计算，上限为可用高度的一半。
   * 这里是绝对上限、不再扣其它分区的份额——让位交给 planHeights 统一处理，
   * 否则「文件」的保底和它会互相挤，两边都算不出稳定值。
   */
  private openHeight(geo: SidebarGeometry): number {
    const headH = this.headH();
    const natural = headH + this.openContentH;
    const cap = Math.max(headH, geo.topAvail * OPEN_MAX_RATIO);
    return Math.round(clamp(natural, headH, cap));
  }

  /** 可拖分区能占到的最大高度（扣掉 open 与弹性分区的保底） */
  private availableHeight(): number {
    const geo = this.geometry();
    const elastic = this.elasticTarget(geo);
    const openPx = geo.topExpanded.includes("open") ? this.openHeight(geo) : 0;
    return Math.max(
      MIN_SECTION_PX,
      geo.topAvail - openPx - this.elasticMin(geo, elastic),
    );
  }

  /** 「正在打开的文件」内容高度：标签增减 / 列表变化时重算（唯一需要实时跟随的分区） */
  private measureOpen(): boolean {
    const next = contentHeight(this.panes.open);
    if (Math.abs(this.openContentH - next) < 1) return false;
    this.openContentH = next;
    return true;
  }

  /** 量一次按内容的高度并写入缓存；返回是否真的变了 */
  private measure(view: SidebarView): boolean {
    // open 实时计算、files 是填充区：两者都不需要按内容的高度
    if (isLocked(view) || !this.expanded.has(view)) return false;
    const body = this.panes[view];
    const content = contentHeight(body);
    const next = content <= 0 ? DEFAULT_SECTION_PX : this.headH() + content;
    const prev = this.natural.get(view);
    if (prev !== undefined && Math.abs(prev - next) < 1) return false;
    this.natural.set(view, next);
    return true;
  }

  /**
   * 写回 config.json（展开组合 / 高度），由装配层合并进 layout。
   * 只持久化用户手拖的高度：按内容算出来的高度每次启动重算即可，
   * 否则内容变化后会带着过期高度出现空行；open / files 是计算值，一律不写。
   */
  private persistLayout(): void {
    this.deps.onLayout({
      sidebarExpanded: this.domOrder().filter((view) => this.expanded.has(view)),
      sidebarSizes: Object.fromEntries(
        [...this.sizes].filter(
          ([view]) => this.manual.has(view) && !isLocked(view),
        ),
      ),
    });
  }

  // ---- 分隔线拖拽 ----

  /**
   * 分隔线可拖拽态：
   * - 两侧都可调（展开且非锁定）：在二者之间分配高度；
   * - 只有一侧可调：只调整该侧（「文件」这类填充区只被动补偿高度，位置不变）；
   * - 沉底段起始线禁用（见 adjustableOf）；
   * - 唯一展开的分区铺满剩余空间，不开放拖拽。
   */
  private syncSashes(): void {
    const sunkFirstEl = this.sunkFirstEl();
    this.sectionsEl.querySelectorAll<HTMLElement>(".sidebar-sash").forEach((sash) => {
      const { upper, lower } = this.adjustableOf(sash, sunkFirstEl);
      const draggable = (upper !== null || lower !== null) && this.expanded.size > 1;
      sash.classList.toggle("draggable", draggable);
      sash.setAttribute("aria-disabled", String(!draggable));
      sash.tabIndex = draggable ? 0 : -1;
    });
  }

  private initSashes(): void {
    this.sectionsEl.querySelectorAll<HTMLElement>(".sidebar-sash").forEach((sash) => {
      sash.setAttribute("role", "separator");
      sash.setAttribute("aria-orientation", "horizontal");
      sash.addEventListener("pointerdown", (e) => this.startDrag(sash, e));
      sash.addEventListener("dblclick", () => this.resetSizes());
      sash.addEventListener("keydown", (e) => this.nudge(sash, e));
    });
    window.addEventListener("pointermove", (e) => this.moveDrag(e));
    window.addEventListener("pointerup", () => this.endDrag());
    window.addEventListener("pointercancel", () => this.endDrag());
  }

  /** 沉底段首个分区元素（没有沉底段时为 null） */
  private sunkFirstEl(): HTMLElement | null {
    const sunkFirst = this.geometry().sunk[0];
    return sunkFirst ? (this.sections.get(sunkFirst) ?? null) : null;
  }

  /**
   * 分隔线两侧「可调」的分区（收起侧 / 锁定侧为 null）。
   *
   * 沉底段的起始线一律禁用：沉底段贴底不动，拖这条线只会让上方的填充区反向
   * 补偿，线本身纹丝不动（用户感受到的就是「拖了没反应 / 方向反了」）。
   * 调整该分区的正确入口是它上面那条边界线——那里的线正好落在它的顶边，
   * 拖动时光标与边界同步。
   */
  private adjustableOf(
    sash: HTMLElement,
    sunkFirstEl: HTMLElement | null,
  ): { upper: SidebarView | null; lower: SidebarView | null } {
    if (sunkFirstEl !== null && sunkFirstEl.previousElementSibling === sash) {
      return { upper: null, lower: null };
    }
    const above = this.expandedViewOf(sash.previousElementSibling);
    const below = this.expandedViewOf(sash.nextElementSibling);
    return {
      upper: above !== null && !isLocked(above) ? above : null,
      lower: below !== null && !isLocked(below) ? below : null,
    };
  }

  private startDrag(sash: HTMLElement, e: PointerEvent): void {
    if (e.button !== 0 || !sash.classList.contains("draggable")) return;
    const { upper, lower } = this.adjustableOf(sash, this.sunkFirstEl());
    if (!upper && !lower) return;
    e.preventDefault();
    this.drag = {
      upper,
      lower,
      pair: upper !== null && lower !== null,
      startY: e.clientY,
      upperPx: upper ? this.heightOf(upper) : 0,
      lowerPx: lower ? this.heightOf(lower) : 0,
      budget:
        upper && lower
          ? this.pairBudget(upper, lower)
          : this.singleBudget((upper ?? lower)!),
    };
    sash.setPointerCapture?.(e.pointerId);
    sash.classList.add("dragging");
    document.body.classList.add("dragging-row");
  }

  /**
   * 两侧都可调时的预算：两区高度之和的上限（扣掉其它可调分区）。
   * 「其它分区」用实际渲染高度而非 sizes：sizes 是用户设定值，可能已被压缩。
   */
  private pairBudget(upper: SidebarView, lower: SidebarView): number {
    let others = 0;
    for (const view of this.expanded) {
      if (view === upper || view === lower || isLocked(view)) continue;
      others += this.heightOf(view);
    }
    return Math.max(MIN_SECTION_PX * 2, this.availableHeight() - others);
  }

  /** 单侧可调时的预算：目标分区能占到的最大高度 */
  private singleBudget(target: SidebarView): number {
    let others = 0;
    for (const view of this.expanded) {
      if (view === target || isLocked(view)) continue;
      others += this.heightOf(view);
    }
    return Math.max(MIN_SECTION_PX, this.availableHeight() - others);
  }

  private moveDrag(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const budget = Math.max(MIN_SECTION_PX, drag.budget);
    if (drag.pair && drag.upper && drag.lower) {
      // 两区都可调：只在二者之间分配高度，总高不变，边界始终贴着光标
      const total = clamp(drag.upperPx + drag.lowerPx, MIN_SECTION_PX * 2, budget);
      const upperPx = clamp(drag.upperPx + dy, MIN_SECTION_PX, total - MIN_SECTION_PX);
      this.sizes.set(drag.upper, upperPx);
      this.sizes.set(drag.lower, total - upperPx);
      this.manual.add(drag.upper);
      this.manual.add(drag.lower);
    } else if (drag.upper) {
      // 只有上方可调：向下拖 = 变高
      this.sizes.set(drag.upper, clamp(drag.upperPx + dy, MIN_SECTION_PX, budget));
      this.manual.add(drag.upper);
    } else if (drag.lower) {
      // 只有下方可调：向上拖 = 变高
      this.sizes.set(drag.lower, clamp(drag.lowerPx - dy, MIN_SECTION_PX, budget));
      this.manual.add(drag.lower);
    }
    this.applySizes();
  }

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.sectionsEl.querySelectorAll<HTMLElement>(".sidebar-sash.dragging").forEach((sash) => {
      sash.classList.remove("dragging");
    });
    document.body.classList.remove("dragging-row");
    this.applySizes();
    this.persistLayout();
  }

  /** 键盘微调：↑ / ↓ ±10px，Shift + ↑ / ↓ ±50px（可访问性） */
  private nudge(sash: HTMLElement, e: KeyboardEvent): void {
    if (!sash.classList.contains("draggable")) return;
    const up = e.key === "ArrowUp";
    const down = e.key === "ArrowDown";
    if (!up && !down) return;
    const step = (e.shiftKey ? 50 : 10) * (up ? -1 : 1);
    const { upper, lower } = this.adjustableOf(sash, this.sunkFirstEl());
    if (upper) {
      this.sizes.set(
        upper,
        clamp(this.heightOf(upper) + step, MIN_SECTION_PX, this.singleBudget(upper)),
      );
      this.manual.add(upper);
    } else if (lower) {
      this.sizes.set(
        lower,
        clamp(this.heightOf(lower) - step, MIN_SECTION_PX, this.singleBudget(lower)),
      );
      this.manual.add(lower);
    } else {
      return;
    }
    e.preventDefault();
    this.applySizes();
    this.persistLayout();
  }

  /** 双击分隔线：清掉手调高度与标记，回到「按内容」的默认高度 */
  private resetSizes(): void {
    this.sizes.clear();
    this.manual.clear();
    this.natural.clear();
    for (const view of this.expanded) this.measure(view);
    this.measureOpen();
    this.apply();
    this.persistLayout();
  }

  private heightOf(view: SidebarView): number {
    return this.sections.get(view)?.getBoundingClientRect().height ?? 0;
  }

  /** DOM 顺序的分区（判断「锚点」与「沉底段」用：Map 的插入顺序与界面顺序无关） */
  private domOrder(): SidebarView[] {
    return [...this.sectionsEl.querySelectorAll<HTMLElement>(".sidebar-section")]
      .map((el) => viewOfSection(el))
      .filter((view): view is SidebarView => view !== null);
  }

  /** 相邻分区中处于展开态的那个（否则 null） */
  private expandedViewOf(el: Element | null): SidebarView | null {
    const view = viewOfSection(el);
    return view !== null && this.expanded.has(view) ? view : null;
  }
}
