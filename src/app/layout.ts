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

  constructor(private deps: LayoutDeps) {
    this.initSplitResizer();
    this.initSidebarResizer();
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
    const clamped = Math.min(640, Math.max(150, px));
    document
      .querySelector<HTMLElement>(".main")
      ?.style.setProperty("--sidebar-width", `${clamped}px`);
    try {
      localStorage.setItem("my-editor.sidebarWidth", String(clamped));
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
      this.setSidebarWidth(e.clientX - main.getBoundingClientRect().left);
    });
    window.addEventListener("mouseup", () => {
      if (!this.sidebarResizing) return;
      this.sidebarResizing = false;
      el?.classList.remove("dragging");
      document.body.classList.remove("dragging-split");
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
      const ratio = Math.min(0.85, Math.max(0.15, (e.clientX - rect.left) / rect.width));
      area.style.setProperty("--split-ratio", `${(ratio * 100).toFixed(1)}%`);
      try {
        localStorage.setItem("my-editor.splitRatio", String(ratio));
      } catch {
        // localStorage 不可用时静默降级为会话内记忆
      }
    });
    window.addEventListener("mouseup", () => {
      if (!this.resizing) return;
      this.resizing = false;
      el?.classList.remove("dragging");
      document.body.classList.remove("dragging-split");
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
