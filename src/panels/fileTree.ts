import { invoke } from "@tauri-apps/api/core";
import { confirmAction, promptText } from "../ui/dialogs";
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

/** 文件图标工厂已下沉 ui/icons.ts（面包屑下拉共用） */
import { createEntryIcon } from "../ui/icons";
import { bindOpenGesture } from "../ui/openGesture";

export interface FileTreeCallbacks {
  onOpenFile: (path: string) => void;
  /** 右键文件时「与当前文件比较」 */
  onCompareFile?: (path: string) => void;
  /** 右键「在终端中打开」（目录用自身，文件用父目录） */
  onOpenTerminal?: (dir: string) => void;
  /** 状态栏瞬时消息（复制文件路径成功提示等） */
  onNotify?: (message: string) => void;
  onWorkspaceStateChange: (state: WorkspaceState) => void;
}

export class FileTree {
  private root: string | null = null;
  private expanded = new Set<string>();
  private nodes = new Map<string, HTMLElement>();
  /** Git 状态：文件路径（规范化）→ 状态字母 */
  private gitFileStatus = new Map<string, string>();
  /** Git 状态：目录路径（规范化）→ 由子项推导的状态 */
  private gitDirStatus = new Map<string, string>();

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

  /** 外部写盘（如批量替换生成 .bak）后重建当前树（保留展开状态） */
  refresh(): void {
    this.render();
  }

  /**
   * 同步 Git 状态染色：文件按自身状态、目录按子项中最“重”的状态。
   * 不重建树，只更新已渲染行的属性（懒加载新节点在 createNode 时自带状态）。
   */
  setGitStatus(files: Map<string, string>): void {
    this.gitFileStatus = new Map();
    for (const [path, status] of files) this.gitFileStatus.set(normPath(path), status);

    // 目录状态：从每个文件向上推，取优先级最高的子项状态
    this.gitDirStatus = new Map();
    for (const [path, status] of this.gitFileStatus) {
      let dir = this.parentOf(path);
      let guard = 0;
      while (dir && guard++ < 64) {
        const key = normPath(dir);
        this.gitDirStatus.set(key, pickStatus(this.gitDirStatus.get(key), status));
        const next = this.parentOf(dir);
        if (next === dir) break;
        dir = next;
      }
    }
    this.refreshGitMarks();
  }

  private statusFor(path: string, isDir: boolean): string | undefined {
    const key = normPath(path);
    return isDir ? this.gitDirStatus.get(key) : this.gitFileStatus.get(key);
  }

  /** 已渲染行同步状态属性（setGitStatus 后调用；数量 = 当前已展开节点） */
  private refreshGitMarks(): void {
    this.container.querySelectorAll<HTMLElement>(".tree-node[data-path]").forEach((node) => {
      const path = node.dataset.path;
      if (!path) return;
      const row = node.querySelector<HTMLElement>(":scope > .tree-row");
      if (!row) return;
      const status = this.statusFor(path, this.nodes.has(path));
      if (status) row.dataset.gitStatus = status;
      else delete row.dataset.gitStatus;
    });
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

  /**
   * 目录加载代际：按目录维度记令牌（不能用实例级单一计数）。
   * render() 会对每个已展开目录并发调用本方法，若共用同一个计数器，
   * 后发起的调用会让先发起的全部作废——表现为“展开多个目录时只有最后一个有内容”。
   */
  private loadTokens = new Map<string, number>();

  private async loadChildren(dir: string, container: HTMLElement, depth: number): Promise<void> {
    const token = (this.loadTokens.get(dir) ?? 0) + 1;
    this.loadTokens.set(dir, token);
    let entries: DirEntry[];
    try {
      entries = await invoke<DirEntry[]>("list_dir", { path: dir });
    } catch (e) {
      // 过期加载（期间已折叠/刷新）不显示错误；textContent 防 HTML 注入
      if (this.loadTokens.get(dir) !== token || !container.isConnected) return;
      const err = document.createElement("div");
      err.className = "tree-error";
      err.textContent = `读取失败: ${String(e).split("\n")[0]}`;
      container.append(err);
      return;
    }
    // 过期结果直接丢弃：否则会与后一次加载的节点叠加成重复行
    if (this.loadTokens.get(dir) !== token || !container.isConnected) return;
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
    // Git 状态：文件取自身，目录取子项推导值
    const gitStatus = this.statusFor(entry.path, entry.is_dir);
    if (gitStatus) row.dataset.gitStatus = gitStatus;

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

    if (entry.is_dir) {
      // 目录保持单击展开：双击设置只影响「打开文件」
      row.addEventListener("click", () => this.toggleExpand(entry.path));
    } else {
      // 单击 / 双击打开由设置决定（config.files.openWithDoubleClick）
      bindOpenGesture(row, {
        onSelect: () => this.selectRow(entry.path),
        onOpen: () => {
          this.selectRow(entry.path);
          this.callbacks.onOpenFile(entry.path);
        },
      });
    }

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
    const openTerminal = this.callbacks.onOpenTerminal;
    if (openTerminal) {
      const dir = entry.is_dir ? entry.path : this.parentOf(entry.path);
      items.push({ label: "在终端中打开", action: () => openTerminal(dir) });
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
      this.callbacks.onNotify?.(`复制地址失败: ${String(e).split("\n")[0]}`);
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
      // 新建文件后直接打开：省掉“建完还要在树里找一次”的多余操作
      if (!isDir) this.callbacks.onOpenFile(target);
    } catch (e) {
      this.callbacks.onNotify?.(`创建失败: ${String(e).split("\n")[0]}`);
    }
  }

  private async renameEntry(entry: DirEntry): Promise<void> {
    const name = await promptText("新名称:", entry.name);
    if (!name || name === entry.name) return;
    const target = `${this.parentOf(entry.path)}${entry.path.includes("\\") ? "\\" : "/"}${name}`;
    try {
      await invoke("rename_path", { from: entry.path, to: target });
      // 重命名后展开祖先目录并选中新名称，避免用户自己再找一遍
      this.revealPath(target);
    } catch (e) {
      this.callbacks.onNotify?.(`重命名失败: ${String(e).split("\n")[0]}`);
    }
  }

  private async deleteEntry(entry: DirEntry): Promise<void> {
    const ok = await confirmAction(
      `确定删除${entry.is_dir ? "目录" : "文件"}「${entry.name}」？${entry.is_dir ? "目录将递归删除！" : ""}`,
    );
    if (!ok) return;
    try {
      await invoke("delete_path", { path: entry.path });
      this.render();
    } catch (e) {
      this.callbacks.onNotify?.(`删除失败: ${String(e).split("\n")[0]}`);
    }
  }
}

/** Git 状态路径归一化：分隔符与大小写不敏感 */
function normPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** 目录状态优先级：冲突 > 删除 > 修改 > 重命名 > 新增 > 未跟踪 */
const GIT_STATUS_WEIGHT: Record<string, number> = {
  U: 6,
  D: 5,
  M: 4,
  R: 3,
  C: 2,
  A: 1,
  "?": 0,
};

function pickStatus(prev: string | undefined, next: string): string {
  if (!prev) return next;
  return (GIT_STATUS_WEIGHT[prev] ?? 0) >= (GIT_STATUS_WEIGHT[next] ?? 0) ? prev : next;
}
