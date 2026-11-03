/**
 * 布局：侧栏显隐 / 侧栏宽度拖拽 / 双栏分割线拖动。
 * 侧栏宽度记忆于 localStorage；分栏比例写回 config.json（单一真源）。
 */

import { getConfig } from "../config/settings";

/** 侧栏宽度默认值（双击复位） */
const DEFAULT_SIDEBAR_WIDTH = 240;

export interface LayoutDeps {
  /** 当前预览是否为双栏模式（仅此时可拖分割线） */
  isSplitMode: () => boolean;
  /** 侧栏显隐持久化（防抖写 config.json） */
  persistSidebarVisible: (visible: boolean) => void;
  /** 分栏比例持久化（config.json 单一真源） */
  persistSplitRatio: (ratio: number) => void;
}

export class LayoutPane {
  private sidebarVisible = true;
  private resizing = false;
  private sidebarResizing = false;
  /** 拖拽合帧：mousemove 只记最新值，每帧最多应用一次 */
  private dragRaf: number | null = null;
  /** 待应用的拖拽结果（宽度 px 或分割比例） */
  private pendingSidebarX: number | null = null;
  private pendingSplitX: number | null = null;
  /** 最近一次应用的侧栏宽度 / 分栏比例（松手时落盘用） */
  private sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  private splitRatioLast = 0.5;
  /**
   * 拖拽起点的容器几何（缓存值）：
   * 拖拽期间窗口尺寸不会变，没必要每次 mousemove 都 getBoundingClientRect()——
   * 那是强制同步布局，紧跟在上一帧的样式写入之后会直接造成 layout thrash。
   */
  private mainLeft = 0;
  private splitRect: { left: number; width: number } | null = null;
  /** 上一帧真正写进 CSS 的分栏比例：值相同就不重复写（省掉无谓的样式失效） */
  private appliedSplit: number | null = null;
  /** 缓存的主区元素：避免每次拖拽都 querySelector */
  private mainEl: HTMLElement | null = null;
  /** 是否已把宽度写进 CSS：首帧必须写一次，之后才按值去重 */
  private sidebarApplied = false;

  constructor(private deps: LayoutDeps) {
    this.initSplitResizer();
    this.initSidebarResizer();
    // 窗口尺寸变化后几何缓存失效（下次 mousedown 重新测）
    window.addEventListener("resize", () => {
      this.splitRect = null;
    });
  }

  /** 主区元素（按需查找并缓存；装配时机变化时也不会丢功能） */
  private main(): HTMLElement | null {
    if (!this.mainEl) this.mainEl = document.querySelector<HTMLElement>(".main");
    return this.mainEl;
  }

  /** 合帧执行：同一帧内后到的位置覆盖先到的（末次必达） */
  private scheduleDrag(apply: () => void): void {
    if (this.dragRaf !== null) return;
    this.dragRaf = requestAnimationFrame(() => {
      this.dragRaf = null;
      apply();
    });
  }

  // ---- 侧栏显隐 ----

  /** 侧栏当前是否可见（菜单勾选态：配置写回有防抖，不能读配置） */
  get isSidebarVisible(): boolean {
    return this.sidebarVisible;
  }

