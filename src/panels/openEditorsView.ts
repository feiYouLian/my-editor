/**
 * 「正在打开的文件」侧栏分区：列出当前标签（名称 / 脏标记 / 关闭），
 * 点击激活，与 VS Code 的 OPEN EDITORS 对齐。
 *
 * 右键菜单按标签语义对齐文件树：比较 / 复制路径 / 资源管理器 / 关闭系列；
 * 磁盘重命名与删除仍留在文件树（避免与标签同步产生歧义）。
 * 数据直接读 store/tabs；跨模块动作经 deps 交回 main.ts。
 */

import { tabStore, type Tab } from "../store/tabs";
import { createEntryIcon } from "../ui/icons";
import { placeMenu } from "../ui/menu";
import { bindOpenGesture, selectRowIn } from "../ui/openGesture";

export interface OpenEditorsDeps {
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** 关闭其他（保留该标签；含草稿兜底） */
  onCloseOthers: (tabId: string) => void;
  /** 关闭全部（含草稿兜底） */
  onCloseAll: () => void;
  /** 与当前激活标签比较 */
  onCompare: (tabId: string) => void;
  onCopyPath: (path: string) => void;
  onReveal: (path: string) => void;
}

interface MenuItem {
  label?: string;
  separator?: boolean;
  action?: () => void;
}

export class OpenEditorsView {
  private readonly listEl: HTMLElement;
  private menu: HTMLElement | null = null;

  constructor(host: HTMLElement, private deps: OpenEditorsDeps) {
    host.innerHTML = "";
    this.listEl = document.createElement("div");
    this.listEl.className = "open-editors";
    host.append(this.listEl);

    document.addEventListener("click", () => this.closeMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
  }

  /** 标签集合 / 激活项 / 脏标记变化时重绘（数量小，直接重建） */
  refresh(): void {
    const tabs = tabStore.list();
    const activeId = tabStore.active()?.id;
    this.listEl.innerHTML = "";

    if (tabs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sv-empty";
      empty.textContent = "没有打开的文件";
      this.listEl.append(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const tab of tabs) {
      const row = document.createElement("div");
      row.className = `open-editor${tab.id === activeId ? " active" : ""}`;
      row.title = tab.path ?? tab.name;

      const icon = document.createElement("span");
      icon.className = "open-editor-icon";
      icon.append(createEntryIcon(tab.name, false, false));

      const name = document.createElement("span");
      name.className = "open-editor-name";
      name.textContent = tab.name;

      row.append(icon, name);

      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "open-editor-dirty";
        dot.textContent = "●";
        dot.title = "未保存";
        row.append(dot);
      }

      const close = document.createElement("button");
      close.type = "button";
      close.className = "open-editor-close";
      close.textContent = "×";
      close.title = "关闭";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deps.onClose(tab.id);
      });
      row.append(close);

      bindOpenGesture(row, {
        onSelect: () => selectRowIn(row),
        onOpen: () => this.deps.onActivate(tab.id),
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showContextMenu(e.clientX, e.clientY, tab);
      });
      frag.append(row);
    }
    this.listEl.append(frag);
  }

  // ---- 右键菜单（与文件树同款 context-menu 外观） ----

  private showContextMenu(x: number, y: number, tab: Tab): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";

    const items: MenuItem[] = [];
    const active = tabStore.active()?.id === tab.id;
    if (tab.path) {
      if (!active) {
        items.push({ label: "与当前文件比较", action: () => this.deps.onCompare(tab.id) });
      }
      items.push({ label: "复制文件路径", action: () => this.deps.onCopyPath(tab.path as string) });
      items.push({
        label: "在文件管理器中显示",
        action: () => this.deps.onReveal(tab.path as string),
      });
      items.push({ separator: true });
    }
    items.push({ label: "关闭", action: () => this.deps.onClose(tab.id) });
    if (tabStore.list().length > 1) {
      items.push({ label: "关闭其他", action: () => this.deps.onCloseOthers(tab.id) });
      items.push({ label: "关闭全部", action: () => this.deps.onCloseAll() });
    }

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        menu.append(sep);
        continue;
      }
      const el = document.createElement("div");
      el.className = "context-menu-item";
      el.textContent = item.label ?? "";
      el.addEventListener("click", () => {
        this.closeMenu();
        item.action?.();
      });
      menu.append(el);
    }

    document.body.append(menu);
    placeMenu(menu, x, y);
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}
