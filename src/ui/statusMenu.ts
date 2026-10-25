/**
 * 状态栏弹出菜单工厂：统一「弹出列表 → 选择 → apply」交互。
 *
 * 原三个近似实现（换行符 / 语言 / 编码）是复制粘贴出来的：各自持有
 * activeTab() 快照、各自的 document 关闭监听、各自不同强度的有效性
 * 校验。本工厂统一收三件事：
 * 1. 过期快照保护：菜单挂起期间标签可能被关闭/切换，apply 前校验
 *    tabStore.active()?.id === 打开时的 tabId，否则取消并提示；
 * 2. 监听生命周期：每次打开注册、每次关闭注销，不再向 document 堆积；
 * 3. 交互一致性：顶部说明行、当前项 ✓、Esc / 点击外部关闭。
 *
 * 领域校验（如「大文件视图不支持切语言」）留在调用方，本工厂只做通用部分。
 */

import { tabStore } from "../store/tabs";
import { placeMenu } from "./menu";

export interface StatusMenuOption<T> {
  value: T;
  label: string;
  /** 该项前插入分隔线（用于分组） */
  separatorBefore?: boolean;
}

/** 额外动作项：不参与「当前值 ✓」逻辑，点击后直接执行 */
export interface StatusMenuAction {
  label: string;
  run: () => void;
  /** 动作前插入分隔线 */
  separatorBefore?: boolean;
}

export interface StatusMenuConfig<T> {
  anchor: { x: number; y: number };
  /** 顶部说明行（展示当前值） */
  header: string;
  options: StatusMenuOption<T>[];
  /** 额外动作（如编码菜单的「另存为编码…」），排在选项之后 */
  actions?: StatusMenuAction[];
  /** 当前值（命中项加 ✓） */
  current: T;
  /** 打开时的标签 id（apply 前校验其仍是激活标签） */
  tabId: string;
  /** 选中回调（已通过 tabId 校验） */
  onPick: (value: T) => void;
  /** 提示通道 */
  onMessage: (text: string) => void;
}

/** 当前打开的菜单（弹出式菜单全局唯一，工厂自持句柄） */
let current: { cleanup: () => void } | null = null;

/** 关闭当前菜单（无则无操作） */
export function closeStatusMenu(): void {
  current?.cleanup();
  current = null;
}

export function openStatusMenu<T>(config: StatusMenuConfig<T>): void {
  closeStatusMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  const header = document.createElement("div");
  header.className = "context-menu-item";
  header.style.opacity = "0.6";
  header.style.cursor = "default";
  header.textContent = config.header;
  menu.append(header);

  const appendSeparator = (): void => {
    const sep = document.createElement("div");
    sep.className = "context-menu-separator";
    menu.append(sep);
  };

  for (const option of config.options) {
    if (option.separatorBefore) appendSeparator();
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.textContent = option.value === config.current ? `${option.label} ✓` : option.label;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      closeStatusMenu();
      // 过期快照保护：对话框/异步操作挂起期间标签可能已关闭或切换
      if (tabStore.active()?.id !== config.tabId) {
        config.onMessage("标签已切换，操作已取消");
        return;
      }
      config.onPick(option.value);
    });
    menu.append(el);
  }

  for (const action of config.actions ?? []) {
    if (action.separatorBefore) appendSeparator();
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.textContent = action.label;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      closeStatusMenu();
      if (tabStore.active()?.id !== config.tabId) {
        config.onMessage("标签已切换，操作已取消");
        return;
      }
      action.run();
    });
    menu.append(el);
  }

  document.body.append(menu);
  placeMenu(menu, config.anchor.x, config.anchor.y);

  const onDocClick = () => closeStatusMenu();
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeStatusMenu();
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
  current = {
    cleanup: () => {
      menu.remove();
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeydown);
    },
  };
}
