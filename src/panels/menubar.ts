/**
 * 菜单栏：渲染标题栏左侧的顶部菜单与下拉项。
 * 行为对齐原生应用：点击标题展开、悬停切换、点击外部/Esc 关闭。
 * 注意：标题使用 <button>，会被 Tauri 拖拽区自动排除（drag.js 的
 * isClickableElement），不影响标题栏拖动。
 *
 * 菜单数据模型见 core/commands.ts（menuModel 派生），本组件只负责渲染。
 */

import type { MenuItemModel, MenuModel } from "../core/commands";

export type { MenuItemModel, MenuModel };

export class MenuBar {
  private dropdown: HTMLElement | null = null;
  private openId: string | null = null;

  constructor(
    private container: HTMLElement,
    private menus: readonly MenuModel[],
  ) {
    this.render();
    document.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  private render(): void {
    this.container.innerHTML = "";
    for (const menu of this.menus) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-title";
      btn.dataset.menu = menu.id;
      btn.textContent = menu.label;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggle(menu.id, btn);
      });
      btn.addEventListener("mouseenter", () => {
        // 已展开时，悬停其他标题直接切换
        if (this.openId && this.openId !== menu.id) this.open(menu.id, btn);
      });
      this.container.append(btn);
    }
  }

  private toggle(id: string, anchor: HTMLElement): void {
    if (this.openId === id) {
      this.close();
      return;
    }
    this.open(id, anchor);
  }

  private open(id: string, anchor: HTMLElement): void {
    this.close();
    const menu = this.menus.find((m) => m.id === id);
    if (!menu) return;

    const dd = document.createElement("div");
    dd.className = "menu-dropdown";
    for (const item of menu.items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "menu-separator";
        dd.append(sep);
        continue;
      }
      const el = document.createElement("div");
      el.className = "menu-item";
      const label = document.createElement("span");
      label.textContent = item.label ?? "";
      el.append(label);
      if (item.shortcut) {
        const sc = document.createElement("span");
        sc.className = "shortcut";
        sc.textContent = item.shortcut;
        el.append(sc);
      }
      if (item.run) {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close();
          item.run?.();
        });
      } else {
        el.classList.add("disabled");
      }
      dd.append(el);
    }

    document.body.append(dd);
    const rect = anchor.getBoundingClientRect();
    dd.style.left = `${rect.left}px`;
    dd.style.top = `${rect.bottom}px`;
    // 防止右侧溢出
    const ddRect = dd.getBoundingClientRect();
    if (ddRect.right > window.innerWidth - 8) {
      dd.style.left = `${window.innerWidth - ddRect.width - 8}px`;
    }

    this.dropdown = dd;
    this.openId = id;
    anchor.classList.add("open");
    dd.addEventListener("click", (e) => e.stopPropagation());
  }

  private close(): void {
    this.dropdown?.remove();
    this.dropdown = null;
    this.openId = null;
    this.container
      .querySelectorAll(".menu-title.open")
      .forEach((el) => el.classList.remove("open"));
  }
}
