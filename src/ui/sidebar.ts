/**
 * 侧栏分区（VS Code 风格折叠列表）：
 * 「正在打开的文件 / 文件 / 搜索 / 大纲 / 源代码管理」标题纵向排列。
 *
 * 布局规则：
 * - 展开区分两种高度：内容够小按内容给（不抢其它分区的空间），内容比可用空间
 *   大则保持均分、吸收剩余高度；收起区只占标题行，侧栏不再整体滚动；
 * - 分区之间的分隔线可上下拖拽：两侧都展开时在二者之间分配高度，
 *   多个分区展开时只有一侧展开的那条线也可拖（只调整该侧）；
 *   唯一展开的分区铺满剩余空间，不开放拖拽；双击按内容复位；
 * - 分区高度 / 展开组合写回 config.json，启动时按此恢复（
 *   config.layout.sidebarView 仍记录当前分区）。
 */

export type SidebarView = "open" | "git" | "files" | "search" | "outline";

/** 全部合法分区 id（用于校验 config.json 这类外部输入） */
const SIDEBAR_VIEWS: readonly SidebarView[] = ["open", "git", "files", "search", "outline"];

/** 分区最小高度：标题行 30px + 至少一行内容 */
const MIN_SECTION_PX = 60;

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
  /** 手调 / 按内容计算的分区高度（px）：未记录的分区均分剩余高度 */
  private readonly sizes = new Map<SidebarView, number>();
  /** 用户手拖过的分区：高度只认用户设定，内容变化时不再自动贴合 */
  private readonly manual = new Set<SidebarView>();

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
    });
    this.initSashes();
    // 侧栏高度变化（窗口缩放 / 终端面板开合）：挤不下时按比例收回手调高度
    new ResizeObserver(() => this.fitSizes()).observe(this.sectionsEl);
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
        if (this.measureIfNeeded(view)) changed = true;
      }
      pending.clear();
      if (changed) this.apply();
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
    for (const [id, px] of Object.entries(cfg.sidebarSizes ?? {})) {
      const view = id as SidebarView;
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
    // display:none 的分区量不到内容高度：先亮出内容再初始化高度
    for (const view of this.expanded) this.panes[view].classList.remove("hidden");
    for (const view of this.expanded) this.initSize(view);
    this.apply();
  }

  /** 点击标题：独立展开 / 收起（收起不改变持久化的当前分区） */
  private toggle(view: SidebarView): void {
    if (this.expanded.has(view)) {
      this.expanded.delete(view);
      // 收起后丢掉高度与手调标记，再次展开时按内容重新给
      this.sizes.delete(view);
      this.manual.delete(view);
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
    for (const [view, section] of this.sections) {
      const px = this.expanded.has(view) && !fillers.has(view) ? this.sizes.get(view) : undefined;
      section.style.flex = px === undefined ? "" : `0 0 ${Math.round(px)}px`;
    }
    this.syncSashes();
  }

  /**
   * 填充区（均分富余高度）：
   * 1) 还没量过内容 / 内容比可用空间大的展开区；
   * 2) 只有它一个展开区时（否则内容少的分区只占一小块，中间会留一大片空）。
   */
  private fillers(): Set<SidebarView> {
    const implicit = [...this.expanded].filter((view) => !this.sizes.has(view));
    if (implicit.length > 0) return new Set(implicit);
    return this.expanded.size <= 1 ? new Set(this.expanded) : new Set();
  }

  /**
   * 写回 config.json（展开组合 / 高度），由装配层合并进 layout。
   * 只持久化用户手拖的高度：按内容算出来的高度每次启动重算即可，
   * 否则内容变化后会带着过期高度出现空行。
   */
  private persistLayout(): void {
    this.deps.onLayout({
      sidebarExpanded: this.domOrder().filter((view) => this.expanded.has(view)),
      sidebarSizes: Object.fromEntries(
        [...this.sizes].filter(([view]) => this.manual.has(view)),
      ),
    });
  }

  /**
   * 展开分区时给一个初始高度：内容自然高度小于可用空间就按内容给
   * （不抢其它分区的空间）；内容更多（或还没渲染出内容）则留空，
   * 继续由 flex 均分吸收剩余高度；唯一展开的分区直接铺满（VS Code 的展开即占满）。
   */
  private initSize(view: SidebarView): void {
    if (this.sizes.has(view)) return;
    this.measureIfNeeded(view);
  }

  /** 内容变化 / 首次展开时该不该重算：单区铺满与用户手拖过的分区不参与 */
  private measureIfNeeded(view: SidebarView): boolean {
    if (!this.expanded.has(view) || this.manual.has(view)) return false;
    if (this.expanded.size <= 1) return false;
    return this.measureSize(view);
  }

  /**
   * 按内容重算分区高度（手调标记不在此判断）。
   * 内容超出可用空间时不设固定高度，交回 flex 均分/吸收；
   * 否则按内容给（不低于 MIN，不挤掉其它展开区的下限）。
   * 返回是否真的改变了高度（调用方据此决定要不要重排）。
   */
  private measureSize(view: SidebarView): boolean {
    const section = this.sections.get(view);
    const body = this.panes[view];
    if (!section || !body) return false;
    const content = contentHeight(body);
    // 内容未渲染（如刚启动的文件树）：量不到高度，保持均分
    if (content <= 0) return false;
    const head = section.querySelector<HTMLElement>(".sidebar-section-head");
    const natural = (head?.offsetHeight ?? 0) + content;
    const avail = this.availableHeight();
    const prev = this.sizes.get(view);
    if (natural >= avail) {
      if (prev === undefined) return false;
      this.sizes.delete(view);
      return true;
    }
    const others = [...this.expanded].filter((other) => other !== view);
    const fixed = others.reduce((sum, other) => sum + (this.sizes.get(other) ?? 0), 0);
    const flexible = others.filter((other) => !this.sizes.has(other)).length;
    const cap = avail - fixed - MIN_SECTION_PX * flexible;
    const next = Math.round(clamp(natural, MIN_SECTION_PX, Math.max(MIN_SECTION_PX, cap)));
    if (prev !== undefined && Math.abs(prev - next) < 1) return false;
    this.sizes.set(view, next);
    return true;
  }

  /**
   * 分隔线可拖拽态：
   * - 两侧都展开：在二者之间分配高度；
   * - 只有一侧展开：只调整该侧高度（多个分区展开时一律开放——相邻分区往往一开一收，
   *   旧的「两侧都必须展开」会让文件 + 源代码管理同时展开时一根分隔线都拖不动）；
   * - 唯一展开的分区不开放：它铺满剩余空间，拖出下方留白没有意义。
   */
  private syncSashes(): void {
    this.sectionsEl.querySelectorAll<HTMLElement>(".sidebar-sash").forEach((sash) => {
      const above = this.expandedViewOf(sash.previousElementSibling);
      const below = this.expandedViewOf(sash.nextElementSibling);
      const single = above ?? below;
      const draggable =
        above !== null && below !== null
          ? true
          : single !== null && this.expanded.size > 1;
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
      this.manual.add(drag.above);
      this.manual.add(drag.below);
    } else if (drag.above) {
      // 只有上方展开：向下拖 = 变高
      this.sizes.set(drag.above, clamp(drag.abovePx + dy, MIN_SECTION_PX, budget));
      this.manual.add(drag.above);
    } else if (drag.below) {
      // 只有下方展开：向上拖 = 变高
      this.sizes.set(drag.below, clamp(drag.belowPx - dy, MIN_SECTION_PX, budget));
      this.manual.add(drag.below);
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

  /** 双击分隔线：清掉手调高度与标记，回到「按内容」的默认高度 */
  private resetSizes(): void {
    this.sizes.clear();
    this.manual.clear();
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