  /** 仅应用到界面（设置中心回调用，持久化由 updateSettings 完成） */
  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible;
    this.main()?.classList.toggle("no-sidebar", !visible);
    // 收起后侧栏连同头部开关一起不可见，改由标签栏左端的按钮负责展开
    const showBtn = document.getElementById("btn-sidebar-show");
    if (showBtn instanceof HTMLElement) showBtn.hidden = visible;
  }

  /** 切换侧栏并写回配置 */
  toggleSidebar(): void {
    this.setSidebarVisible(!this.sidebarVisible);
    this.deps.persistSidebarVisible(this.sidebarVisible);
  }

  /** 启动时按配置应用侧栏显隐 */
  applyConfiguredSidebar(): void {
    this.setSidebarVisible(getConfig().layout.sidebarVisible);
  }

  // ---- 侧栏宽度 ----

  setSidebarWidth(px: number): void {
    this.persistSidebarWidth(this.applySidebarWidth(px));
  }

  /** 只改样式，不落盘（拖动过程中每帧调用，localStorage 写入放到松手） */
  private applySidebarWidth(px: number): number {
    const clamped = Math.min(640, Math.max(150, px));
    // 亚像素抖动会带来无意义的样式失效：值没变就不写（首帧必须写一次，
    // 不能依赖 CSS 里的兜底默认值，否则默认值改动后两处口径会漂移）
    if (this.sidebarApplied && clamped === this.sidebarWidth) return clamped;
    this.sidebarApplied = true;
    this.sidebarWidth = clamped;
    this.main()?.style.setProperty("--sidebar-width", `${clamped}px`);
    return clamped;
  }

  private persistSidebarWidth(px: number): void {
    try {
      localStorage.setItem("my-editor.sidebarWidth", String(px));
    } catch {
      // localStorage 不可用时仅会话内生效
    }
  }

  private initSidebarResizer(): void {
    const el = document.getElementById("sidebar-resizer");
    el?.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.sidebarResizing = true;
      // 拖动期间窗口几何不会变：起点测一次，之后只做减法
      this.mainLeft = this.main()?.getBoundingClientRect().left ?? 0;
      el.classList.add("dragging");
      document.body.classList.add("dragging-split");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.sidebarResizing || !this.main()) return;
      // 合帧：同一帧内只应用最新位置，避免每次 mousemove 都触发布局
      this.pendingSidebarX = e.clientX - this.mainLeft;
      this.scheduleDrag(() => {
        if (this.pendingSidebarX !== null) this.applySidebarWidth(this.pendingSidebarX);
      });
    });
    window.addEventListener("mouseup", () => {
      if (!this.sidebarResizing) return;
      this.sidebarResizing = false;
      this.pendingSidebarX = null;
      el?.classList.remove("dragging");
      document.body.classList.remove("dragging-split");
      // 松手才落盘：拖动过程中不产生任何同步 IO
      this.persistSidebarWidth(this.sidebarWidth);
    });
    el?.addEventListener("dblclick", () => this.setSidebarWidth(DEFAULT_SIDEBAR_WIDTH));
    try {
      const saved = localStorage.getItem("my-editor.sidebarWidth");
      if (saved) this.setSidebarWidth(Number(saved));
    } catch {
      // localStorage 不可用：用默认宽度
    }
  }

  // ---- 双栏分割线 ----

  private splitArea(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".editor-area");
  }

  private initSplitResizer(): void {
    const el = document.getElementById("split-resizer");
    el?.addEventListener("mousedown", (e) => {
      if (this.deps.isSplitMode() !== true) return;
      this.resizing = true;
      // 同上：拖拽期间容器几何不变，起点测一次即可（避免 mousemove 强制同步布局）
      const rect = this.splitArea()?.getBoundingClientRect();
      this.splitRect = rect ? { left: rect.left, width: rect.width } : null;
      // 外部（设置中心滑杆 / 双击复位）可能改过 CSS，首帧强制写一次
      this.appliedSplit = null;
      el.classList.add("dragging");
      document.body.classList.add("dragging-split");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.resizing) return;
      let rect = this.splitRect;
      if (!rect) {
        const measured = this.splitArea()?.getBoundingClientRect();
        if (!measured) return;
        rect = { left: measured.left, width: measured.width };
        this.splitRect = rect;
      }
      if (rect.width <= 0) return;
      this.pendingSplitX = Math.min(0.85, Math.max(0.15, (e.clientX - rect.left) / rect.width));
      this.scheduleDrag(() => {
        if (this.pendingSplitX === null) return;
        this.splitRatioLast = this.pendingSplitX;
        if (this.appliedSplit === this.pendingSplitX) return;
        this.appliedSplit = this.pendingSplitX;
        this.splitArea()?.style.setProperty(
          "--split-ratio",
          `${(this.splitRatioLast * 100).toFixed(1)}%`,
        );
      });
    });
    window.addEventListener("mouseup", () => {
      if (!this.resizing) return;
      this.resizing = false;
      this.pendingSplitX = null;
      this.appliedSplit = null;
      el?.classList.remove("dragging");
      document.body.classList.remove("dragging-split");
      // 松手才落盘：以当前 CSS 值为准（滑杆刚改过、拖拽未移动时也不会写回旧比例）
      const applied = parseFloat(
        this.splitArea()?.style.getPropertyValue("--split-ratio") ?? "",
      ) / 100;
      const ratio = Number.isFinite(applied)
        ? Math.min(0.85, Math.max(0.15, applied))
        : this.splitRatioLast;
      this.splitRatioLast = ratio;
      this.deps.persistSplitRatio(ratio);
    });
    el?.addEventListener("dblclick", () => {
      this.splitRatioLast = 0.5;
      this.splitArea()?.style.setProperty("--split-ratio", "50%");
      this.deps.persistSplitRatio(0.5);
    });
  }

  /** 启动时按配置应用分栏比例（config 是唯一真源） */
  applyConfiguredSplitRatio(): void {
    const configured = getConfig().layout.splitRatio;
    this.splitRatioLast = configured;
    this.splitArea()?.style.setProperty("--split-ratio", `${(configured * 100).toFixed(1)}%`);
  }
}
