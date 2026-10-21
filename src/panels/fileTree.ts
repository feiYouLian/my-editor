import { invoke } from "@tauri-apps/api/core";
import { promptText } from "../ui/dialogs";
import { placeMenu } from "../ui/menu";
import type { WorkspaceState } from "../services/workspace";

/**
 * 文件树：
 * 目录懒加载展开、单击打开文件、右键菜单（新建/重命名/删除/定位/刷新）。
 * 展开状态经 workspace 服务防抖持久化。
 */

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** 文件图标：内联 SVG（按类别着色），文件树与面包屑下拉共用 */
const SVG_NS = "http://www.w3.org/2000/svg";

const EXT_CATEGORY: Record<string, "code" | "config" | "image" | "archive"> = {
  js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code", jsx: "code",
  c: "code", cpp: "code", h: "code", hpp: "code", cs: "code", rs: "code",
  go: "code", py: "code", java: "code", kt: "code", swift: "code", rb: "code",
  php: "code", sh: "code", bash: "code", ps1: "code", sql: "code",
  html: "code", htm: "code", xml: "code", css: "code", less: "code", scss: "code", vue: "code",
  json: "config", jsonc: "config", yaml: "config", yml: "config", toml: "config",
  ini: "config", conf: "config", env: "config", properties: "config",
  png: "image", jpg: "image", jpeg: "image", gif: "image", ico: "image", webp: "image", svg: "image", bmp: "image",
  zip: "archive", tar: "archive", gz: "archive", rar: "archive", "7z": "archive", pdf: "archive",
};

function iconCategory(name: string): "file" | "code" | "config" | "image" | "archive" {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "file";
  return EXT_CATEGORY[name.slice(dot + 1).toLowerCase()] ?? "file";
}

/**
 * 生成条目图标：目录（闭合 / 展开）与文件（普通 / 代码 / 配置 / 图片 / 压缩包）。
 * 线条图标统一 16 网格，颜色由 CSS 类别类决定。
 */
export function createEntryIcon(name: string, isDir: boolean, expanded = false): SVGSVGElement {
  const category = isDir ? (expanded ? "folder-open" : "folder") : iconCategory(name);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.2");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("tree-svg", `cat-${category}`);

  const add = (d: string): void => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  };

  if (category === "folder") {
    add("M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.5h5.95a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z");
  } else if (category === "folder-open") {
    add("M2.75 3.25h3.1l1.4 1.5h5.95a1 1 0 0 1 1 1v1.1");
    add("M1.9 12.4l1.25-4.9a1 1 0 0 1 .97-.75h10.05a.75.75 0 0 1 .73.93l-1.15 4.4a1 1 0 0 1-.97.75H2.62a.75.75 0 0 1-.72-.93z");
  } else if (category === "image") {
    add("M2.75 3.25h10.5v9.5H2.75z");
    add("M2.9 10.9l3-3.15 2.2 2.3 1.7-1.75 3.15 3.1");
    add("M5.85 5.4a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9z");
  } else {
    add("M3.9 1.75h5l3.2 3.2v9.3H3.9z");
    add("M8.85 1.95v3.05h3.1");
  }
  return svg;
}

export interface FileTreeCallbacks {
  onOpenFile: (path: string) => void;
  /** 右键文件时「与当前文件比较」 */
  onCompareFile?: (path: string) => void;
  /** 状态栏瞬时消息（复制文件路径成功提示等） */
  onNotify?: (message: string) => void;
  onWorkspaceStateChange: (state: WorkspaceState) => void;
}

export class FileTree {
  private root: string | null = null;
  private expanded = new Set<string>();
  private nodes = new Map<string, HTMLElement>();

  constructor(
    private container: HTMLElement,
    private callbacks: FileTreeCallbacks,
  ) {
    // 初始即渲染：未打开工作区时显示空状态（打开目录入口）
    this.render();
  }

  /** 设置工作区根目录并全量重渲染 */
  setRoot(root: string | null, expanded: string[] = []): void {
    this.root = root;
    this.expanded = new Set(expanded);
    this.render();
    // 根目录变化也要通知宿主（侧栏标题、workspaceRoot 与持久化都依赖该回调）
    this.persist();
  }

