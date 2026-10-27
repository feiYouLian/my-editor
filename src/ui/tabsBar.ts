/**
 * 标签栏：标签渲染（签名优化）、滚轮横向滚动、双击空白新建、
 * 标签右键菜单（比较 / 关闭当前 / 左右 / 其他 / 全部）。
 *
 * 数据直接读 store/tabs（ui → store 允许）；跨模块动作
 * （比较、批量关闭前的草稿清理）经 callbacks 交回 main.ts。
 */

import { tabStore } from "../store/tabs";
import { placeMenu } from "./menu";

export interface TabsBarCallbacks {
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** 右键「与当前标签比较」 */
  onCompareWith: (tabId: string) => void;
  /** 右键「重新载入（从磁盘）」：文件被外部改动 / 保存失败后的固定入口 */
  onReload?: (tabId: string) => void;
  /** 批量关闭（main.ts 负责关闭前的草稿清理） */
  onBulkClose: (kind: "left" | "right" | "others" | "all", tabId: string) => void;
  /** 双击标签栏空白处 */
  onNewTab: () => void;
}

export class TabsBar {
  /** 上次渲染的标签签名：输入时标签集未变则跳过整栏重建 */
  private signature = "";
  /** 上次渲染时的激活标签 id（用于只切 class 的增量路径） */
  private activeId = "";
  private menu: HTMLElement | null = null;

