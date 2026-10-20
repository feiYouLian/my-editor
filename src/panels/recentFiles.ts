/**
 * 最近打开列表：localStorage 记录最近打开的磁盘文件（上限 20 条），
 * 对话框列出并以点击打开。不依赖后端，跨会话保留。
 */

const KEY = "my-editor.recentFiles";
const MAX = 20;

/** 读取最近打开列表（最近的在前） */
export function loadRecentFiles(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** 记录一次打开（去重后前置，超出上限截断） */
export function pushRecentFile(path: string): void {
  if (!path) return;
  const list = [path, ...loadRecentFiles().filter((p) => p !== path)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // localStorage 不可用时静默降级
  }
}

export class RecentFilesDialog {
  private backdrop: HTMLElement | null = null;

  constructor(private onOpen: (path: string) => void) {}

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
  }

  open(): void {
    if (this.isOpen) return;

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "dialog dialog-wide";
    dialog.setAttribute("role", "dialog");

    const title = document.createElement("h3");
    title.textContent = "最近打开的文件";
    dialog.append(title);

    const list = loadRecentFiles();
    const body = document.createElement("div");
    body.className = "recent-list";

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dialog-text";
      empty.textContent = "暂无记录";
      body.append(empty);
    } else {
      for (const path of list) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "recent-row";
        row.title = path;

        const name = document.createElement("span");
        name.className = "recent-name";
        name.textContent = path.split(/[\\/]/).pop() ?? path;

        const dir = document.createElement("span");
        dir.className = "recent-path";
        const cut = path.replace(/[\\/][^\\/]+$/, "");
        dir.textContent = cut.length > 46 ? `…${cut.slice(-46)}` : cut;

        row.append(name, dir);
        row.addEventListener("click", () => {
          this.close();
          this.onOpen(path);
        });
        body.append(row);
      }
    }
    dialog.append(body);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "清空列表";
    clearBtn.addEventListener("click", () => {
      try {
        localStorage.removeItem(KEY);
      } catch {
        // 忽略
      }
      this.close();
      this.open();
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "primary";
    closeBtn.textContent = "关闭";
    closeBtn.addEventListener("click", () => this.close());
    actions.append(clearBtn, closeBtn);
    dialog.append(actions);

    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;
    dialog.tabIndex = -1;
    dialog.focus();
  }
}
