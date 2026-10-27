/**
 * 侧栏「源代码管理」分区（只读渲染 + 操作入口）：
 * 提交框、「暂存的更改 / 更改」两组可折叠列表、行级与组级暂存操作。
 * 分支名 / ahead / behind 只在底部状态栏展示（ui/gitStatusItem.ts）；
 * 手动刷新在组头右键菜单里（打开分区时会自动刷新）。
 *
 * 只负责 DOM 与本地状态（busy/error/折叠），所有 IPC 经 deps 交回 app/gitHost.ts，
 * 避免 panels 直接依赖后端命令。
 */

import { placeMenu } from "../ui/menu";
import { bindOpenGesture } from "../ui/openGesture";

export interface GitFileEntry {
  path: string;
  relative: string;
  status: string;
  orig_relative: string | null;
}

export interface GitStatus {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  error: string;
  truncated: boolean;
}

export interface GitViewDeps {
  onRefresh: () => void;
  onOpenDiff: (path: string, staged: boolean) => void;
  onStage: (entries: GitFileEntry[]) => void;
  onUnstage: (entries: GitFileEntry[]) => void;
  /** 放弃更改（不可撤销）：确认弹窗由 main.ts 负责；staged 仅用于提示文案 */
  onDiscard: (entries: GitFileEntry[], staged: boolean) => void;
  onCommit: (message: string) => void;
  /** 右键：在编辑器中打开文件 */
  onOpenFile: (path: string) => void;
  onCopyPath: (path: string) => void;
  /** 复制仓库内相对路径（`/` 分隔，与 git 命令口径一致） */
  onCopyRelative: (relative: string) => void;
  onReveal: (dirOrPath: string) => void;
  /** 在终端中打开所在目录 */
  onOpenTerminal: (dir: string) => void;
}

/** 右键菜单条目（与文件树 / 打开的文件列表同款外观） */
type MenuEntry =
  | { label: string; hint?: string; disabled?: boolean; danger?: boolean; run: () => void }
  | { separator: true };

export class GitView {
  private status: GitStatus | null = null;
  private busy = false;
  /** 最近一次刷新失败的原因（保留旧列表，在其上方提示） */
  private error = "";
  /** 折叠的分组（只记会话状态：重新挂载 / 重启后默认全展开） */
  private collapsed = new Set<"staged" | "changes">();
  /** 多选集合：key 带组前缀（同一文件可能同时出现在"已暂存"和"更改"两组） */
  private selection = new Set<string>();
  /** Shift 连选的锚点（按组记） */
  private lastIndex = new Map<"staged" | "changes", number>();

  private bodyEl!: HTMLElement;
  private messageEl!: HTMLTextAreaElement;
  private commitBtn!: HTMLButtonElement;
  /** 右键菜单（全局唯一，自持句柄） */
  private menu: HTMLElement | null = null;

  constructor(host: HTMLElement, private deps: GitViewDeps) {
    host.innerHTML = "";
    this.build(host);
    this.render();
    document.addEventListener("click", () => this.closeMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
  }

  /** 状态刷新结果（null = 尚未读取 / 无工作区） */
  update(status: GitStatus | null): void {
    this.status = status;
    this.error = "";
    // 提交 / 放弃后条目会消失：把已不存在的选中项清掉，避免"已选 3 项"却只剩 1 项
    if (status) {
      const alive = new Set<string>();
      for (const e of status.staged) alive.add(this.keyOf(e, true));
      for (const e of status.changes) alive.add(this.keyOf(e, false));
      for (const key of [...this.selection]) {
        if (!alive.has(key)) this.selection.delete(key);
      }
    } else {
      this.selection.clear();
    }
    this.render();
  }

  private keyOf(entry: GitFileEntry, staged: boolean): string {
    return `${staged ? "S" : "C"}|${entry.path}`;
  }

  /** 该组当前被选中的条目（无选中时返回空数组） */
  private selectedIn(entries: GitFileEntry[], staged: boolean): GitFileEntry[] {
    return entries.filter((e) => this.selection.has(this.keyOf(e, staged)));
  }

  /** 刷新失败：保留旧列表，仅在顶部提示 */
  fail(message: string): void {
    this.error = message;
    this.render();
  }

  /** 操作进行中：禁用行内 / 组级 / 提交按钮 */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.render();
  }

  clearCommitMessage(): void {
    this.messageEl.value = "";
    this.syncCommitButton();
  }