  /** 标签栏右侧常驻「新建」按钮（双击空白仍可用，此处只为发现性） */
  private ensureAddButton(): void {
    const parent = this.container.parentElement;
    if (!parent || parent.querySelector(".tab-add")) return;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "icon-btn tab-add";
    add.title = "新建未命名文档（Ctrl+N）";
    add.setAttribute("aria-label", "新建文档");
    add.textContent = "+";
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      this.callbacks.onNewTab();
    });
    this.container.after(add);
  }

  constructor(
    private container: HTMLElement,
    private callbacks: TabsBarCallbacks,
  ) {
    // 标签过多时支持鼠标滚轮横向滚动
    container.addEventListener(
      "wheel",
      (e) => {
        // 未溢出时不拦截滚动，交给默认行为
        if (e.deltaY === 0 || container.scrollWidth <= container.clientWidth) return;
        container.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );

    // 双击标签栏空白处新建标签（点在标签或按钮上不触发）
    document.querySelector<HTMLElement>(".tabsbar")?.addEventListener("dblclick", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tab") || target.closest("button")) return;
      callbacks.onNewTab();
    });

    this.ensureAddButton();

    document.addEventListener("click", () => this.closeMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });

    this.wireDrag();
  }

  // ---- 标签拖拽排序（pointer 事件：WebView2 下比 HTML5 DnD 稳） ----

  /** 拖拽结束后的抑制窗口：避免 pointerup 后的 click 把标签切成激活 */
  private suppressActivateUntil = 0;
  private dragState: {
    id: string;
    startX: number;
    pointerId: number;
    active: boolean;
  } | null = null;
  private dropMarker: HTMLElement | null = null;
  /** 基于「原数组」的插入位置（拖动中实时更新） */
  private dropIndex = 0;

  private wireDrag(): void {
    this.container.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // 关闭按钮上的按下不进入拖拽
      if (target.closest(".tab-close")) return;
      const el = target.closest<HTMLElement>(".tab");
      const id = el?.dataset.tabId;
      if (!el || !id) return;
      this.dragState = { id, startX: e.clientX, pointerId: e.pointerId, active: false };
    });

    window.addEventListener("pointermove", (e) => {
      const state = this.dragState;
      if (!state || e.pointerId !== state.pointerId) return;
      if (!state.active) {
        // 4px 阈值：低于它仍视为点击
        if (Math.abs(e.clientX - state.startX) < 4) return;
        state.active = true;
        this.container
          .querySelector<HTMLElement>(`.tab[data-tab-id="${CSS.escape(state.id)}"]`)
          ?.classList.add("dragging");
        const marker = document.createElement("div");
        marker.className = "tab-drop-marker";
        document.body.append(marker);
        this.dropMarker = marker;
      }
      e.preventDefault();
      this.dropIndex = this.computeDropIndex(e.clientX);
      this.positionMarker();
    });

    window.addEventListener("pointerup", (e) => {
      const state = this.dragState;
      if (!state || e.pointerId !== state.pointerId) return;
      if (state.active) {
        this.suppressActivateUntil = performance.now() + 150;
        tabStore.move(state.id, this.indexAfterRemoval(state.id, this.dropIndex));
      }
      this.endDrag();
    });

    window.addEventListener("pointercancel", () => this.endDrag());
  }

  /** 拖动中的 clientX → 原数组插入位置（左半边靠前、右半边靠后） */
  private computeDropIndex(clientX: number): number {
    const tabs = [...this.container.querySelectorAll<HTMLElement>(".tab")];
    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabs.length;
  }

  /** 原数组插入位置 → 移除拖拽项后的数组索引（与 tabStore.move 的约定一致） */
  private indexAfterRemoval(dragId: string, index: number): number {
    const from = tabStore.list().findIndex((t) => t.id === dragId);
    if (from < 0) return index;
    return index > from ? index - 1 : index;
  }

  /** 指示线吸附到最近的标签间隙（fixed 定位，不受横向滚动影响取错） */
  private positionMarker(): void {
    const marker = this.dropMarker;
    if (!marker) return;
    const tabs = [...this.container.querySelectorAll<HTMLElement>(".tab")];
    if (tabs.length === 0) return;
    const first = tabs[0].getBoundingClientRect();
    let x: number;
    if (this.dropIndex <= 0) x = first.left;
    else if (this.dropIndex >= tabs.length) x = tabs[tabs.length - 1].getBoundingClientRect().right;
    else x = tabs[this.dropIndex].getBoundingClientRect().left;
    marker.style.left = `${x - 1}px`;
    marker.style.top = `${first.top}px`;
    marker.style.height = `${first.height}px`;
  }

  private endDrag(): void {
    const state = this.dragState;
    if (state?.active) {
      this.container
        .querySelector<HTMLElement>(`.tab[data-tab-id="${CSS.escape(state.id)}"]`)
        ?.classList.remove("dragging");
    }
    this.dragState = null;
    this.dropMarker?.remove();
    this.dropMarker = null;
  }

  /** 结构签名（不含激活项）：只有增删/改名/脏标记变化才重建整栏 */
  private renderSignature(): string {
    return tabStore
      .list()
      .map(
        (t) =>
          `${t.id}\u0001${t.name}\u0001${t.dirty ? 1 : 0}\u0001${t.externallyChanged ? 1 : 0}`,
      )
      .join("\u0002");
  }

  /** 只切激活类：切标签时整栏重建会闪一下，并丢掉鼠标 hover 状态 */
  private syncActive(): void {
    const activeId = tabStore.active()?.id ?? "";
    if (activeId === this.activeId) return;
    this.activeId = activeId;
    this.container.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.tabId === activeId);
    });
    this.scrollActiveIntoView();
  }

  /** 标签过多溢出时，将激活标签滚入视野 */
  private scrollActiveIntoView(): void {
    this.container
      .querySelector<HTMLElement>(".tab.active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  render(): void {
    const signature = this.renderSignature();
    if (signature === this.signature) {
      this.syncActive();
      return;
    }
    this.signature = signature;
    this.activeId = tabStore.active()?.id ?? "";

    this.container.innerHTML = "";
    for (const tab of tabStore.list()) {
      const el = document.createElement("div");
      el.className = `tab${tab.id === tabStore.active()?.id ? " active" : ""}`;
      el.dataset.tabId = tab.id;

      // 外部修改标记：后台标签也可见（状态栏只显示激活标签，靠它才不会错过）
      if (tab.externallyChanged) {
        el.classList.add("external");
        const mark = document.createElement("span");
        mark.className = "tab-external";
        mark.textContent = "⟳";
        mark.title = "磁盘文件已被外部修改";
        el.append(mark);
      }

      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = tab.dirty ? `● ${tab.name}` : tab.name;
      name.title = tab.path ?? "未命名";
      name.addEventListener("click", () => {
        if (performance.now() < this.suppressActivateUntil) return;
        this.callbacks.onActivate(tab.id);
      });

      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "关闭";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.callbacks.onClose(tab.id);
      });

      el.append(name, close);
      // 中键关闭（与浏览器 / VS Code 一致）
      el.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        this.callbacks.onClose(tab.id);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showMenu(e.clientX, e.clientY, tab.id);
      });
      this.container.append(el);
    }
    this.container.classList.toggle("hidden", tabStore.list().length === 0);
    this.scrollActiveIntoView();
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private showMenu(x: number, y: number, tabId: string): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";

    const items: { label: string; run: () => void }[] = [
      { label: "与当前标签比较", run: () => this.callbacks.onCompareWith(tabId) },
    ];
    // 只有磁盘上的文本文件才有"从磁盘重载"的意义（未命名 / 图片 / 虚拟视图没有）
    const target = tabStore.findById(tabId);
    if (target?.path && target.kind === "text" && !target.virtual && this.callbacks.onReload) {
      items.push({ label: "重新载入（从磁盘）", run: () => this.callbacks.onReload?.(tabId) });
    }
    items.push(
      { label: "关闭当前", run: () => this.callbacks.onClose(tabId) },
      { label: "关闭左侧", run: () => this.callbacks.onBulkClose("left", tabId) },
      { label: "关闭右侧", run: () => this.callbacks.onBulkClose("right", tabId) },
      { label: "关闭其他", run: () => this.callbacks.onBulkClose("others", tabId) },
      { label: "关闭全部", run: () => this.callbacks.onBulkClose("all", tabId) },
    );
    for (const item of items) {
      const el = document.createElement("div");
      el.className = "context-menu-item";
      el.textContent = item.label;
      el.addEventListener("click", () => {
        this.closeMenu();
        item.run();
      });
      menu.append(el);
    }
    document.body.append(menu);
    placeMenu(menu, x, y);
    this.menu = menu;
  }
}
