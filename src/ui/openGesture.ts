/**
 * 侧栏列表行的「打开」手势：按配置决定单击还是双击（默认单击）。
 *
 * 双击模式：首次点击只做选中反馈（onSelect），连续双击才打开；
 * 单击模式：行为与原来一致，dblclick 不再重复触发。
 *
 * 目录行的展开/折叠不经过这里——单击展开是列表通用的直觉操作，
 * 不应受「双击打开」影响。
 *
 * 每次点击现读配置：设置改完立即生效，无需刷新列表。
 */

import { getConfig } from "../config/settings";

/** 当前是否为「双击打开」模式 */
export function isDoubleClickOpen(): boolean {
  return getConfig().files?.openWithDoubleClick === true;
}

export interface OpenGestureOptions {
  /** 真正打开（打开文件 / 跳转 / 切换标签 / 打开 diff） */
  onOpen: () => void;
  /** 双击模式下的首次点击反馈（通常是选中行） */
  onSelect?: () => void;
  /**
   * 固定单击打开，不受 files.openWithDoubleClick 影响。
   * 用于源代码管理行：VS Code 里点一下就看 diff，双击被调用方另行定义（打开文件）。
   */
  forceSingleClick?: boolean;
}

export function bindOpenGesture(el: HTMLElement, opts: OpenGestureOptions): void {
  el.addEventListener("click", () => {
    if (opts.forceSingleClick || !isDoubleClickOpen()) opts.onOpen();
    else opts.onSelect?.();
  });
  // 固定单击模式：双击语义由调用方自己绑定，这里不再插手
  if (opts.forceSingleClick) return;
  el.addEventListener("dblclick", (e) => {
    if (!isDoubleClickOpen()) return;
    // 行内小按钮（暂存 / 撤回 / 关闭）双击有自己的含义，不当作打开
    // 注意排除行本身：大纲的行就是 <button>
    const button = (e.target as HTMLElement | null)?.closest("button");
    if (button && button !== el) return;
    // 双击会顺带选中行内文本（行是 span 拼的），清掉避免视觉噪声
    window.getSelection()?.removeAllRanges();
    opts.onOpen();
  });
}

/**
 * 双击模式的「选中」反馈：同一容器内只保留一行选中态。
 * 容器取行的父节点——各列表的行都是同级兄弟，足够表达"当前指向哪一行"。
 */
export function selectRowIn(el: HTMLElement): void {
  const parent = el.parentElement;
  if (!parent) return;
  parent.querySelectorAll(".row-selected").forEach((node) => node.classList.remove("row-selected"));
  el.classList.add("row-selected");
}
