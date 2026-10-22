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
  /** 批量关闭（main.ts 负责关闭前的草稿清理） */
  onBulkClose: (kind: "left" | "right" | "others" | "all", tabId: string) => void;
  /** 双击标签栏空白处 */
  onNewTab: () => void;
}

export class TabsBar {
  /** 上次渲染的标签签名：输入时标签集未变则跳过整栏重建 */
  private signature = "";
  private menu: HTMLElement | null = null;

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

    document.addEventListener("click", () => this.closeMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
  }

  private renderSignature(): string {
    const activeId = tabStore.active()?.id ?? "";
    const list = tabStore
      .list()
      .map((t) => `${t.id}\u0001${t.name}\u0001${t.dirty ? 1 : 0}`)
      .join("\u0002");
    return `${activeId}\u0003${list}`;
  }

  render(): void {
    const signature = this.renderSignature();
    if (signature === this.signature) return;
    this.signature = signature;

    this.container.innerHTML = "";
    for (const tab of tabStore.list()) {
      const el = document.createElement("div");
      el.className = `tab${tab.id === tabStore.active()?.id ? " active" : ""}`;

      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = tab.dirty ? `● ${tab.name}` : tab.name;
      name.title = tab.path ?? "未命名";
      name.addEventListener("click", () => this.callbacks.onActivate(tab.id));

      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "关闭";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.callbacks.onClose(tab.id);
      });

      el.append(name, close);
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showMenu(e.clientX, e.clientY, tab.id);
      });
      this.container.append(el);
    }
    this.container.classList.toggle("hidden", tabStore.list().length === 0);
    // 标签过多溢出时，将激活标签滚入视野
    this.container
      .querySelector<HTMLElement>(".tab.active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
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
      { label: "关闭当前", run: () => this.callbacks.onClose(tabId) },
      { label: "关闭左侧", run: () => this.callbacks.onBulkClose("left", tabId) },
      { label: "关闭右侧", run: () => this.callbacks.onBulkClose("right", tabId) },
      { label: "关闭其他", run: () => this.callbacks.onBulkClose("others", tabId) },
      { label: "关闭全部", run: () => this.callbacks.onBulkClose("all", tabId) },
    ];
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
