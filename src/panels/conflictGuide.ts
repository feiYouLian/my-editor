/**
 * Git 冲突处理引导：列出冲突文件、说明标记与命令，不在应用内自动合并。
 * 真正的编辑/暂存仍由用户完成，避免误操作覆盖冲突现场。
 */

import type { GitFileEntry } from "./gitView";

export class ConflictGuideDialog {
  private backdrop: HTMLElement | null = null;

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(
    root: string,
    files: GitFileEntry[],
    onOpenFile: (path: string) => void,
    onOpenTerminal: (dir: string) => void,
  ): void {
    if (this.isOpen) return;
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "dialog git-conflict-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Git 冲突处理");

    const head = document.createElement("div");
    head.className = "git-history-head";
    const title = document.createElement("h3");
    title.textContent = "解决 Git 冲突";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "gs-head-btn";
    close.textContent = "✕";
    close.title = "关闭";
    close.addEventListener("click", () => this.close());
    head.append(title, close);

    const intro = document.createElement("p");
    intro.className = "dialog-text";
    intro.textContent =
      "以下文件包含冲突标记。应用不会自动选择任何一侧，请逐文件编辑后暂存；全部解决后才能提交。";

    const list = document.createElement("div");
    list.className = "git-conflict-list";
    for (const file of files) {
      const row = document.createElement("div");
      row.className = "git-conflict-row";
      const name = document.createElement("span");
      name.className = "git-conflict-name";
      name.textContent = file.relative;
      name.title = file.path;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "git-action-btn";
      open.textContent = "打开";
      open.addEventListener("click", () => onOpenFile(file.path));
      row.append(name, open);
      list.append(row);
    }

    const steps = document.createElement("div");
    steps.className = "git-conflict-steps";
    steps.innerHTML =
      "<p>1. 打开文件，处理 <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> / <code>=======</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> 标记；</p>" +
      "<p>2. 对每个已解决文件执行 <code>git add &lt;文件&gt;</code>（也可在源代码管理里点「暂存」）；</p>" +
      "<p>3. 全部冲突文件标记为已解决后，填写提交信息并提交。</p>" +
      `<p class="git-conflict-root">仓库：<code>${escapeHtml(root)}</code></p>`;

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const terminal = document.createElement("button");
    terminal.type = "button";
    terminal.className = "primary";
    terminal.textContent = "在终端解决";
    terminal.addEventListener("click", () => onOpenTerminal(root));
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "关闭";
    done.addEventListener("click", () => this.close());
    actions.append(terminal, done);

    dialog.append(head, intro, list, steps, actions);
    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
