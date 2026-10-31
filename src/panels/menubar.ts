/**
 * 菜单栏：渲染标题栏左侧的顶部菜单与下拉项。
 * 行为对齐原生应用：点击标题展开、悬停切换、点击外部/Esc 关闭。
 * 注意：标题使用 <button>，会被 Tauri 拖拽区自动排除（drag.js 的
 * isClickableElement），不影响标题栏拖动。
 *
 * 键盘（纯键盘可用，对齐原生菜单 / VS Code）：
 * - 标题间 `←` / `→` 移动焦点，菜单已展开时直接切到相邻菜单并聚焦首项；
 * - `↓` / `Enter` / `Space` 展开，`Esc` 关闭并把焦点还给标题；
 * - 下拉内 `↑` / `↓` / `Home` / `End` 移动，`Enter` / `Space` 执行，`←` / `→` 切菜单。
 *
 * 菜单数据模型见 core/commands.ts（menuModel 派生），本组件只负责渲染。
 */

import type { MenuItemModel, MenuModel } from "../core/commands";

export type { MenuItemModel, MenuModel };

export class MenuBar {
  private dropdown: HTMLElement | null = null;
  private openId: string | null = null;
  /** 当前展开菜单里的可执行项（跳过分隔线与禁用项） */
  private focusables: HTMLElement[] = [];

