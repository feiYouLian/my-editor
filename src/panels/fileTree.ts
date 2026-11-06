import { invoke } from "@tauri-apps/api/core";
import { confirmAction, promptText } from "../ui/dialogs";
import { placeMenu } from "../ui/menu";
import type { WorkspaceState } from "../services/workspace";
import { basenameOf, dirnameOf, isSameOrInsidePath, topmostPaths } from "../core/paths";

/**
 * 文件树：
 * 目录懒加载展开、单击打开文件、右键菜单（新建/重命名/删除/定位/刷新）。
 * 展开状态经 workspace 服务防抖持久化。
 *
 * 多选：Ctrl/Cmd 点选、Shift 连选，批量删除/复制/剪切/粘贴。
 * 拖拽移动用 pointer 事件自绘（WebView2 下 HTML5 DnD 与原生「拖文件进窗口」互斥，
 * 关闭原生拖放会让「拖入文件打开」失效，所以这里不走 HTML5 draggable）。
 */

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** 文件图标工厂已下沉 ui/icons.ts（面包屑下拉共用） */
import { createEntryIcon } from "../ui/icons";
import { bindOpenGesture } from "../ui/openGesture";
import { firstLine } from "../core/errors";

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
  /**
   * 文件/目录被移动（重命名 / 剪切粘贴）后同步已打开的标签路径。
   * 不回调的话：标签还指着旧路径，保存会把内容写回已经不存在的位置。
   */
  onPathMoved?: (from: string, to: string) => void;
  /**
   * 文件/目录被删除后同步右侧主区。
   * 不回调的话：干净标签还挂着已删除的文件，一点保存就把文件"复活"了。
   */
  onPathDeleted?: (path: string, isDir: boolean) => void;
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
  /** 路径 → 行元素：选中 / 定位时避免对大树的 querySelector 全扫；失效项按 isConnected 懒清理 */
  private rowByPath = new Map<string, HTMLElement>();
  /** 进行中的目录加载：revealPath 等它就绪，不再靠轮询猜时间 */
  private pendingLoads = new Map<string, Promise<void>>();

  /**
   * 文件剪贴板（应用内，不碰系统剪贴板）。
   * 支持批量：复制会整批写进系统剪贴板，粘贴时按数组处理。
   */
  private clip: { paths: string[]; cut: boolean } | null = null;
  /** 多选：路径 → 是否目录（键盘复制/剪切/粘贴与批量操作的作用对象） */
  private selection = new Map<string, boolean>();
  /** Shift 连选的起点 */
  private anchorPath: string | null = null;
  /** 拖拽/多选后短暂屏蔽 click：否则松手那一下会顺带打开文件或折叠目录 */
  private suppressClickUntil = 0;

  constructor(
    private container: HTMLElement,
    private callbacks: FileTreeCallbacks,
  ) {
    this.buildShell();
    // 无障碍：树容器 + 行上的 treeitem / aria-level / aria-expanded（读屏可感知层级与展开态）
    this.bodyEl.setAttribute("role", "tree");
    this.bodyEl.setAttribute("aria-label", "工作区文件树");
    this.wireSelection();
    this.wireDrag();
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

  // ---- 多选 ----

  /** 当前可见行（树 + 过滤结果），按视觉顺序 */
  private visibleRows(): HTMLElement[] {
    return [...this.container.querySelectorAll<HTMLElement>(".tree-row[data-path]")];
  }

  private rowInfo(row: HTMLElement): { path: string; isDir: boolean } | null {
    const path = row.dataset.path;
    if (!path) return null;
    return { path, isDir: row.dataset.dir === "1" };
  }

  /** 已选条目：先按可见顺序，再补上折叠/过滤后不可见的项（不能静默丢操作） */
  private selectedEntries(): { path: string; isDir: boolean }[] {
    const out: { path: string; isDir: boolean }[] = [];
    const seen = new Set<string>();
    for (const row of this.visibleRows()) {
      const info = this.rowInfo(row);
      if (!info || seen.has(info.path) || !this.selection.has(info.path)) continue;
      seen.add(info.path);
      out.push(info);
    }
    for (const [path, isDir] of this.selection) {
      if (!seen.has(path)) out.push({ path, isDir });
    }
    return out;
  }

  /**
   * 重绘选中态：传入 paths 时只更新这些行（单选 / Ctrl 点选不再扫整棵树），
   * 不传则全量重刷（树重建 / 新目录加载后补状态用）。
   */
  private paintSelection(paths?: Iterable<string>): void {
    if (paths) {
      for (const path of new Set(paths)) {
        this.rowOf(path)?.classList.toggle("selected", this.selection.has(path));
      }
      return;
    }
    for (const row of this.visibleRows()) {
      const path = row.dataset.path;
      row.classList.toggle("selected", !!path && this.selection.has(path));
    }
  }

  private setSelection(entries: { path: string; isDir: boolean }[], anchor?: string): void {
    const changed = [...this.selection.keys()];
    this.selection.clear();
    for (const entry of entries) {
      this.selection.set(entry.path, entry.isDir);
      changed.push(entry.path);
    }
    if (anchor !== undefined) this.anchorPath = anchor;
    this.paintSelection(changed);
  }

  private clearSelection(): void {
    if (this.selection.size === 0) return;
    const changed = [...this.selection.keys()];
    this.selection.clear();
    this.anchorPath = null;
    this.paintSelection(changed);
  }

  /**
   * 选中逻辑走容器捕获阶段：
   * 只有这样才能在「展开目录 / 打开文件」的监听器之前拦掉带修饰键的点击
   * （行级监听器按注册顺序执行，无法阻止后注册的打开手势）。
   */
  private wireSelection(): void {
    this.container.addEventListener(
      "click",
      (e) => {
        // 拖拽结束后的那一次 click 要整体吞掉：否则落点在其它行时会顺带打开文件，
        // 落点在空白处会把刚拖完的选中清掉
        if (performance.now() < this.suppressClickUntil) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        const target = e.target as HTMLElement | null;
        const row = target?.closest<HTMLElement>(".tree-row[data-path]") ?? null;
        if (!row) {
          // 点空白处清空多选（点过滤框、侧栏其它区域不动选中）
          if (target && this.bodyEl.contains(target)) this.clearSelection();
          return;
        }
        const info = this.rowInfo(row);
        if (!info) return;
        const modified = e.ctrlKey || e.metaKey || e.shiftKey;
        if (!modified) {
          // 普通点击：收敛为单选（打开/展开继续由行自身的监听器处理）
          this.setSelection([info], info.path);
          row.focus({ preventScroll: true });
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) {
          this.extendSelection(info);
        } else if (this.selection.has(info.path)) {
          this.selection.delete(info.path);
          this.paintSelection([info.path]);
        } else {
          this.selection.set(info.path, info.isDir);
          this.anchorPath = info.path;
          this.paintSelection([info.path]);
        }
        row.focus({ preventScroll: true });
      },
      true,
    );
  }

  /** Shift 连选：以锚点为首尾，按当前可见顺序取区间（覆盖原有选区，与资源管理器一致） */
  private extendSelection(target: { path: string; isDir: boolean }): void {
    const rows = this.visibleRows();
    const paths = rows.map((row) => row.dataset.path ?? "");
    const targetIdx = paths.indexOf(target.path);
    const anchorIdx = this.anchorPath ? paths.indexOf(this.anchorPath) : -1;
    if (targetIdx < 0) return;
    if (anchorIdx < 0) {
      this.setSelection([target], target.path);
      return;
    }
    const [lo, hi] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
    const changed = [...this.selection.keys()];
    this.selection.clear();
    for (let i = lo; i <= hi; i++) {
      const path = paths[i];
      if (!path) continue;
      this.selection.set(path, rows[i].dataset.dir === "1");
      changed.push(path);
    }
    this.paintSelection(changed);
  }

  // ---- 拖拽移动（pointer 自绘） ----

  private dragState: {
    items: { path: string; isDir: boolean }[];
    startX: number;
    startY: number;
    pointerId: number;
    active: boolean;
  } | null = null;
  /** 拖拽落点目录（null = 当前位置不可投放） */
  private dropTargetDir: string | null = null;
  /** 落点高亮元素（目录行或树体空白区） */
  private dropTargetEl: HTMLElement | null = null;
  private dragGhostEl: HTMLElement | null = null;

  private wireDrag(): void {
    this.bodyEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        ".tree-row[data-path]",
      );
      const info = row ? this.rowInfo(row) : null;
      if (!info) return;
      // 按下时若该行在多选内：整批拖动；否则只拖这一行（并先收敛选中）
      const inSelection = this.selection.has(info.path) && this.selection.size > 0;
      const items = inSelection ? this.selectedEntries() : [info];
      this.dragState = {
        items,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        active: false,
      };
    });

    window.addEventListener("pointermove", (e) => {
      const state = this.dragState;
      if (!state || e.pointerId !== state.pointerId) return;
      if (!state.active) {
        // 4px 阈值：低于它仍视为点击（与标签栏拖拽一致）
        if (
          Math.abs(e.clientX - state.startX) < 4 &&
          Math.abs(e.clientY - state.startY) < 4
        ) {
          return;
        }
        state.active = true;
        this.startDragVisual(state.items);
      }
      e.preventDefault();
      this.updateDropTarget(e.clientX, e.clientY, state.items);
      this.positionGhost(e.clientX, e.clientY);
    });

    window.addEventListener("pointerup", (e) => {
      const state = this.dragState;
      if (!state || e.pointerId !== state.pointerId) return;
      const targetDir = this.dropTargetDir;
      const active = state.active;
      this.endDragVisual();
      this.dragState = null;
      if (!active) return;
      // 松手后浏览器还会派发 click：屏蔽掉，避免顺手打开文件/折叠目录
      this.suppressClickUntil = performance.now() + 200;
      if (!targetDir) return;
      void this.moveItems(state.items, targetDir);
    });

    window.addEventListener("pointercancel", () => {
      this.endDragVisual();
      this.dragState = null;
    });
  }

  private startDragVisual(items: { path: string; isDir: boolean }[]): void {
    document.body.classList.add("tree-dragging");
    for (const item of items) {
      this.rowOf(item.path)?.classList.add("dragging");
    }
    const ghost = document.createElement("div");
    ghost.className = "tree-drag-ghost";
    ghost.textContent = items.length > 1 ? `移动 ${items.length} 项` : `移动「${basenameOf(items[0].path)}」`;
    document.body.append(ghost);
    this.dragGhostEl = ghost;
  }

  private positionGhost(x: number, y: number): void {
    if (!this.dragGhostEl) return;
    this.dragGhostEl.style.left = `${x + 12}px`;
    this.dragGhostEl.style.top = `${y + 12}px`;
  }

  /**
   * 计算落点：目录行 → 该目录；文件行 → 其父目录；树体空白 → 工作区根。
   * 目标落在被拖项自身或子目录里时视为无效（后端也会拒绝，这里先给视觉反馈）。
   */
  private updateDropTarget(
    x: number,
    y: number,
    items: { path: string; isDir: boolean }[],
  ): void {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const row = el?.closest<HTMLElement>(".tree-row[data-path]") ?? null;
    let dir: string | null = null;
    let highlight: HTMLElement | null = null;
    if (row) {
      const info = this.rowInfo(row);
      if (info) {
        dir = info.isDir ? info.path : dirnameOf(info.path);
        // 拖到文件行上时高亮的其实是"它所在的目录"，避免误以为会覆盖该文件
        highlight = info.isDir ? row : (this.rowOf(dir) ?? row);
      }
    } else if (el && this.bodyEl.contains(el) && this.root) {
      dir = this.root;
      highlight = this.bodyEl;
    }
    if (dir && items.some((item) => isSameOrInsidePath(dir as string, item.path))) {
      dir = null;
      highlight = null;
    }
    if (dir === this.dropTargetDir && highlight === this.dropTargetEl) return;
    this.dropTargetEl?.classList.remove("drop-target");
    this.dropTargetDir = dir;
    this.dropTargetEl = highlight;
    this.dropTargetEl?.classList.add("drop-target");
  }

  private endDragVisual(): void {
    document.body.classList.remove("tree-dragging");
    for (const path of this.selection.keys()) this.rowOf(path)?.classList.remove("dragging");
    this.container.querySelectorAll(".tree-row.dragging").forEach((el) => el.classList.remove("dragging"));
    this.dropTargetEl?.classList.remove("drop-target");
    this.dropTargetEl = null;
    this.dropTargetDir = null;
    this.dragGhostEl?.remove();
    this.dragGhostEl = null;
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
    this.rowByPath.clear();
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
      err.textContent = `搜索失败：${firstLine(e)}`;
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
      empty.textContent = "没有匹配的文件 · 先清空关键词或换个写法再试";
      this.bodyEl.append(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const file of matched.slice(0, FILTER_MAX_ROWS)) frag.append(this.createFlatRow(file));
    this.bodyEl.append(frag);
    this.paintSelection();
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
    row.dataset.path = file.path;
    row.dataset.dir = "0";
    row.tabIndex = -1;
    this.rowByPath.set(file.path, row);

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
    // 旧工作区的选中项在新工作区没有意义（批量删除会打到别的路径上）
    this.selection.clear();
    this.anchorPath = null;
    if (this.filterEl) this.filterEl.value = "";
    this.render();
    // 根目录变化也要通知宿主（侧栏标题、workspaceRoot 与持久化都依赖该回调）
    this.persist();
  }

  getRoot(): string | null {
    return this.root;
  }

  /** 当前展开目录（供目录监听同步） */
  getExpandedDirs(): string[] {
    return [...this.expanded];
  }

  /** 外部变化后只刷新某一层；过滤视图/未展开目录直接忽略 */
  refreshDirectory(dir: string): void {
    if (this.filtering || !this.root) return;
    const target =
      normPath(dir) === normPath(this.root)
        ? this.root
        : [...this.expanded].find((p) => normPath(p) === normPath(dir));
    if (!target) return;
    this.refreshDir(target);
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
      let dir = dirnameOf(path);
      let guard = 0;
      while (dir && guard++ < 64) {
        const key = normPath(dir);
        this.gitDirStatus.set(key, pickStatus(this.gitDirStatus.get(key), status));
        const next = dirnameOf(dir);
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
    this.rowByPath.clear();
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
    this.forgetRowsUnder(dir);
    void this.loadChildren(dir, container, this.depthOf(dir));
  }

  /**
   * 移动 / 删除 / 重命名一个目录后，清掉它自己与子路径的展开态和节点缓存。
   * 不清的话：旧路径还留在 expanded / nodes 里，那个目录下次"展开"时会去读一个已经不存在的路径。
   */
  private forgetSubtree(path: string): void {
    const key = normPath(path);
    const prefix = `${key}/`;
    const under = (candidate: string): boolean => {
      const k = normPath(candidate);
      return k === key || k.startsWith(prefix);
    };
    for (const dir of [...this.expanded]) if (under(dir)) this.expanded.delete(dir);
    for (const dir of [...this.nodes.keys()]) if (under(dir)) this.nodes.delete(dir);
    this.persist();
  }

  /**
   * 目录加载代际：按目录维度记令牌（不能用实例级单一计数）。
   * render() 会对每个已展开目录并发调用本方法，若共用同一个计数器，
   * 后发起的调用会让先发起的全部作废——表现为“展开多个目录时只有最后一个有内容”。
   */
  private loadTokens = new Map<string, number>();

  /** 外层包装：登记"这一层正在加载"，供 revealPath 等待 */
  private async loadChildren(dir: string, container: HTMLElement, depth: number): Promise<void> {
    const task = this.loadChildrenInner(dir, container, depth);
    this.pendingLoads.set(dir, task);
    try {
      await task;
    } finally {
      if (this.pendingLoads.get(dir) === task) this.pendingLoads.delete(dir);
      // 这一层渲染完了：如果待定位的文件就在这层，立刻补上选中
      // （逐层加载会一路推进到叶子目录，不需要定时轮询）
      this.tryReveal();
    }
  }

  /** 让出一帧给浏览器处理输入/绘制，再继续建下一批节点 */
  private yieldToIdle(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => resolve(), { timeout: 250 });
      } else {
        setTimeout(resolve, 0);
      }
    });
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
      err.textContent = `读取失败: ${firstLine(e)}`;
      container.append(err);
      return;
    }
    // 过期结果直接丢弃：否则会与后一次加载的节点叠加成重复行
    if (this.loadTokens.get(dir) !== token || !container.isConnected) return;
    const CHUNK = 200;
    if (entries.length <= CHUNK) {
      const frag = document.createDocumentFragment();
      for (const entry of entries) frag.append(this.createNode(entry, depth));
      container.append(frag);
    } else {
      // 大目录（如 node_modules）一次建几千个节点会卡住主线程：
      // 先建首批，其余在空闲时段分批补齐；期间保留代际校验，折叠/刷新可立即中止
      for (let start = 0; start < entries.length; start += CHUNK) {
        if (this.loadTokens.get(dir) !== token || !container.isConnected) return;
        const slice = entries.slice(start, start + CHUNK);
        const frag = document.createDocumentFragment();
        for (const entry of slice) frag.append(this.createNode(entry, depth));
        container.append(frag);
        // 目标文件可能已在首批出现：不必等整个目录渲染完才定位
        this.tryReveal();
        if (start + CHUNK < entries.length) await this.yieldToIdle();
      }
    }
    // 多选状态跨重绘保留：新行建好后补一次选中态
    this.paintSelection();
  }

  private createNode(entry: DirEntry, depth: number): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node";
    wrapper.dataset.path = entry.path;

    const row = document.createElement("div");
    row.className = "tree-row";
    // 选中/拖拽/批量操作都按 row 自己的 data-path 取条目（与扁平结果行同一套约定）
    row.dataset.path = entry.path;
    row.dataset.dir = entry.is_dir ? "1" : "0";
    this.rowByPath.set(entry.path, row);
    if (this.selection.has(entry.path)) row.classList.add("selected");
    // 每级 12px、起点 8px：与 .tree-flat-row 的左内边距对齐（CSS 里那套基准值）
    row.style.paddingLeft = `${depth * 12 + 8}px`;
    // 可聚焦（-1）：Ctrl+C / Ctrl+X / Ctrl+V 只在文件树持有焦点时生效，
    // 不会把编辑器里的复制粘贴抢走
    row.tabIndex = -1;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(depth + 1));
    if (entry.is_dir) row.setAttribute("aria-expanded", String(this.expanded.has(entry.path)));
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
      // 目录保持单击展开：双击设置只影响「打开文件」；选中态由容器捕获阶段统一处理
      row.addEventListener("click", () => this.toggleExpand(entry.path));
    } else {
      // 单击 / 双击打开由设置决定（config.files.openWithDoubleClick）
      bindOpenGesture(row, { onOpen: () => this.callbacks.onOpenFile(entry.path) });
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
    const container = this.nodes.get(dir);
    if (this.expanded.has(dir)) {
      this.expanded.delete(dir);
      if (container) {
        // 收起：先淡出再清空（同步清空没有过渡）
        container.classList.add("tree-children-exit");
        setTimeout(() => {
          container.classList.remove("tree-children-exit");
          container.replaceChildren();
          this.forgetRowsUnder(dir);
        }, 120);
      }
    } else {
      this.expanded.add(dir);
      if (container) {
        container.classList.add("tree-children-enter");
        container.addEventListener(
          "animationend",
          () => container.classList.remove("tree-children-enter"),
          { once: true },
        );
        void this.loadChildren(dir, container, this.depthOf(dir));
      }
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
      // 展开态同步给读屏（图标只是视觉提示）
      const row = node.querySelector<HTMLElement>(":scope > .tree-row");
      row?.setAttribute("aria-expanded", String(this.expanded.has(path)));
    });
  }

  /** 待定位的文件：树可能正在重建 / 逐层加载，行出现后再选中 */
  private pendingReveal: string | null = null;

  /** 高亮并滚动到指定文件行（与标签页联动） */
  selectRow(path: string): void {
    this.pendingReveal = path;
    this.tryReveal();
  }

  /**
   * 尝试选中待定位行：还没渲染出来就先留着，
   * 等下一次子目录加载完成（见 loadChildren 的 finally）再试。
   */
  private tryReveal(): void {
    const path = this.pendingReveal;
    if (!path) return;
    const row = this.rowOf(path);
    const info = row ? this.rowInfo(row) : null;
    if (!row || !info) return;
    this.pendingReveal = null;
    // 定位即单选：多选状态会让「当前文件」不明确
    this.setSelection([info], info.path);
    row.scrollIntoView({ block: "nearest" });
  }

  /** 丢弃某目录子树的行缓存（收起 / 增量重建后这些行已脱离 DOM） */
  private forgetRowsUnder(dir: string): void {
    for (const key of this.rowByPath.keys()) {
      if (isSameOrInsidePath(key, dir)) this.rowByPath.delete(key);
    }
  }

  /** 按路径取行元素（树行与扁平结果行通用；不存在返回 null） */
  private rowOf(path: string): HTMLElement | null {
    const cached = this.rowByPath.get(path);
    if (cached?.isConnected) return cached;
    if (cached) this.rowByPath.delete(path);
    const found = this.container.querySelector<HTMLElement>(
      `.tree-row[data-path="${CSS.escape(path)}"]`,
    );
    if (found) this.rowByPath.set(path, found);
    return found;
  }

  /** 该路径是否在当前工作区内（决定能否在树里定位；工作区外的文件没有对应节点） */
  canReveal(path: string): boolean {
    return !!this.root && path.startsWith(this.root);
  }

  /**
   * 展开到指定文件的所有祖先目录并高亮（标签页切换联动）。
   *
   * 子目录是懒加载的，`render()` 之后行要等逐层 list_dir 完成才存在；
   * 只等「父目录」那一层不够：render 刚发起时这层还没注册，树被重建 /
   * 分区收起时必然落空（表现为「点标签不定位」）。因此把目标记在
   * pendingReveal，每层加载完成后重试（见 tryReveal）。
   */
  revealPath(path: string): void {
    const root = this.root;
    if (!root || !path.startsWith(root)) {
      this.pendingReveal = null;
      return;
    }
    this.pendingReveal = path;
    const sep = path.includes("\\") ? "\\" : "/";
    const parts = path.slice(root.length + 1).split(/[\\/]/);
    let changed = false;
    let cur = root;
    /** 链路上最深的、已经渲染出来的目录（新展开的层从它开始重建） */
    let branch = root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = `${cur}${sep}${parts[i]}`;
      if (!this.expanded.has(cur)) {
        this.expanded.add(cur);
        changed = true;
      }
      if (!changed && this.nodes.has(cur)) branch = cur;
    }
    // 只重建新展开那一支：整树 render() 会把所有已展开目录的 list_dir
    // 全部重发一遍（切标签时最明显的一卡）。
    if (changed) this.refreshDir(branch);
    this.tryReveal();
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

    // 右键未选中行：先收敛为单选（与资源管理器一致）；右键已选中的一行则保留整批
    if (!this.selection.has(entry.path)) {
      this.setSelection([{ path: entry.path, isDir: entry.is_dir }], entry.path);
    }
    const targets = this.selectedEntries();
    const count = targets.length;
    const batch = count > 1;
    const targetDir = entry.is_dir ? entry.path : dirnameOf(entry.path);

    const items: { label: string; action: () => void }[] = [];
    items.push({ label: "新建文件", action: () => void this.createIn(targetDir, false) });
    items.push({ label: "新建文件夹", action: () => void this.createIn(targetDir, true) });
    const compare = this.callbacks.onCompareFile;
    if (!entry.is_dir && compare) {
      items.push({ label: "与当前文件比较", action: () => compare(entry.path) });
    }
    const openTerminal = this.callbacks.onOpenTerminal;
    if (openTerminal) {
      items.push({ label: "在终端中打开", action: () => openTerminal(targetDir) });
    }
    items.push({ label: "复制文件路径", action: () => void this.copyPath(entry.path) });
    items.push({
      label: batch ? `复制 ${count} 项` : "复制",
      action: () => this.setClip(targets, false),
    });
    items.push({
      label: batch ? `剪切 ${count} 项` : "剪切",
      action: () => this.setClip(targets, true),
    });
    // 始终显示「粘贴」：来源可能是系统剪贴板（资源管理器复制来的），此时应用内剪贴板是空的
    items.push({
      label: this.clip ? `粘贴「${this.clipLabel()}」到这里` : "粘贴",
      action: () => void this.pasteInto(targetDir),
    });
    if (!batch) {
      items.push({ label: "重命名", action: () => void this.renameEntry(entry) });
    }
    items.push({
      label: batch ? `删除 ${count} 项` : "删除",
      action: () => void this.deleteEntries(targets),
    });
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
      this.callbacks.onNotify?.(`复制地址失败: ${firstLine(e)}`);
    }
  }

  /**
   * 记入剪贴板（支持批量）。
   * 复制会同时写进**系统剪贴板**（CF_HDROP），所以可以直接粘到资源管理器；
   * 剪切只在应用内生效——跨应用"剪切"意味着删除工作区外的源文件，超出写入作用域。
   */
  private setClip(items: { path: string; isDir: boolean }[], cut: boolean): void {
    // 父目录已覆盖子项：批量操作前先去重，避免对同一子树重复执行
    const paths = topmostPaths(items.map((item) => item.path));
    if (paths.length === 0) return;
    this.clip = { paths, cut };
    // 反馈统一走状态栏（3 秒自动消失，并进「最近消息」可回看），不另造提示区
    this.callbacks.onNotify?.(
      `${cut ? "已剪切" : "已复制"} ${this.formatNames(paths)}`,
    );
    if (cut) return;
    void invoke("clipboard_set_files", { paths }).catch((e: unknown) => {
      const reason = e instanceof Error ? e.message : String(e);
      // 系统剪贴板写不进去不影响应用内使用：说清"还能怎么用"，不要只说失败
      this.callbacks.onNotify?.(
        `系统剪贴板不可用（${firstLine(reason)}），仍可在本应用内粘贴`,
      );
    });
  }

  /** 提示文案里的名称：单项用文件名，多项用「N 项」 */
  private formatNames(paths: string[]): string {
    return paths.length === 1 ? `「${basenameOf(paths[0])}」` : `${paths.length} 项`;
  }

  private clipLabel(): string {
    return this.clip ? this.formatNames(this.clip.paths) : "";
  }

  /** 清空剪贴板（silent = 粘贴成功后自动清，不需要再提示一次） */
  private clearClip(silent = false): void {
    this.clip = null;
    if (!silent) this.callbacks.onNotify?.("已清空文件剪贴板");
  }

  /**
   * 粘贴到目标目录。
   * 顺序：**先看系统剪贴板**（从资源管理器复制进来的文件走这条，只复制不移动），
   * 没有再退回应用内剪贴板（支持剪切/移动）。
   */
  private async pasteInto(dir: string): Promise<void> {
    const clip = this.clip;

    // 1) 应用内剪切优先：系统剪贴板里可能还留着上一次「复制」的旧路径，
    //    若先读系统剪贴板，剪切后粘贴会变成"把别的文件又复制一遍"
    if (!clip?.cut) {
      let external: string[] = [];
      try {
        external = await invoke<string[]>("clipboard_get_files");
      } catch {
        external = [];
      }
      if (external.length > 0) {
        try {
          const targets = await invoke<string[]>("paste_files", {
            sources: external,
            destDir: dir,
            cut: false,
          });
          this.afterTransfer(
            dir,
            targets.map((to) => ({ from: to, to })),
            false,
          );
          this.callbacks.onNotify?.(`已从系统剪贴板粘贴 ${targets.length} 项`);
        } catch (e) {
          this.callbacks.onNotify?.(`粘贴失败：${firstLine(e)}`);
        }
        return;
      }
    }

    if (!clip) {
      this.callbacks.onNotify?.(
        "剪贴板里没有文件：先在资源管理器里复制文件，或在文件树上右键「复制」",
      );
      return;
    }
    // 剪切到原目录等于没动：跳过这些源，避免"目标已存在同名项"的误导性错误
    const destKey = normPath(dir);
    const sources = clip.cut
      ? clip.paths.filter((path) => normPath(dirnameOf(path)) !== destKey)
      : clip.paths;
    if (sources.length === 0) {
      this.callbacks.onNotify?.("已经在目标目录里，无需移动");
      return;
    }
    const result = await this.transferPaths(sources, dir, clip.cut);
    // 移动完成：剪贴板已消费掉（复制则保留，便于继续粘贴到别处）
    if (clip.cut && result.moved.length > 0) this.clearClip(true);
    this.afterTransfer(dir, result.moved, clip.cut, result.failed);
  }

  /**
   * 批量复制 / 移动：逐项调用 `copy_path`。
   *
   * 不用 `paste_files` 整批调用的原因：整批在中途失败时拿不到"哪些已成功"，
   * 会留下指向旧路径的标签（移动后保存会写回已不存在的位置）。
   * 逐项虽然多打几次 IPC，但能精确同步已成功的项，并给出失败清单。
   */
  private async transferPaths(
    paths: string[],
    destDir: string,
    cut: boolean,
  ): Promise<{ moved: { from: string; to: string }[]; failed: { path: string; reason: string }[] }> {
    const moved: { from: string; to: string }[] = [];
    const failed: { path: string; reason: string }[] = [];
    for (const from of topmostPaths(paths)) {
      try {
        const to = await invoke<string>("copy_path", { from, destDir, cut });
        moved.push({ from, to });
      } catch (e) {
        failed.push({ path: from, reason: firstLine(e) });
      }
    }
    return { moved, failed };
  }

  /** 拖拽移动：整批移动进目标目录 */
  private async moveItems(
    items: { path: string; isDir: boolean }[],
    destDir: string,
  ): Promise<void> {
    // 拖回原目录等于没动：不发起 IPC，也不弹"目标已存在同名项"这种误导性错误
    const destKey = normPath(destDir);
    const movable = items.filter((item) => normPath(dirnameOf(item.path)) !== destKey);
    if (movable.length === 0) {
      this.callbacks.onNotify?.("已经在目标目录里，无需移动");
      return;
    }
    const result = await this.transferPaths(
      movable.map((item) => item.path),
      destDir,
      true,
    );
    this.afterTransfer(destDir, result.moved, true, result.failed);
  }

  /**
   * 复制 / 移动后的共同收尾：
   * 同步标签路径、清掉已移走路径的展开缓存、只重建受影响的层、选中第一个新条目。
   */
  private afterTransfer(
    destDir: string,
    moved: { from: string; to: string }[],
    cut: boolean,
    failed: { path: string; reason: string }[] = [],
  ): void {
    if (moved.length === 0 && failed.length === 0) return;
    if (cut) {
      const destKey = normPath(destDir);
      const sourceParents = new Set(moved.map((mv) => dirnameOf(mv.from)));
      for (const mv of moved) {
        // 标签还指着旧路径的话，保存会写回已不存在的位置
        this.callbacks.onPathMoved?.(mv.from, mv.to);
        // 被移走的路径及其子树的展开态 / 节点缓存全部失效
        this.forgetSubtree(mv.from);
      }
      for (const parent of sourceParents) {
        // 只在源目录"当前可见"时重建：折叠中的目录重发 list_dir 会让子项在收起状态下冒出来
        const visible = parent === this.root || this.expanded.has(parent);
        if (visible && normPath(parent) !== destKey) this.refreshDir(parent);
      }
    }

    const wasExpanded = this.expanded.has(destDir);
    this.expanded.add(destDir);
    if (wasExpanded) this.refreshDir(destDir);
    else this.render();

    const first = moved[0]?.to ?? null;
    if (first) {
      const reveal = (): void => this.selectRow(first);
      const pending = this.pendingLoads.get(destDir);
      if (pending) void pending.then(reveal);
      else reveal();
    }

    // 结果汇总：失败要说清是哪一项，不能只报"操作失败"
    const action = cut ? "移动" : "复制";
    const failure = failed[0];
    if (!failure) {
      this.callbacks.onNotify?.(
        moved.length > 1
          ? `已${action} ${moved.length} 项到「${basenameOf(destDir)}」`
          : `已${action}到「${basenameOf(moved[0]?.to ?? destDir)}」`,
      );
    } else if (moved.length === 0) {
      this.callbacks.onNotify?.(`${action}失败：${basenameOf(failure.path)}（${failure.reason}）`);
    } else {
      this.callbacks.onNotify?.(
        `已${action} ${moved.length} 项，失败 ${failed.length} 项：` +
          `${basenameOf(failure.path)}（${failure.reason}）`,
      );
    }
  }

  /** 全局监听挂载点：应用启动时调用一次 */
  mountGlobalListeners(): void {
    document.addEventListener("click", () => this.closeContextMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeContextMenu();
        // 先退多选，再退剪贴板：Esc 逐层撤销当前视图状态
        if (this.selection.size > 0) {
          this.clearSelection();
          return;
        }
        if (this.clip && !isEditableTarget(e.target)) this.clearClip();
        return;
      }
      // 焦点在编辑器 / 输入框里时，快捷键归它们（不能抢走"复制文本"/删除字符）
      if (isEditableTarget(e.target)) return;
      const inTree = this.container.contains(document.activeElement);

      if (e.key === "Delete" && inTree && this.selection.size > 0) {
        e.preventDefault();
        void this.deleteEntries(this.selectedEntries());
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "a" && inTree) {
        // 树内全选（过滤视图下即全选当前结果）
        e.preventDefault();
        const rows = this.visibleRows();
        const entries = rows
          .map((row) => this.rowInfo(row))
          .filter((info): info is { path: string; isDir: boolean } => info !== null);
        this.setSelection(entries, entries[0]?.path);
        return;
      }
      const entries = this.selectedEntries();
      if (entries.length === 0) return;
      const primary = this.anchorPath ?? entries[0].path;
      const primaryIsDir = this.selection.get(primary) ?? false;
      if (key === "c") {
        e.preventDefault();
        this.setClip(entries, false);
      } else if (key === "x") {
        e.preventDefault();
        this.setClip(entries, true);
      } else if (key === "v") {
        // 不要求应用内剪贴板非空：可能是刚从资源管理器复制的文件
        e.preventDefault();
        void this.pasteInto(primaryIsDir ? primary : dirnameOf(primary));
      }
    });
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
      // 已展开：只重建这一层；折叠态（含新建目录后要露出来）退回全量
      if (wasExpanded && !isDir) this.refreshDir(dir);
      else this.render();
      // 新建文件后直接打开：省掉“建完还要在树里找一次”的多余操作
      if (!isDir) this.callbacks.onOpenFile(target);
    } catch (e) {
      this.callbacks.onNotify?.(`创建失败: ${firstLine(e)}`);
    }
  }

  private async renameEntry(entry: DirEntry): Promise<void> {
    const name = await promptText("新名称:", entry.name);
    if (!name || name === entry.name) return;
    const target = `${dirnameOf(entry.path)}${entry.path.includes("\\") ? "\\" : "/"}${name}`;
    try {
      await invoke("rename_path", { from: entry.path, to: target });
      // 同步已打开的标签：否则标签还指着旧路径，保存会写回一个已不存在的文件
      this.callbacks.onPathMoved?.(entry.path, target);
      // 目录改名：旧路径下的展开态 / 子节点缓存全部失效
      if (entry.is_dir) this.forgetSubtree(entry.path);
      // 只重建父目录这一层，再等它加载完选中新名称（走 revealPath 会整树重建）
      const parent = dirnameOf(target);
      this.refreshDir(parent);
      const pending = this.pendingLoads.get(parent);
      if (pending) void pending.then(() => this.selectRow(target));
      else this.selectRow(target);
    } catch (e) {
      this.callbacks.onNotify?.(`重命名失败: ${firstLine(e)}`);
    }
  }

  /**
   * 批量删除（走系统回收站）。
   * 父目录与其子项同时选中时只处理父目录——子项随后已不存在，重复删会报「路径不存在」。
   */
  private async deleteEntries(items: { path: string; isDir: boolean }[]): Promise<void> {
    const isDirOf = new Map(items.map((item) => [item.path, item.isDir]));
    const targets = topmostPaths(items.map((item) => item.path)).map((path) => ({
      path,
      isDir: isDirOf.get(path) ?? false,
    }));
    if (targets.length === 0) return;
    const hasDir = targets.some((target) => target.isDir);
    const names = targets
      .slice(0, 5)
      .map((target) => `「${basenameOf(target.path)}」`)
      .join("、");
    const suffix = targets.length > 5 ? ` 等 ${targets.length} 项` : "";
    const ok = await confirmAction(
      `确定删除 ${names}${suffix}？\n` +
        (hasDir
          ? "目录下的全部内容会一起移入系统回收站，可从回收站还原。"
          : "将移入系统回收站，可从回收站还原。"),
    );
    if (!ok) return;

    const parents = new Set<string>();
    const failed: string[] = [];
    const removedPaths: string[] = [];
    for (const target of targets) {
      try {
        await invoke("delete_path", { path: target.path });
        removedPaths.push(target.path);
        parents.add(dirnameOf(target.path));
        // 同步右侧主区：干净标签关掉，脏标签保留（内容还在内存里，否则一保存就"复活"文件）
        this.callbacks.onPathDeleted?.(target.path, target.isDir);
        // 目录被删：它下面已展开的子目录缓存也要一并清掉
        this.forgetSubtree(target.path);
      } catch (e) {
        failed.push(`${basenameOf(target.path)}（${firstLine(e)}）`);
      }
    }
    // 已删路径及其子路径一并退出选中（否则 Ctrl+C 会拿着不存在的路径）
    for (const removedPath of removedPaths) {
      for (const selected of [...this.selection.keys()]) {
        if (isSameOrInsidePath(selected, removedPath)) this.selection.delete(selected);
      }
    }
    this.anchorPath = null;
    this.paintSelection();
    // 只重建父目录这一层：全树 render() 会让所有已展开目录重发 list_dir 并闪烁
    for (const parent of parents) this.refreshDir(parent);

    if (failed.length === 0) {
      this.callbacks.onNotify?.(`已删除 ${removedPaths.length} 项（可在回收站还原）`);
    } else if (removedPaths.length === 0) {
      this.callbacks.onNotify?.(`删除失败：${failed[0]}`);
    } else {
      this.callbacks.onNotify?.(
        `已删除 ${removedPaths.length} 项，失败 ${failed.length} 项：${failed[0]}`,
      );
    }
  }
}

/**
 * 焦点是否在"文本输入场景"里（编辑器 / 输入框 / contenteditable）。
 * 文件树的 Ctrl+C/X/V 只在**不**处于这些地方时生效，否则会抢走"复制文本"。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  return el.closest(".cm-editor") !== null || el.closest("input, textarea, [contenteditable]") !== null;
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
