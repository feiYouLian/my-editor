/**
 * 弹出菜单定位：夹紧到视口内。
 * 菜单向下 / 向右展开超出窗口时自动向上 / 向左翻转，避免贴边被裁剪。
 * 需在菜单 append 到 document 之后调用（否则读不到尺寸）。
 */
export interface PlaceMenuOptions {
  /**
   * 打开后是否把焦点交给菜单并启用方向键（默认 true）。
   * 二级菜单必须传 false：抢焦点会打断父项的 hover 逻辑。
   */
  focus?: boolean;
}

const MENU_ITEM_SELECTOR = ".context-menu-item:not(.disabled)";

export function placeMenu(
  menu: HTMLElement,
  x: number,
  y: number,
  opts: PlaceMenuOptions = {},
): void {
  const margin = 4;
  const { innerWidth: vw, innerHeight: vh } = window;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;

  let left = x;
  if (left + w > vw - margin) left = vw - w - margin;
  if (left < margin) left = margin;

  let top = y;
  if (top + h > vh - margin) {
    // 下方空间不足：优先翻转到点击点上方，否则夹紧到视口内
    const above = y - h;
    top = above >= margin ? above : vh - h - margin;
  }
  if (top < margin) top = margin;

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  if (opts.focus !== false) enableKeyboard(menu);
}

/**
 * 菜单键盘可达：↑↓ 移动、Home/End、Enter/Space 执行。
 * 焦点交给菜单后必须负责归还 —— 菜单被移除时焦点会落到 body，
 * 之后所有依赖编辑器焦点的快捷键都会失效。
 */
function enableKeyboard(menu: HTMLElement): void {
  const items = [
    ...menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  ].filter((el) => el.offsetParent !== null);
  if (items.length === 0) return;

  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;
  for (const item of items) {
    item.tabIndex = -1;
    if (!item.hasAttribute("role")) item.setAttribute("role", "menuitem");
  }

  menu.addEventListener("keydown", (e) => {
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      items[(current + 1 + items.length) % items.length].focus();
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      items[(current - 1 + items.length) % items.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (e.key === "Enter" || e.key === " ") {
      const active = document.activeElement;
      if (active instanceof HTMLElement && items.includes(active)) {
        e.preventDefault();
        active.click();
      }
    }
  });

  // 归还焦点：菜单从 DOM 移除时，若焦点已不在有效元素上就还给打开前的元素
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const observer = new MutationObserver(() => {
    if (menu.isConnected) return;
    observer.disconnect();
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (opener?.isConnected) opener.focus();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  menu.focus();
}