  constructor(
    private container: HTMLElement,
    private menus: readonly MenuModel[],
  ) {
    this.render();
    document.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.openId) this.close(true);
    });
  }

  private titles(): HTMLButtonElement[] {
    return [...this.container.querySelectorAll<HTMLButtonElement>(".menu-title")];
  }

  private render(): void {
    this.container.innerHTML = "";
    this.menus.forEach((menu, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-title";
      btn.dataset.menu = menu.id;
      btn.textContent = menu.label;
      btn.setAttribute("role", "menuitem");
      btn.setAttribute("aria-haspopup", "true");
      btn.setAttribute("aria-expanded", "false");
      // 漫游 tabindex：整个菜单栏只占一个 Tab 停靠点
      btn.tabIndex = index === 0 ? 0 : -1;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggle(menu.id, btn);
      });
      btn.addEventListener("mouseenter", () => {
        // 已展开时，悬停其他标题直接切换
        if (this.openId && this.openId !== menu.id) this.open(menu.id, btn, false);
      });
      btn.addEventListener("keydown", (e) => this.onTitleKey(e, menu.id, btn));
      this.container.append(btn);
    });
  }

  /** 标题行的键盘：←/→ 移动焦点，↓/Enter/Space 展开，Esc 关闭 */
  private onTitleKey(e: KeyboardEvent, id: string, btn: HTMLButtonElement): void {
    const titles = this.titles();
    const index = titles.indexOf(btn);
    const move = (delta: number): void => {
      if (titles.length === 0) return;
      const next = titles[(index + delta + titles.length) % titles.length];
      this.focusTitle(next);
      // 已有菜单展开时，用键盘移动焦点视为切换菜单（与原生一致）
      if (this.openId) this.open(next.dataset.menu ?? id, next, true);
    };

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        move(-1);
        return;
      case "ArrowRight":
        e.preventDefault();
        move(1);
        return;
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        if (this.openId === id) this.focusFirstItem();
        else this.open(id, btn, true);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.open(id, btn, true, true);
        return;
      case "Home":
        e.preventDefault();
        this.focusTitle(titles[0]);
        return;
      case "End":
        e.preventDefault();
        this.focusTitle(titles[titles.length - 1]);
        return;
      case "Escape":
        if (this.openId) {
          e.preventDefault();
          this.close(true);
        }
        return;
      default:
        return;
    }
  }

  /** 焦点落到某个标题：同时修正漫游 tabindex */
  private focusTitle(target: HTMLButtonElement | undefined): void {
    if (!target) return;
    for (const btn of this.titles()) btn.tabIndex = btn === target ? 0 : -1;
    target.focus({ preventScroll: true });
  }

  private toggle(id: string, anchor: HTMLElement): void {
    if (this.openId === id) {
      this.close();
      return;
    }
    this.open(id, anchor, false);
  }

  private open(id: string, anchor: HTMLElement, focusFirst: boolean, focusLast = false): void {
    this.close();
    const menu = this.menus.find((m) => m.id === id);
    if (!menu) return;

    const dd = document.createElement("div");
    dd.className = "menu-dropdown";
    dd.setAttribute("role", "menu");
    dd.tabIndex = -1;
    this.focusables = [];

    for (const item of menu.items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "menu-separator";
        dd.append(sep);
        continue;
      }
      const el = document.createElement("div");
      el.className = "menu-item";
      el.setAttribute("role", item.run ? "menuitem" : "menuitem");
      el.tabIndex = -1;
      // 勾选列：所有项都占位，保证同列菜单标签左边缘对齐
      const check = document.createElement("span");
      check.className = "menu-check";
      if (item.checked?.()) {
        check.textContent = "✓";
        el.classList.add("checked");
      }
      el.append(check);
      const label = document.createElement("span");
      label.className = "menu-label";
      label.textContent = item.label ?? "";
      el.append(label);
      if (item.shortcut) {
        const sc = document.createElement("span");
        sc.className = "shortcut";
        sc.textContent = item.shortcut;
        el.append(sc);
      }
      if (item.run) {
        el.setAttribute("aria-disabled", "false");
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close();
          item.run?.();
        });
        this.focusables.push(el);
      } else {
        el.classList.add("disabled");
        el.setAttribute("aria-disabled", "true");
      }
      dd.append(el);
    }

    dd.addEventListener("keydown", (e) => this.onItemKey(e, menu.id));

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
    anchor.setAttribute("aria-expanded", "true");
    dd.addEventListener("click", (e) => e.stopPropagation());

    if (focusFirst) {
      if (focusLast) this.focusables[this.focusables.length - 1]?.focus();
      else this.focusFirstItem();
    }
  }

  private focusFirstItem(): void {
    this.focusables[0]?.focus({ preventScroll: true });
  }

  /** 下拉内的键盘：↑/↓/Home/End 移动，Enter 执行，←/→ 切菜单，Esc 关闭 */
  private onItemKey(e: KeyboardEvent, id: string): void {
    const items = this.focusables;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const moveFocus = (next: number): void => {
      if (items.length === 0) return;
      const wrapped = (next + items.length) % items.length;
      items[wrapped].focus({ preventScroll: true });
    };
    const switchMenu = (delta: number): void => {
      const titles = this.titles();
      const current = titles.findIndex((btn) => btn.dataset.menu === id);
      if (current < 0) return;
      const next = titles[(current + delta + titles.length) % titles.length];
      this.focusTitle(next);
      this.open(next.dataset.menu ?? id, next, true);
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(index + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(index - 1);
        return;
      case "Home":
        e.preventDefault();
        moveFocus(0);
        return;
      case "End":
        e.preventDefault();
        moveFocus(items.length - 1);
        return;
      case "Enter":
      case " ": {
        if (index < 0) return;
        e.preventDefault();
        items[index].click();
        return;
      }
      case "ArrowLeft":
        e.preventDefault();
        switchMenu(-1);
        return;
      case "ArrowRight":
        e.preventDefault();
        switchMenu(1);
        return;
      case "Escape":
        e.preventDefault();
        this.close(true);
        return;
      case "Tab":
        // Tab 不把焦点卡在下拉里：关闭并把焦点交还给标题，继续正常的 Tab 序列
        this.close(false);
        return;
      default:
        return;
    }
  }

  /** 关闭下拉；restoreFocus = 把焦点还给当前菜单标题（键盘路径） */
  private close(restoreFocus = false): void {
    const openMenuId = this.openId;
    this.dropdown?.remove();
    this.dropdown = null;
    this.openId = null;
    this.focusables = [];
    this.container.querySelectorAll(".menu-title.open").forEach((el) => {
      el.classList.remove("open");
      el.setAttribute("aria-expanded", "false");
    });
    if (restoreFocus && openMenuId) {
      const anchor = this.titles().find((btn) => btn.dataset.menu === openMenuId);
      this.focusTitle(anchor);
    }
  }
}
