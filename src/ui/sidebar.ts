/**
 * 侧栏分区（VS Code 风格折叠列表）：
 * 「正在打开的文件 / 文件 / 搜索 / 大纲 / 源代码管理」标题纵向排列。
 *
 * 布局规则：
 * - 展开区分两种高度：内容够小按内容给（不抢其它分区的空间），内容比可用空间
 *   大则保持均分、吸收剩余高度；收起区只占标题行，侧栏不再整体滚动；
 * - 分区之间的分隔线可上下拖拽：两侧都展开时在二者之间分配高度，
 *   只展开底部吸附区时只调整该区高度（内部拖动余量来自上方留白）；
 *   唯一展开且不吸附底部的分区铺满剩余空间，不开放拖拽；双击按内容复位；
 * - 底部固定区：被固定的分区（默认「源代码管理」）及其下方分区贴住侧栏底边；
 *   只展开吸附区时它按自身高度贴在底部，上方留白——留白即拖动余量；
 * - 展开组合 / 高度 / 底部固定写回 config.json，启动时按此恢复（
 *   config.layout.sidebarView 仍记录当前分区）。
 */

export type SidebarView = "open" | "git" | "files" | "search" | "outline";

/** 全部合法分区 id（用于校验 config.json 这类外部输入） */
const SIDEBAR_VIEWS: readonly SidebarView[] = ["open", "git", "files", "search", "outline"];

/** 分区最小高度：标题行 30px + 至少一行内容 */
const MIN_SECTION_PX = 60;

/** 未配置时的默认展开组合 / 底部固定分区 */
const DEFAULT_EXPANDED: readonly SidebarView[] = ["files"];
const DEFAULT_DOCK: readonly SidebarView[] = ["git"];

/** 从 config.layout 读入的侧栏布局（外部输入：值在 restore 里校验） */
export interface SidebarLayoutConfig {
  /** 当前分区：命令 / 快捷键与刷新逻辑瞄准的分区（不在展开组合里则忽略） */
  sidebarView?: string;
  sidebarExpanded?: string[];
  sidebarSizes?: Record<string, number>;
  sidebarDock?: string[];
}

