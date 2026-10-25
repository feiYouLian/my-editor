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
import { bindOpenGesture, selectRowIn } from "../ui/openGesture";

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
    this.render();
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
    this.commitBtn.disabled =
      this.busy || staged === 0 || this.messageEl.value.trim() === "";
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
    label.textContent = `${title} (${entries.length})`;
    head.append(chevron, label);

    if (entries.length > 0) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "git-group-action";
      action.textContent = staged ? "全部取消" : "全部暂存";
      action.disabled = this.busy;
      action.addEventListener("click", (e) => {
        // 按钮在组头内：拦下冒泡，否则点「全部暂存」会顺带折叠该组
        e.stopPropagation();
        if (staged) this.deps.onUnstage(entries);
        else this.deps.onStage(entries);
      });
      head.append(action);
    }

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
      for (const entry of entries) list.append(this.renderRow(entry, staged));
    }

    group.append(head, list);
    syncCollapsed();
    return group;
  }

  private renderRow(entry: GitFileEntry, staged: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "git-row";
    const display = entry.orig_relative
      ? `${entry.orig_relative} → ${entry.relative}`
      : entry.relative;
    row.title = display;

    const status = document.createElement("span");
    status.className = "git-status";
    status.dataset.status = entry.status;
    status.textContent = entry.status;

    const path = document.createElement("span");
    path.className = "git-path";
    path.textContent = display;

    // 撤回（放弃更改）：悬停显示，与右键菜单同一动作
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "git-row-action git-row-discard";
    discard.title = staged ? "放弃更改（还原到 HEAD）" : "放弃更改";
    discard.setAttribute("aria-label", discard.title);
    discard.disabled = this.busy;
    discard.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5h6.5a3 3 0 0 1 0 6H7"/><path d="M5.8 4.2 2.5 7.5l3.3 3.3"/></svg>';
    discard.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deps.onDiscard([entry], staged);
    });

    const action = document.createElement("button");
    action.type = "button";
    action.className = "git-row-action";
    action.textContent = staged ? "−" : "+";
    action.title = staged ? "取消暂存" : "暂存";
    action.disabled = this.busy;
    action.addEventListener("click", (e) => {
      e.stopPropagation();
      if (staged) this.deps.onUnstage([entry]);
      else this.deps.onStage([entry]);
    });

    row.append(status, path, discard, action);
    bindOpenGesture(row, {
      onSelect: () => selectRowIn(row),
      onOpen: () => this.deps.onOpenDiff(entry.path, staged),
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

/** 取父目录（兼 Windows `\` 与 POSIX `/`） */
function parentDirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}
