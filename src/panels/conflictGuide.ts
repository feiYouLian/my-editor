/**
 * Git 冲突处理引导：列出冲突文件、说明标记与命令，不在应用内自动合并。
 * 真正的编辑/暂存仍由用户完成，避免误操作覆盖冲突现场。
 */

import type { GitFileEntry } from "./gitView";
import { firstLine } from "../core/errors";
import { showErrorDialog } from "../ui/dialogs";

/** 冲突引导的外部动作：打开文件 / 跳到标记 / 标记已解决 / 在终端处理 */
export interface ConflictGuideActions {
  onOpenFile: (path: string) => void;
  onOpenTerminal: (dir: string) => void;
  /** 对该文件执行 git add（标记为已解决）；失败时抛错，由对话框提示 */
  onMarkResolved: (file: GitFileEntry) => Promise<void>;
  /**
   * 跳到 `<<<<<<<` 标记：`after` 是上一次跳到的偏移（首次传 -1）。
   * 返回本次跳到的偏移；没有更多返回 -1。
   */
  onJumpToMarker: (after: number) => number;
}

export class ConflictGuideDialog {
  private backdrop: HTMLElement | null = null;

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(root: string, files: GitFileEntry[], deps: ConflictGuideActions): void {
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
      open.addEventListener("click", () => deps.onOpenFile(file.path));
      // 编辑完直接标记：等价于 git add，不需要切到源代码管理面板
      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.className = "git-action-btn";
      resolve.textContent = "标记已解决";
      resolve.title = "对该文件执行 git add；全部标记后仍需填写提交信息";
      resolve.addEventListener("click", () => {
        if (resolve.disabled) return;
        resolve.disabled = true;
        open.disabled = true;
        resolve.textContent = "标记中…";
        void deps.onMarkResolved(file).then(
          () => {
            row.classList.add("resolved");
            resolve.textContent = "已标记";
          },
          (e: unknown) => {
            resolve.disabled = false;
            open.disabled = false;
            resolve.textContent = "标记已解决";
            showErrorDialog("标记冲突文件失败", firstLine(e));
          },
        );
      });
      row.append(name, open, resolve);
      list.append(row);
    }

    const steps = document.createElement("div");
    steps.className = "git-conflict-steps";
    // 步骤文案全程用 DOM 构建：仓库路径走 textContent，天然转义，无需拼 HTML
    const code = (text: string): HTMLElement => {
      const el = document.createElement("code");
      el.textContent = text;
      return el;
    };
    const para = (...parts: (string | Node)[]): HTMLParagraphElement => {
      const p = document.createElement("p");
      p.append(...parts);
      return p;
    };
    steps.append(
      para(
        "1. 打开文件，处理 ",
        code("<<<<<<<"),
        " / ",
        code("======="),
        " / ",
        code(">>>>>>>"),
        " 标记；",
      ),
      para("2. 对每个已解决文件执行 ", code("git add <文件>"), "（也可在源代码管理里点「暂存」）；"),
      para("3. 全部冲突文件标记为已解决后，填写提交信息并提交。"),
    );
    const rootLine = document.createElement("p");
    rootLine.className = "git-conflict-root";
    rootLine.append("仓库：", code(root));
    steps.append(rootLine);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    // 跳到下一个标记：不必在长文件里肉眼找 <<<<<<<
    const hint = document.createElement("span");
    hint.className = "git-conflict-hint";
    let lastJump = -1;
    const jump = document.createElement("button");
    jump.type = "button";
    jump.textContent = "跳到下一个冲突标记";
    jump.addEventListener("click", () => {
      const pos = deps.onJumpToMarker(lastJump);
      if (pos < 0) {
        hint.textContent = "当前文件里没有更多 <<<<<<< 标记";
        return;
      }
      lastJump = pos;
      hint.textContent = "";
    });
    const terminal = document.createElement("button");
    terminal.type = "button";
    terminal.className = "primary";
    terminal.textContent = "在终端解决";
    terminal.addEventListener("click", () => deps.onOpenTerminal(root));
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "关闭";
    done.addEventListener("click", () => this.close());
    actions.append(hint, jump, terminal, done);

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
