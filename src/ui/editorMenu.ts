/**
 * 编辑器右键菜单机制：主菜单 + 二级子菜单的渲染、定位、悬停延迟关闭。
 *
 * 菜单「内容」（哪些条目可见、依赖只读/选区/语言等状态）由调用方以
 * buildEntries 回调提供——那是领域逻辑，留在 main.ts；本模块只做
 * 与内容无关的菜单机器（子菜单计时、越界翻转、焦点外关闭）。
 */

import { placeMenu } from "./menu";

export interface MenuEntry {
  label?: string;
  shortcut?: string;
  run?: () => void;
  separator?: boolean;
  submenu?: MenuEntry[];
}

export class EditorContextMenu {
  private menu: HTMLElement | null = null;
  private submenu: HTMLElement | null = null;
  private submenuTimer: number | null = null;

  constructor(
    dom: HTMLElement,
    private buildEntries: () => MenuEntry[],
  ) {
    dom.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.open(e.clientX, e.clientY);
    });
    document.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  private closeSubmenu(): void {
    if (this.submenuTimer !== null) {
      window.clearTimeout(this.submenuTimer);
      this.submenuTimer = null;
    }
    this.submenu?.remove();
    this.submenu = null;
  }

  /** 鼠标离开菜单区域时延迟关闭；指针仍停在任一层菜单上则不关闭 */
  private scheduleSubmenuClose(): void {
    if (this.submenuTimer !== null) window.clearTimeout(this.submenuTimer);
    this.submenuTimer = window.setTimeout(() => {
      this.submenuTimer = null;
      if (this.submenu?.matches(":hover") || this.menu?.matches(":hover")) return;
      this.closeSubmenu();
    }, 150);
  }

  private close(): void {
    this.closeSubmenu();
    this.menu?.remove();
    this.menu = null;
  }

  /**
   * 渲染菜单项。nested=true 表示正在渲染二级菜单：
   * 此时条目自身的悬停不能再关闭所在子菜单。
   */
  private appendEntries(container: HTMLElement, entries: MenuEntry[], nested = false): void {
    for (const item of entries) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        container.append(sep);
        continue;
      }
      const el = document.createElement("div");
      el.className = "context-menu-item";
      const label = document.createElement("span");
      label.textContent = item.label ?? "";
      el.append(label);

      if (item.submenu) {
        el.classList.add("has-submenu");
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = "›";
        el.append(arrow);
        el.addEventListener("mouseenter", () => {
          if (this.submenuTimer !== null) {
            window.clearTimeout(this.submenuTimer);
            this.submenuTimer = null;
          }
          this.openSubmenu(el, item.submenu!);
        });
      } else {
        if (item.shortcut) {
          const sc = document.createElement("span");
          sc.className = "shortcut";
          sc.textContent = item.shortcut;
          el.append(sc);
        }
        if (!nested) {
          // 主菜单内悬停到普通条目时收起已展开的子菜单
          el.addEventListener("mouseenter", () => this.closeSubmenu());
        }
        el.addEventListener("click", () => {
          this.close();
          item.run?.();
        });
      }
      container.append(el);
    }
  }

  private openSubmenu(parent: HTMLElement, entries: MenuEntry[]): void {
    this.closeSubmenu();
    const sub = document.createElement("div");
    sub.className = "context-menu editor-submenu";
    this.appendEntries(sub, entries, true);
    sub.addEventListener("mouseenter", () => {
      if (this.submenuTimer !== null) {
        window.clearTimeout(this.submenuTimer);
        this.submenuTimer = null;
      }
    });
    sub.addEventListener("mouseleave", () => this.scheduleSubmenuClose());
    document.body.append(sub);
    // 紧贴父项定位：与父项重叠 4px，保证指针移动时没有可落空的缝隙；
    // 右侧空间不足时翻到父项左侧
    const rect = parent.getBoundingClientRect();
    const overlap = 4;
    let left = rect.right - overlap;
    if (left + sub.offsetWidth > window.innerWidth - 4) {
      left = rect.left - sub.offsetWidth + overlap;
    }
    left = Math.max(4, Math.min(left, window.innerWidth - sub.offsetWidth - 4));
    const top = Math.max(4, Math.min(rect.top - 4, window.innerHeight - sub.offsetHeight - 4));
    sub.style.left = `${left}px`;
    sub.style.top = `${top}px`;
    this.submenu = sub;
  }

  open(x: number, y: number): void {
    this.close();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    // 指针离开整个主菜单后才开始收起子菜单；移入子菜单会取消该计时
    menu.addEventListener("mouseleave", () => {
      if (this.submenu) this.scheduleSubmenuClose();
    });
    this.appendEntries(menu, this.buildEntries());
    document.body.append(menu);
    placeMenu(menu, x, y);
    this.menu = menu;
  }
}
