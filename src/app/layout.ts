/**
 * 布局：侧栏显隐 / 侧栏宽度拖拽 / 双栏分割线拖动。
 * 宽度与比例记忆于 localStorage（双击复位）。
 */

import { getConfig } from "../config/settings";

/** 侧栏宽度默认值（双击复位） */
const DEFAULT_SIDEBAR_WIDTH = 240;

export interface LayoutDeps {
  /** 当前预览是否为双栏模式（仅此时可拖分割线） */
  isSplitMode: () => boolean;
  /** 侧栏显隐持久化（防抖写 config.json） */
  persistSidebarVisible: (visible: boolean) => void;
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

  constructor(private deps: LayoutDeps) {
    this.initSplitResizer();
    this.initSidebarResizer();
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

  /** 仅应用到界面（设置中心回调用，持久化由 updateSettings 完成） */
  setSidebarVisible(visible: boolean): void {
    this.sidebarVisible = visible;
    document.querySelector(".main")?.classList.toggle("no-sidebar", !visible);
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
    this.sidebarWidth = clamped;
    document
      .querySelector<HTMLElement>(".main")
      ?.style.setProperty("--sidebar-width", `${clamped}px`);
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
      el.classList.add("dragging");
      document.body.classList.add("dragging-split");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.sidebarResizing) return;
      const main = document.querySelector(".main");
      if (!main) return;
      // 合帧：同一帧内只应用最新位置，避免每次 mousemove 都触发布局
      this.pendingSidebarX = e.clientX - main.getBoundingClientRect().left;
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
      el.classList.add("dragging");
      document.body.classList.add("dragging-split");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.resizing) return;
      const area = this.splitArea();
      if (!area) return;
      const rect = area.getBoundingClientRect();
      this.pendingSplitX = Math.min(0.85, Math.max(0.15, (e.clientX - rect.left) / rect.width));
      this.scheduleDrag(() => {
        if (this.pendingSplitX === null) return;
        this.splitRatioLast = this.pendingSplitX;
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
      el?.classList.remove("dragging");
      document.body.classList.remove("dragging-split");
      // 松手才落盘（拖动中每次写 localStorage 会让手感发涩）
      try {
        localStorage.setItem("my-editor.splitRatio", String(this.splitRatioLast));
      } catch {
        // localStorage 不可用时静默降级为会话内记忆
      }
    });
    el?.addEventListener("dblclick", () => {
      this.splitArea()?.style.setProperty("--split-ratio", "50%");
      try {
        localStorage.removeItem("my-editor.splitRatio");
      } catch {
        // 同上
      }
    });
    // 恢复上次的分栏比例
    try {
      const saved = localStorage.getItem("my-editor.splitRatio");
      if (saved) {
        this.splitArea()?.style.setProperty(
          "--split-ratio",
          `${(Number(saved) * 100).toFixed(1)}%`,
        );
      }
    } catch {
      // 同上
    }
  }

  /** 启动时：localStorage 无分栏比例记录则按配置默认值（不写回，留给用户拖动/设置时落盘） */
  applyConfiguredSplitRatio(): void {
    try {
      if (localStorage.getItem("my-editor.splitRatio")) return;
    } catch {
      return;
    }
    const ratio = Math.round(getConfig().layout.splitRatio * 100);
    this.splitArea()?.style.setProperty("--split-ratio", `${ratio}%`);
  }
}