  private build(host: HTMLElement): void {
    const commit = document.createElement("div");
    commit.className = "git-commit";
    this.messageEl = document.createElement("textarea");
    this.messageEl.className = "git-message";
    this.messageEl.placeholder = "提交信息（Ctrl+Enter 提交）";
    this.messageEl.rows = 2;
    this.messageEl.spellcheck = false;
    this.messageEl.addEventListener("input", () => this.syncCommitButton());
    this.messageEl.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.submitCommit();
      }
    });
    this.commitBtn = document.createElement("button");
    this.commitBtn.type = "button";
    this.commitBtn.className = "git-commit-btn";
    this.commitBtn.textContent = "提交";
    this.commitBtn.disabled = true;
    this.commitBtn.addEventListener("click", () => this.submitCommit());
    commit.append(this.messageEl, this.commitBtn);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "git-body";

    host.append(commit, this.bodyEl);
  }

  private submitCommit(): void {
    const message = this.messageEl.value.trim();
    if (!message || this.busy) return;
    this.deps.onCommit(message);
  }

  private syncCommitButton(): void {
    const staged = this.status?.staged.length ?? 0;
    const emptyMessage = this.messageEl.value.trim() === "";
    this.commitBtn.disabled = this.busy || staged === 0 || emptyMessage;
    // 灰掉的按钮必须说明原因，否则用户只能猜
    this.commitBtn.title = this.busy
      ? "正在提交…"
      : staged === 0
        ? "先暂存要提交的更改"
        : emptyMessage
          ? "填写提交信息后即可提交（Ctrl+Enter）"
          : "提交（Ctrl+Enter）";
  }

  private render(): void {
    const status = this.status;
    this.bodyEl.innerHTML = "";

    if (this.error) {
      const err = document.createElement("div");
      err.className = "git-error";
      err.textContent = this.error;
      this.bodyEl.append(err);
    }
    if (!status) {
      this.appendEmpty("未打开工作区：打开目录后自动读取 Git 状态");
      this.syncCommitButton();
      return;
    }
    if (status.error) {
      this.appendEmpty(`当前工作区不是 Git 仓库\n${status.error}`);
      this.syncCommitButton();
      return;
    }
    if (status.staged.length === 0 && status.changes.length === 0) {
      this.appendEmpty("没有更改");
      this.syncCommitButton();
      return;
    }

    this.bodyEl.append(this.renderGroup("暂存的更改", status.staged, true));
    this.bodyEl.append(this.renderGroup("更改", status.changes, false));
    if (status.truncated) {
      const hint = document.createElement("div");
      hint.className = "git-truncated";
      hint.textContent = "条目过多，仅显示前 5000 条";
      this.bodyEl.append(hint);
    }
    this.syncCommitButton();
  }

  private appendEmpty(text: string): void {
    const empty = document.createElement("div");
    empty.className = "git-empty";
    empty.textContent = text;
    this.bodyEl.append(empty);
  }

  private renderGroup(
    title: string,
    entries: GitFileEntry[],
    staged: boolean,
  ): HTMLElement {
    const key = staged ? "staged" : "changes";
    const group = document.createElement("div");
    group.className = "git-group";

    const head = document.createElement("div");
    head.className = "git-group-head";
    head.setAttribute("role", "button");
    const chevron = document.createElement("span");
    chevron.className = "git-chevron";
    const label = document.createElement("span");
    label.className = "git-group-label";
    const selected = this.selectedIn(entries, staged);
    label.textContent =
      selected.length > 0
        ? `${title} (${entries.length}) · 已选 ${selected.length}`
        : `${title} (${entries.length})`;
    head.append(chevron, label);

    if (entries.length > 0) {
      // 有选中就只作用于选中项，否则整组（与 VS Code 的 SCM 一致）
      const target = selected.length > 0 ? selected : entries;
      const action = document.createElement("button");
      action.type = "button";
      action.className = "git-group-action";
      action.textContent = staged
        ? selected.length > 0
          ? `取消选中 ${selected.length}`
          : "全部取消"
        : selected.length > 0
          ? `暂存选中 ${selected.length}`
          : "全部暂存";
      action.disabled = this.busy;
      action.addEventListener("click", (e) => {
        // 按钮在组头内：拦下冒泡，否则点「全部暂存」会顺带折叠该组
        e.stopPropagation();
        this.selection.clear();
        if (staged) this.deps.onUnstage(target);
        else this.deps.onStage(target);
      });
      head.append(action);

      if (selected.length > 0) {
        const discard = document.createElement("button");
        discard.type = "button";
        discard.className = "git-group-action danger";
        discard.textContent = `放弃选中 ${selected.length}`;
        discard.title = "放弃所选文件的更改（会二次确认）";
        discard.disabled = this.busy;
        discard.addEventListener("click", (e) => {
          e.stopPropagation();
          this.selection.clear();
          this.deps.onDiscard(selected, staged);
        });
        head.append(discard);
      }
    }

    // 刷新按钮常显：原来只藏在组头右键菜单里，用户不知道能刷新
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "git-group-action";
    refreshBtn.textContent = "⟳";
    refreshBtn.title = "刷新状态";
    refreshBtn.setAttribute("aria-label", "刷新状态");
    refreshBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // 否则会顺带折叠该组
      this.deps.onRefresh();
    });
    head.append(refreshBtn);

    // 组头即折叠开关（VS Code 的 SCM 分组行为），点击标题展开 / 收起该组列表
    const syncCollapsed = (): void => {
      const folded = this.collapsed.has(key);
      group.classList.toggle("collapsed", folded);
      chevron.textContent = folded ? "›" : "⌄";
      head.setAttribute("aria-expanded", String(!folded));
      head.title = folded ? "展开该组" : "折叠该组";
    };
    head.addEventListener("click", () => {
      if (this.collapsed.has(key)) this.collapsed.delete(key);
      else this.collapsed.add(key);
      syncCollapsed();
    });

    // 组头右键：整组暂存 / 取消暂存 + 刷新
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showGroupMenu(e.clientX, e.clientY, entries, staged);
    });

    const list = document.createElement("div");
    list.className = "git-list";
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "git-empty-row";
      empty.textContent = "无";
      list.append(empty);
    } else {
      for (const [index, entry] of entries.entries()) {
        list.append(this.renderRow(entry, staged, index, entries));
      }
    }

    group.append(head, list);
    syncCollapsed();
    return group;
  }

  private renderRow(
    entry: GitFileEntry,
    staged: boolean,
    index: number,
    entries: GitFileEntry[],
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "git-row";
    const groupKey: "staged" | "changes" = staged ? "staged" : "changes";
    const selKey = this.keyOf(entry, staged);
    if (this.selection.has(selKey)) row.classList.add("row-selected");
    // 文件名优先：长路径下所有行共享前缀，只有文件名能区分（完整路径放 title）
    const { name, dir } = splitRelative(entry.relative);
    row.title = entry.orig_relative
      ? `${entry.orig_relative} → ${entry.relative}`
      : entry.relative;

    const status = document.createElement("span");
    status.className = "git-status";
    status.dataset.status = entry.status;
    status.textContent = entry.status;

    const nameEl = document.createElement("span");
    nameEl.className = "git-name";
    nameEl.textContent = name;

    row.append(status, nameEl);
    if (dir) {
      const dirEl = document.createElement("span");
      dirEl.className = "git-dir";
      dirEl.textContent = dir;
      row.append(dirEl);
    }

    // 行内只保留"暂存 / 取消暂存"；放弃更改（不可撤销）只在右键菜单里，
    // 避免与高频按钮紧挨着被误点（原实现的红色撤回按钮就在旁边）
    const action = document.createElement("button");
    action.type = "button";
    action.className = "git-row-action";
    action.title = staged ? "取消暂存" : "暂存";
    action.setAttribute("aria-label", action.title);
    action.disabled = this.busy;
    action.innerHTML = staged
      ? '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 8h8"/></svg>'
      : '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6"/></svg>';
    action.addEventListener("click", (e) => {
      e.stopPropagation();
      if (staged) this.deps.onUnstage([entry]);
      else this.deps.onStage([entry]);
    });
    row.append(action);

    // 修饰键多选：必须在 openGesture 之前注册，靠 stopImmediatePropagation
    // 挡住"打开 diff"（同级监听器按注册顺序执行，capture 标记在 target 上无效）
    row.addEventListener("click", (e) => {
      const modifier = e.ctrlKey || e.metaKey || e.shiftKey;
      if (!modifier) {
        // 普通点击：清掉选中并继续走"看 diff"
        if (this.selection.size > 0) {
          this.selection.clear();
          this.render();
        }
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.shiftKey) {
        const from = this.lastIndex.get(groupKey) ?? index;
        const [lo, hi] = from <= index ? [from, index] : [index, from];
        if (!e.ctrlKey && !e.metaKey) {
          const prefix = staged ? "S|" : "C|";
          for (const key of [...this.selection]) {
            if (key.startsWith(prefix)) this.selection.delete(key);
          }
        }
        for (let i = lo; i <= hi; i++) this.selection.add(this.keyOf(entries[i], staged));
      } else if (this.selection.has(selKey)) {
        this.selection.delete(selKey);
      } else {
        this.selection.add(selKey);
      }
      this.lastIndex.set(groupKey, index);
      // 组头要显示"已选 N 项"，直接整体重绘（SCM 列表规模很小）
      this.render();
    });

    // 固定单击看 diff（不受"双击打开"配置影响）；双击在编辑器中打开文件
    bindOpenGesture(row, {
      forceSingleClick: true,
      onOpen: () => this.deps.onOpenDiff(entry.path, staged),
    });
    row.addEventListener("dblclick", () => {
      if (entry.status.includes("D")) return; // 已删除的文件没有内容可开
      this.deps.onOpenFile(entry.path);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showRowMenu(e.clientX, e.clientY, entry, staged);
    });
    return row;
  }

  // ---- 右键菜单（与文件树 / 打开的文件列表同款外观） ----

  /**
   * 文件行菜单，按 VS Code 源代码管理的语义排列：
   * 打开 → 暂存 / 取消暂存 → 路径与位置。
   * 已删除的文件不提供「打开文件」（磁盘上已不存在），
   * 改为定位其父目录。
   */
  private showRowMenu(
    x: number,
    y: number,
    entry: GitFileEntry,
    staged: boolean,
  ): void {
    const missing = entry.status.includes("D");
    const dir = parentDirOf(entry.path);
    const items: MenuEntry[] = [
      {
        label: "打开文件",
        disabled: missing,
        run: () => this.deps.onOpenFile(entry.path),
      },
      {
        label: staged ? "查看暂存的更改" : "查看更改",
        run: () => this.deps.onOpenDiff(entry.path, staged),
      },
      { separator: true },
      staged
        ? { label: "取消暂存", run: () => this.deps.onUnstage([entry]) }
        : { label: "暂存更改", run: () => this.deps.onStage([entry]) },
      // 放弃更改会把磁盘内容回退（新增/未跟踪文件直接删除），红色提示不可撤销
      {
        label: staged ? "放弃更改（还原到 HEAD）" : "放弃更改",
        danger: true,
        run: () => this.deps.onDiscard([entry], staged),
      },
      { separator: true },
      { label: "复制路径", run: () => this.deps.onCopyPath(entry.path) },
      { label: "复制相对路径", run: () => this.deps.onCopyRelative(entry.relative) },
      { separator: true },
      {
        label: "在文件管理器中显示",
        run: () => this.deps.onReveal(missing ? dir : entry.path),
      },
      { label: "在终端中打开", run: () => this.deps.onOpenTerminal(dir) },
    ];
    this.showMenu(x, y, items);
  }

  /** 组头菜单：整组操作（与组头右侧按钮等价） */
  private showGroupMenu(
    x: number,
    y: number,
    entries: GitFileEntry[],
    staged: boolean,
  ): void {
    const empty = entries.length === 0;
    const items: MenuEntry[] = [
      staged
        ? {
            label: `全部取消暂存（${entries.length}）`,
            disabled: empty || this.busy,
            run: () => this.deps.onUnstage(entries),
          }
        : {
            label: `全部暂存（${entries.length}）`,
            disabled: empty || this.busy,
            run: () => this.deps.onStage(entries),
          },
      { separator: true },
      { label: "刷新状态", run: () => this.deps.onRefresh() },
    ];
    this.showMenu(x, y, items);
  }

  private showMenu(x: number, y: number, items: MenuEntry[]): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";

    for (const item of items) {
      if ("separator" in item) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        menu.append(sep);
        continue;
      }
      const el = document.createElement("div");
      el.className = item.disabled ? "context-menu-item disabled" : "context-menu-item";
      if (!item.disabled && item.danger) el.classList.add("danger");
      const label = document.createElement("span");
      label.textContent = item.label;
      el.append(label);
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "shortcut";
        hint.textContent = item.hint;
        el.append(hint);
      }
      if (!item.disabled) {
        el.addEventListener("click", () => {
          this.closeMenu();
          item.run();
        });
      }
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

/** 拆出文件名与所在目录（git 的 relative 一律用 `/`，这里兼容 `\`） */
function splitRelative(relative: string): { name: string; dir: string } {
  const idx = Math.max(relative.lastIndexOf("/"), relative.lastIndexOf("\\"));
  if (idx < 0) return { name: relative, dir: "" };
  return { name: relative.slice(idx + 1), dir: relative.slice(0, idx) };
}

/** 取父目录（兼 Windows `\` 与 POSIX `/`） */
function parentDirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}
