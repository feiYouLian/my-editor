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
  /** 过滤框用：与快速打开同一份忽略目录，保证两处搜出来的文件一致 */
  getIgnoreDirs?: () => string[];
  /** 空状态里的「打开目录」按钮（与首屏欢迎页一致，不再只是文字提示） */
  onOpenFolder?: () => void;
}

/** 过滤结果最多渲染多少条（超出提示细化关键词） */
const FILTER_MAX_ROWS = 200;
/** 过滤输入防抖：与快速打开同量级，避免每个按键都发 IPC */
const FILTER_DEBOUNCE_MS = 180;

interface FlatFile {
  path: string;
  relative: string;
  name: string;
}

export class FileTree {
  private root: string | null = null;
  private expanded = new Set<string>();
  private nodes = new Map<string, HTMLElement>();
  /** Git 状态：文件路径（规范化）→ 状态字母 */
  private gitFileStatus = new Map<string, string>();
  /** Git 状态：目录路径（规范化）→ 由子项推导的状态 */
  private gitDirStatus = new Map<string, string>();

  /** 过滤框与树体：容器内只构建一次，render() 只重绘树体（否则输入框会被清掉） */
  private filterEl!: HTMLInputElement;
  private bodyEl!: HTMLElement;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  /** 过滤请求代际：连续输入时丢弃过期结果 */
  private filterSeq = 0;
  /** 是否处于"过滤结果"视图（此时 render 不覆盖结果） */
  private filtering = false;
  /** 根层子项容器（nodes 只记目录项，根目录要单独记，否则增量刷新根层会退回全量） */
  private rootChildren: HTMLElement | null = null;
  /** 进行中的目录加载：revealPath 等它就绪，不再靠轮询猜时间 */
  private pendingLoads = new Map<string, Promise<void>>();

  constructor(
    private container: HTMLElement,
    private callbacks: FileTreeCallbacks,
  ) {
    this.buildShell();
    // 初始即渲染：未打开工作区时显示空状态（打开目录入口）
    this.render();
  }

