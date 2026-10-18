/**
 * 弹出菜单定位：夹紧到视口内。
 * 菜单向下 / 向右展开超出窗口时自动向上 / 向左翻转，避免贴边被裁剪。
 * 需在菜单 append 到 document 之后调用（否则读不到尺寸）。
 */
export function placeMenu(menu: HTMLElement, x: number, y: number): void {
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
}