  getRoot(): string | null {
    return this.root;
  }

  private render(): void {
    this.container.innerHTML = "";
    this.nodes.clear();
    if (!this.root) {
      const hint = document.createElement("div");
      hint.className = "tree-empty";
      hint.textContent = "未打开工作区——点击上方文件夹按钮或命令面板「打开目录」开始";
      this.container.append(hint);
      return;
    }

    // 根目录名已由侧栏标题展示，树内不再重复一行，直接从子项开始
    const children = document.createElement("div");
    children.className = "tree-children";
    this.container.append(children);
    void this.loadChildren(this.root, children, 0);
  }

  private async loadChildren(dir: string, container: HTMLElement, depth: number): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await invoke<DirEntry[]>("list_dir", { path: dir });
    } catch (e) {
      container.innerHTML = `<div class="tree-error">读取失败: ${String(e)}</div>`;
      return;
    }
    for (const entry of entries) {
      container.append(this.createNode(entry, depth));
    }
  }

  private createNode(entry: DirEntry, depth: number): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node";
    wrapper.dataset.path = entry.path;

    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${depth * 14 + 6}px`;

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.append(createEntryIcon(entry.name, entry.is_dir, this.expanded.has(entry.path)));
    row.append(icon);

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = entry.name;
    label.title = entry.path;
    row.append(label);
    wrapper.append(row);

    row.addEventListener("click", () => {
      if (entry.is_dir) {
        this.toggleExpand(entry.path);
      } else {
        this.selectRow(entry.path);
        this.callbacks.onOpenFile(entry.path);
      }
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showContextMenu(e.clientX, e.clientY, entry);
    });

    if (entry.is_dir) {
      const children = document.createElement("div");
      children.className = "tree-children";
      wrapper.append(children);
      this.nodes.set(entry.path, children);
      if (this.expanded.has(entry.path)) {
        void this.loadChildren(entry.path, children, depth + 1);
      }
    }
    return wrapper;
  }

  private toggleExpand(dir: string): void {
    if (this.expanded.has(dir)) {
      this.expanded.delete(dir);
      this.nodes.get(dir)?.replaceChildren();
    } else {
      this.expanded.add(dir);
      const container = this.nodes.get(dir);
      if (container) void this.loadChildren(dir, container, this.depthOf(dir));
    }
    this.refreshIcons();
    this.persist();
  }

  private depthOf(dir: string): number {
    if (!this.root || dir === this.root) return 0;
    const rel = dir.slice(this.root.length + 1);
    return rel.split(/[\\/]/).length;
  }

  /** 文件夹图标开合状态刷新（轻量：只更新可见目录） */
  private refreshIcons(): void {
    this.container.querySelectorAll<HTMLElement>(".tree-node[data-path]").forEach((node) => {
      const path = node.dataset.path;
      if (!path || !this.nodes.has(path)) return;
      const icon = node.querySelector<HTMLElement>(":scope > .tree-row > .tree-icon");
      if (icon) icon.replaceChildren(createEntryIcon("", true, this.expanded.has(path)));
    });
  }

  /** 高亮并滚动到指定文件行（与标签页联动） */
  selectRow(path: string): void {
    this.container
      .querySelectorAll(".tree-row.selected")
      .forEach((el) => el.classList.remove("selected"));
    const node = this.container.querySelector<HTMLElement>(
      `.tree-node[data-path="${CSS.escape(path)}"]`,
    );
    const row = node?.querySelector<HTMLElement>(":scope > .tree-row");
    if (row) {
      row.classList.add("selected");
      row.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * 展开到指定文件的所有祖先目录并高亮（标签页切换联动）。
   * 子目录懒加载，渲染后用轮询等待行出现（最多 ~1s）。
   */
  revealPath(path: string): void {
    if (!this.root || !path.startsWith(this.root)) return;
    const sep = path.includes("\\") ? "\\" : "/";
    const parts = path.slice(this.root.length + 1).split(/[\\/]/);
    let changed = false;
    let cur = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = `${cur}${sep}${parts[i]}`;
      if (!this.expanded.has(cur)) {
        this.expanded.add(cur);
        changed = true;
      }
    }
    if (changed) this.render();
    let tries = 0;
    const trySelect = (): void => {
      const node = this.container.querySelector<HTMLElement>(
        `.tree-node[data-path="${CSS.escape(path)}"]`,
      );
      if (node) {
        this.selectRow(path);
      } else if (tries++ < 20) {
        setTimeout(trySelect, 50);
      }
    };
    trySelect();
  }

  private persist(): void {
    this.callbacks.onWorkspaceStateChange({
      root: this.root,
      expanded: [...this.expanded],
    });
  }

  // ---- 右键菜单 ----

  private menu: HTMLElement | null = null;

  private showContextMenu(x: number, y: number, entry: DirEntry): void {
    this.closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";

    const items: { label: string; action: () => void }[] = [];
    if (entry.is_dir) {
      items.push({ label: "新建文件", action: () => void this.createIn(entry.path, false) });
      items.push({ label: "新建文件夹", action: () => void this.createIn(entry.path, true) });
    } else {
      const dir = entry.path.split(/[\\/]/).slice(0, -1).join("\\");
      items.push({ label: "新建文件", action: () => void this.createIn(dir, false) });
      items.push({ label: "新建文件夹", action: () => void this.createIn(dir, true) });
    }
    const compare = this.callbacks.onCompareFile;
    if (!entry.is_dir && compare) {
      items.push({ label: "与当前文件比较", action: () => compare(entry.path) });
    }
    items.push({ label: "复制文件路径", action: () => void this.copyPath(entry.path) });
    items.push({ label: "重命名", action: () => void this.renameEntry(entry) });
    items.push({ label: "删除", action: () => void this.deleteEntry(entry) });
    items.push({
      label: "在文件管理器中显示",
      action: () => void invoke("reveal_in_file_manager", { path: entry.path }),
    });
    items.push({ label: "刷新", action: () => this.render() });

    for (const item of items) {
      const el = document.createElement("div");
      el.className = "context-menu-item";
      el.textContent = item.label;
      el.addEventListener("click", () => {
        this.closeContextMenu();
        item.action();
      });
      menu.append(el);
    }
    document.body.append(menu);
    placeMenu(menu, x, y);
    this.menu = menu;
  }

  private closeContextMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  /** 复制文件/目录的完整路径到剪贴板 */
  private async copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      this.callbacks.onNotify?.("已复制文件路径");
    } catch (e) {
      window.alert(`复制地址失败: ${e}`);
    }
  }

  /** 全局监听挂载点：应用启动时调用一次 */
  mountGlobalListeners(): void {
    document.addEventListener("click", () => this.closeContextMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeContextMenu();
    });
  }

  private parentOf(path: string): string {
    const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return idx > 0 ? path.slice(0, idx) : path;
  }

  private async createIn(dir: string, isDir: boolean): Promise<void> {
    const name = await promptText(isDir ? "新文件夹名称:" : "新文件名称:");
    if (!name) return;
    const sep = dir.includes("\\") ? "\\" : "/";
    const target = `${dir}${sep}${name}`;
    try {
      await invoke("create_entry", { path: target, isDir });
      this.expanded.add(dir);
      this.render();
    } catch (e) {
      window.alert(`创建失败: ${e}`);
    }
  }

  private async renameEntry(entry: DirEntry): Promise<void> {
    const name = await promptText("新名称:", entry.name);
    if (!name || name === entry.name) return;
    const target = `${this.parentOf(entry.path)}${entry.path.includes("\\") ? "\\" : "/"}${name}`;
    try {
      await invoke("rename_path", { from: entry.path, to: target });
      this.render();
    } catch (e) {
      window.alert(`重命名失败: ${e}`);
    }
  }

  private async deleteEntry(entry: DirEntry): Promise<void> {
    const ok = window.confirm(
      `确定删除${entry.is_dir ? "目录" : "文件"}「${entry.name}」？${entry.is_dir ? "目录将递归删除！" : ""}`,
    );
    if (!ok) return;
    try {
      await invoke("delete_path", { path: entry.path });
      this.render();
    } catch (e) {
      window.alert(`删除失败: ${e}`);
    }
  }
}