  private buildShell(): void {
    this.container.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "tree-filter";
    this.filterEl = document.createElement("input");
    this.filterEl.type = "search";
    this.filterEl.className = "tree-filter-input";
    this.filterEl.placeholder = "过滤文件名…";
    this.filterEl.setAttribute("aria-label", "过滤文件名");
    bar.append(this.filterEl);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "tree-body";
    this.container.append(bar, this.bodyEl);

    this.filterEl.addEventListener("input", () => {
      if (this.filterTimer) clearTimeout(this.filterTimer);
      const query = this.filterEl.value.trim();
      if (query === "") {
        this.exitFilter();
        return;
      }
      this.filterTimer = setTimeout(() => {
        this.filterTimer = null;
        void this.runFilter(query);
      }, FILTER_DEBOUNCE_MS);
    });
    this.filterEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.filterEl.value = "";
        this.exitFilter();
      }
    });
  }

  /** 退出过滤视图，恢复树（展开状态不变） */
  private exitFilter(): void {
    if (!this.filtering) return;
    this.filtering = false;
    this.render();
  }

  /**
   * 过滤：切到"扁平匹配列表"。
   * 不能只过滤已渲染的树 —— 树是懒加载的，未展开目录根本不在 DOM 里，
   * 那样会出现"明明有这个文件却搜不到"。复用快速打开的 list_workspace_files。
   */
  private async runFilter(query: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    const seq = ++this.filterSeq;
    this.filtering = true;
    this.bodyEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "tree-empty";
    loading.textContent = "搜索中…";
    this.bodyEl.append(loading);

    let files: FlatFile[] = [];
    try {
      files = await invoke<FlatFile[]>("list_workspace_files", {
        root,
        ignoreDirs: this.callbacks.getIgnoreDirs?.() ?? [],
        limit: 5000,
      });
    } catch (e) {
      if (seq !== this.filterSeq) return;
      this.bodyEl.innerHTML = "";
      const err = document.createElement("div");
      err.className = "tree-empty";
      err.textContent = `搜索失败：${String(e).split("\n")[0]}`;
      this.bodyEl.append(err);
      return;
    }
    if (seq !== this.filterSeq) return; // 过期结果丢弃

    const needle = query.toLowerCase();
    const matched = files.filter((f) => f.relative.toLowerCase().includes(needle));
    this.bodyEl.innerHTML = "";
    if (matched.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "没有匹配的文件";
      this.bodyEl.append(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const file of matched.slice(0, FILTER_MAX_ROWS)) frag.append(this.createFlatRow(file));
    this.bodyEl.append(frag);
    if (matched.length > FILTER_MAX_ROWS) {
      const more = document.createElement("div");
      more.className = "tree-empty";
      more.textContent = `仅显示前 ${FILTER_MAX_ROWS} 条（共 ${matched.length} 条），请细化关键词`;
      this.bodyEl.append(more);
    }
  }

  /** 扁平结果行：文件名主色 + 目录淡色（与源代码管理行同一套视觉约定） */
  private createFlatRow(file: FlatFile): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row tree-flat-row";
    row.title = file.path;

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.append(createEntryIcon(file.name, false));
    row.append(icon);

    const name = document.createElement("span");
    name.className = "tree-flat-name";
    name.textContent = file.name;
    row.append(name);

    const idx = file.relative.lastIndexOf("/");
    if (idx > 0) {
      const dir = document.createElement("span");
      dir.className = "tree-flat-dir";
      dir.textContent = file.relative.slice(0, idx);
      row.append(dir);
    }

    bindOpenGesture(row, { onOpen: () => this.callbacks.onOpenFile(file.path) });
    return row;
  }

  /** 设置工作区根目录并全量重渲染 */
  setRoot(root: string | null, expanded: string[] = []): void {
    this.root = root;
    this.expanded = new Set(expanded);
    // 换工作区时退出过滤视图，否则会看到上一个工作区的结果
    this.filtering = false;
    this.filterSeq++;
    if (this.filterEl) this.filterEl.value = "";
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
    // 过滤结果视图由 runFilter 负责，整体重绘会把结果冲掉
    if (this.filtering) return;
    this.bodyEl.innerHTML = "";
    this.nodes.clear();
    if (!this.root) {
      const hint = document.createElement("div");
      hint.className = "tree-empty";
      hint.textContent = "未打开工作区。";
      if (this.callbacks.onOpenFolder) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "打开目录";
        btn.addEventListener("click", () => this.callbacks.onOpenFolder?.());
        hint.append(btn);
      } else {
        hint.textContent = "未打开工作区——点击上方文件夹按钮或命令面板「打开目录」开始";
      }
      this.bodyEl.append(hint);
      return;
    }

    // 根目录名已由侧栏标题展示，树内不再重复一行，直接从子项开始
    const children = document.createElement("div");
    children.className = "tree-children";
    this.rootChildren = children;
    this.bodyEl.append(children);
    void this.loadChildren(this.root, children, 0);
  }

  /**
   * 只重建某一层的子项（新建 / 删除 / 重命名后用）。
   * 比全树 render() 便宜得多：不重发其它已展开目录的 list_dir，也不丢滚动位置。
   */
  private refreshDir(dir: string): void {
    const container = dir === this.root ? this.rootChildren : this.nodes.get(dir);
    if (!container || !container.isConnected) {
      // 目录未展开 / 容器已被替换：退回全量（此时树本来就很浅）
      this.render();
      return;
    }
    container.replaceChildren();
    void this.loadChildren(dir, container, this.depthOf(dir));
  }

  /**
   * 目录加载代际：按目录维度记令牌（不能用实例级单一计数）。
   * render() 会对每个已展开目录并发调用本方法，若共用同一个计数器，
   * 后发起的调用会让先发起的全部作废——表现为“展开多个目录时只有最后一个有内容”。
   */
  private loadTokens = new Map<string, number>();

  /** 外层包装：登记"这一层正在加载"，供 revealPath 等待（替代轮询） */
  private async loadChildren(dir: string, container: HTMLElement, depth: number): Promise<void> {
    const task = this.loadChildrenInner(dir, container, depth);
    this.pendingLoads.set(dir, task);
    try {
      await task;
    } finally {
      if (this.pendingLoads.get(dir) === task) this.pendingLoads.delete(dir);
    }
  }

  private async loadChildrenInner(
    dir: string,
    container: HTMLElement,
    depth: number,
  ): Promise<void> {
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
    // 等父目录这一层加载完再选中：原来的 20×50ms 轮询会在慢盘上直接放弃，
    // 也会在快速连续切换标签时留下多个计时器
    const parent = this.parentOf(path);
    const pending = this.pendingLoads.get(parent);
    if (pending) {
      void pending.then(() => this.selectRow(path));
      return;
    }
    this.selectRow(path);
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
      const wasExpanded = this.expanded.has(dir);
      this.expanded.add(dir);
      // 已展开：只重建这一层；原本折叠（含新建目录后要露出来）才退回全量
      if (wasExpanded && !isDir) this.refreshDir(dir);
      else this.render();
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
      // 只重建父目录这一层，再等它加载完选中新名称（原来走 revealPath 会全树重建）
      const parent = this.parentOf(target);
      this.refreshDir(parent);
      const pending = this.pendingLoads.get(parent);
      if (pending) void pending.then(() => this.selectRow(target));
      else this.selectRow(target);
    } catch (e) {
      this.callbacks.onNotify?.(`重命名失败: ${String(e).split("\n")[0]}`);
    }
  }

  private async deleteEntry(entry: DirEntry): Promise<void> {
    const ok = await confirmAction(
      `确定删除${entry.is_dir ? "目录" : "文件"}「${entry.name}」？\n` +
        (entry.is_dir
          ? "目录下的全部内容会一起移入系统回收站，可从回收站还原。"
          : "将移入系统回收站，可从回收站还原。"),
    );
    if (!ok) return;
    try {
      await invoke("delete_path", { path: entry.path });
      // 只重建父目录这一层：全树 render() 会让所有已展开目录重发 list_dir 并闪烁
      this.refreshDir(this.parentOf(entry.path));
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