/** 需要写回 config.layout 的侧栏布局（来自内部状态，值必然合法） */
export interface SidebarLayoutPatch {
  sidebarExpanded: SidebarView[];
  sidebarSizes: Record<string, number>;
  sidebarDock: SidebarView[];
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
 * 区域的内容自然高度：
 * 自身就是滚动容器时 scrollHeight 即内容高度；内部列表滚动（工具条 + 列表）时
 * 取各子元素 scrollHeight 之和，否则量到的只是被 flex 撑出的当前高度。
 */
function contentHeight(el: HTMLElement): number {
  let sum = 0;
  for (const child of el.children) {
    if (child instanceof HTMLElement) sum += child.scrollHeight;
  }
  return Math.max(sum, el.scrollHeight);
}

export interface SidebarViewsDeps {
  /** 用户操作后通知（写回 config.layout.sidebarView + 刷新对应视图） */
  onChange: (view: SidebarView) => void;
  /** 布局变化（展开组合 / 高度 / 底部固定）→ 写回 config.json */
  onLayout: (patch: SidebarLayoutPatch) => void;
}

export class SidebarViews {
  /** 当前展开的分区集合（可多个） */
  private expanded = new Set<SidebarView>();
  /** 最后操作的分区：命令 / 快捷键定位用，也是持久化的值 */
  private lastActive: SidebarView = "files";
  /** 视图 → 分区容器（标题 + 内容）：分隔线拖拽与高度计算都要用 */
  private readonly sections = new Map<SidebarView, HTMLElement>();
  /** 手调 / 按内容初始化的分区高度（px）：未记录的分区均分剩余高度 */
  private readonly sizes = new Map<SidebarView, number>();
  /** 固定在底部的分区：最靠上的那个吃下剩余空间，其下分区一并贴底 */
  private dock = new Set<SidebarView>();
  /** 分隔线拖拽中的状态（mousemove / mouseup 挂在 window 上） */
  private drag: {
    /** 分隔线上侧 / 下侧展开的分区（收起侧为 null） */
    above: SidebarView | null;
    below: SidebarView | null;
    startY: number;
    abovePx: number;
    belowPx: number;
    /** 可调高度的上限：两侧分配时为两区之和，单侧时为该区上限 */
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
      btn.append(this.createPin(view));
    });
    this.initSashes();
    // 侧栏高度变化（窗口缩放 / 终端面板开合）：挤不下时按比例收回手调高度
    new ResizeObserver(() => this.fitSizes()).observe(this.sectionsEl);
    // 配置在 bootstrap 载入后由 restore 覆盖：先用默认布局渲染
    this.restore({});
  }

  /** 标题行右侧的「固定到底部」按钮（hover 或已固定时可见，样式见 main.css） */
  private createPin(view: SidebarView): HTMLElement {
    // 标题本身是 <button>：内层不能再放 button，用 span + role 代替
    const pin = document.createElement("span");
    pin.className = "sidebar-pin";
    pin.setAttribute("role", "button");
    pin.textContent = "⇩";
    // 标题点击是展开 / 收起，固定按钮必须拦下冒泡
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleDock(view);
    });
    return pin;
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

  /** 启动 / 配置变更时恢复布局：展开组合 + 高度 + 底部固定（外部输入一律校验） */
  restore(cfg: SidebarLayoutConfig): void {
    const expanded = knownViews(cfg.sidebarExpanded);
    this.expanded = new Set(expanded.length > 0 ? expanded : DEFAULT_EXPANDED);
    const dock = knownViews(cfg.sidebarDock);
    this.dock = new Set(dock.length > 0 ? dock : DEFAULT_DOCK);
    this.sizes.clear();
    for (const [id, px] of Object.entries(cfg.sidebarSizes ?? {})) {
      const view = id as SidebarView;
      if (!this.expanded.has(view) || !Number.isFinite(px) || px <= 0) continue;
      this.sizes.set(view, px);
    }
    const active = cfg.sidebarView as SidebarView | undefined;
    this.lastActive =
      active && this.expanded.has(active)
        ? active
        : (this.domOrder().find((view) => this.expanded.has(view)) ?? "files");
    // display:none 的分区量不到内容高度：先亮出内容再初始化高度
    for (const view of this.expanded) this.panes[view].classList.remove("hidden");
    for (const view of this.expanded) this.initSize(view);
    this.apply();
  }

  /** 点击标题：独立展开 / 收起（收起不改变持久化的当前分区） */
  private toggle(view: SidebarView): void {
    if (this.expanded.has(view)) {
      this.expanded.delete(view);
      // 收起后丢掉高度，再次展开时按内容重新给
      this.sizes.delete(view);
      this.apply();
    } else {
      this.lastActive = view;
      this.open(view);
      this.deps.onChange(view);
    }
    this.persistLayout();
  }

  /** 展开一个分区：先亮出内容，再按内容给初始高度（内容多则保持均分吸收） */
  private open(view: SidebarView): void {
    this.expanded.add(view);
    this.panes[view].classList.remove("hidden");
    this.initSize(view);
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
    // 展开 / 收起后可能把手调高度挤爆，收口一次
    this.fitSizes();
  }

  /** 分区高度：按内容 / 手调的分区用固定像素，富余高度由填充区（见 fillers）均分 */
  private applySizes(): void {
    const fillers = this.fillers();
    // 底部固定区：最靠上的被固定分区吃下剩余空间，从而贴住侧栏底边
    const dockTop = this.domOrder().find((view) => this.dock.has(view));
    for (const [view, section] of this.sections) {
      const px = this.expanded.has(view) && !fillers.has(view) ? this.sizes.get(view) : undefined;
      section.style.flex = px === undefined ? "" : `0 0 ${Math.round(px)}px`;
      section.classList.toggle("docked", view === dockTop);
      const pin = section.querySelector<HTMLElement>(".sidebar-pin");
      if (pin) {
        pin.classList.toggle("pinned", this.dock.has(view));
        pin.title = this.dock.has(view) ? "取消固定底部" : "固定到底部";
      }
    }
    this.syncSashes();
  }

  /**
   * 填充区（均分富余高度）：
   * 1) 还没量过内容 / 内容比可用空间大的展开区；
   * 2) 只有它一个展开区且不吸附底部时（否则内容少的分区只占一小块，中间会留一大片空）。
   * 吸附底部的单区例外：按自身高度贴底，上方留白即拖拽余量（见 syncSashes）。
   */
  private fillers(): Set<SidebarView> {
    const implicit = [...this.expanded].filter((view) => !this.sizes.has(view));
    if (implicit.length > 0) return new Set(implicit);
    if (this.expanded.size <= 1) {
      const [only] = this.expanded;
      return only && this.dock.has(only) ? new Set() : new Set(this.expanded);
    }
    return new Set();
  }

  /** 写回 config.json（展开组合 / 高度 / 底部固定），由装配层合并进 layout */
  private persistLayout(): void {
    this.deps.onLayout({
      sidebarExpanded: this.domOrder().filter((view) => this.expanded.has(view)),
      sidebarSizes: Object.fromEntries(this.sizes),
      sidebarDock: this.domOrder().filter((view) => this.dock.has(view)),
    });
  }

  /** 固定 / 取消固定底部（最靠上的被固定分区起，往下的分区一并贴底） */
  private toggleDock(view: SidebarView): void {
    if (this.dock.has(view)) this.dock.delete(view);
    else this.dock.add(view);
    this.apply();
    this.persistLayout();
  }

  /**
   * 展开分区时给一个初始高度：
   * 内容自然高度小于可用空间就按内容给（不抢其它分区的空间）；
   * 内容更多（或还没渲染出内容）则留空，继续由 flex 均分吸收剩余高度。
   * 例外：唯一展开的分区直接铺满（VS Code 的展开即占满），否则「只展开
   * 源代码管理」这类内容不多、又吸附底部的分区只会占底部一小块，上面一大片空白。
   * 想要留白 / 调高度时手动拖分隔线即可（拖过的高度会持久化，重启仍生效）。
   */
  private initSize(view: SidebarView): void {
    if (this.sizes.has(view)) return;
    if (this.expanded.size === 1) return;
    const section = this.sections.get(view);
    const body = this.panes[view];
    if (!section || !body) return;
    const content = contentHeight(body);
    // 内容未渲染（如刚启动的文件树）：量不到高度，保持均分
    if (content <= 0) return;
    const head = section.querySelector<HTMLElement>(".sidebar-section-head");
    const natural = (head?.offsetHeight ?? 0) + content;
    const avail = this.availableHeight();
    if (natural >= avail) return;
    const others = [...this.expanded].filter((other) => other !== view);
    const fixed = others.reduce((sum, other) => sum + (this.sizes.get(other) ?? 0), 0);
    const flexible = others.filter((other) => !this.sizes.has(other)).length;
    const cap = avail - fixed - MIN_SECTION_PX * flexible;
    this.sizes.set(view, clamp(natural, MIN_SECTION_PX, Math.max(MIN_SECTION_PX, cap)));
  }

  /**
   * 分隔线可拖拽态：
   * - 两侧都展开：在二者之间分配高度；
   * - 只有一侧展开：只调整该侧高度（只留底部吸附区时向上拖变高、向下拖变矮）。
   *   多个分区展开时一律开放（相邻分区往往一开一收，旧的「两侧都必须展开」会让
   *   文件 + 源代码管理同时展开时一根分隔线都拖不动）；
   * - 唯一展开且不吸附底部分区时不开放：它铺满剩余空间，拖出下方留白没有意义。
   */
  private syncSashes(): void {
    this.sectionsEl.querySelectorAll<HTMLElement>(".sidebar-sash").forEach((sash) => {
      const above = this.expandedViewOf(sash.previousElementSibling);
      const below = this.expandedViewOf(sash.nextElementSibling);
      const single = above ?? below;
      const draggable =
        above !== null && below !== null
          ? true
          : single !== null && (this.expanded.size > 1 || this.dock.has(single));
      sash.classList.toggle("draggable", draggable);
    });
  }

  // ---- 分隔线拖拽 ----

  private initSashes(): void {
    this.sectionsEl.querySelectorAll<HTMLElement>(".sidebar-sash").forEach((sash) => {
      sash.addEventListener("mousedown", (e) => this.startDrag(sash, e));
      sash.addEventListener("dblclick", () => this.resetSizes());
    });
    window.addEventListener("mousemove", (e) => this.moveDrag(e));
    window.addEventListener("mouseup", () => this.endDrag());
  }

  private startDrag(sash: HTMLElement, e: MouseEvent): void {
    if (e.button !== 0 || !sash.classList.contains("draggable")) return;
    const above = this.expandedViewOf(sash.previousElementSibling);
    const below = this.expandedViewOf(sash.nextElementSibling);
    if (!above && !below) return;
    e.preventDefault();
    this.drag = {
      above,
      below,
      startY: e.clientY,
      abovePx: above ? this.heightOf(above) : 0,
      belowPx: below ? this.heightOf(below) : 0,
      budget:
        above && below
          ? this.pairBudget(above, below)
          : this.singleBudget((above ?? below)!),
    };
    sash.classList.add("dragging");
    document.body.classList.add("dragging-row");
  }

  /** 两侧展开时的预算：两区高度之和的上限（扣掉其它手调分区，给仍均分的分区留下限） */
  private pairBudget(above: SidebarView, below: SidebarView): number {
    let liftedPx = 0;
    let liftedCount = 0;
    for (const [view, px] of this.sizes) {
      if (!this.expanded.has(view) || view === above || view === below) continue;
      liftedPx += px;
      liftedCount += 1;
    }
    const poolCount = this.expanded.size - 2 - liftedCount;
    return (
      this.availableHeight() - liftedPx - MIN_SECTION_PX * Math.max(0, poolCount)
    );
  }

  /** 单侧展开时的预算：目标分区能占到的最大高度（给其它展开区留下限） */
  private singleBudget(target: SidebarView): number {
    let liftedPx = 0;
    let poolCount = 0;
    for (const view of this.expanded) {
      if (view === target) continue;
      const px = this.sizes.get(view);
      if (px === undefined) poolCount += 1;
      else liftedPx += px;
    }
    const room = this.availableHeight() - liftedPx - MIN_SECTION_PX * poolCount;
    return Math.max(MIN_SECTION_PX, room);
  }

  private moveDrag(e: MouseEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const budget = Math.max(MIN_SECTION_PX, drag.budget);
    if (drag.above && drag.below) {
      // 两区展开：只在二者之间分配高度，总高不变，边界始终贴着光标
      const total = clamp(drag.abovePx + drag.belowPx, MIN_SECTION_PX * 2, budget);
      const abovePx = clamp(drag.abovePx + dy, MIN_SECTION_PX, total - MIN_SECTION_PX);
      this.sizes.set(drag.above, abovePx);
      this.sizes.set(drag.below, total - abovePx);
    } else if (drag.above) {
      // 只有上方展开：向下拖 = 变高
      this.sizes.set(drag.above, clamp(drag.abovePx + dy, MIN_SECTION_PX, budget));
    } else if (drag.below) {
      // 只有下方展开：向上拖 = 变高
      this.sizes.set(drag.below, clamp(drag.belowPx - dy, MIN_SECTION_PX, budget));
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
    this.persistLayout();
  }

  /** 双击分隔线：清掉手调高度，回到「按内容」的默认高度 */
  private resetSizes(): void {
    this.sizes.clear();
    for (const view of this.expanded) this.initSize(view);
    this.apply();
    this.persistLayout();
  }

  /**
   * 高度收口（窗口缩放 / 终端开合 / 展开收起后）：
   * - 有填充区：给它们留出 MIN，不够就按比例收回固定高度；
   * - 全是固定高度：允许总高小于可用高度（吸附底部的分区上方留白 = 拖拽余量），
   *   只有溢出可用高度时才按比例收回，保证底部分区不脱底。
   */
  private fitSizes(): void {
    const fillers = this.fillers();
    const explicit = [...this.sizes.entries()].filter(
      ([view]) => this.expanded.has(view) && !fillers.has(view),
    );
    if (explicit.length === 0) return; // 全部由 flex 均分，无需干预
    const avail = this.availableHeight();
    const used = explicit.reduce((sum, [, px]) => sum + px, 0);
    const pool = this.expanded.size - explicit.length;
    if (pool > 0) {
      const room = avail - MIN_SECTION_PX * pool;
      if (used <= room) return;
      this.scaleSizes(explicit, room <= 0 ? 0 : room / used);
      return;
    }
    if (used <= avail) return;
    this.scaleSizes(explicit, avail <= 0 ? 0 : avail / used);
  }

  /** 按比例缩放手调高度（保底 MIN）后重排 */
  private scaleSizes(explicit: [SidebarView, number][], factor: number): void {
    for (const [view, px] of explicit) {
      this.sizes.set(view, Math.max(MIN_SECTION_PX, px * factor));
    }
    this.applySizes();
  }

  /** 可供展开分区使用的高度：侧栏总高 -（收起分区 + 分隔线） */
  private availableHeight(): number {
    let fixed = 0;
    for (const el of this.sectionsEl.children) {
      const view = viewOfSection(el);
      if (view === null || !this.expanded.has(view)) fixed += (el as HTMLElement).offsetHeight;
    }
    return Math.max(0, this.sectionsEl.clientHeight - fixed);
  }

  private heightOf(view: SidebarView): number {
    return this.sections.get(view)?.getBoundingClientRect().height ?? 0;
  }

  /** DOM 顺序的分区（判断「最后一个」用：Map 的插入顺序与界面顺序无关） */
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
