/**
 * 分支切换面板（参考 VS Code 的 Quick Pick）。
 *
 * 列出本地分支（当前分支置顶并由后端标记），输入框模糊过滤、
 * ↑↓ 选择、Enter 切换、Esc 关闭；视觉复用命令面板的 palette-* 样式。
 * 数据加载与切换动作经 deps 注入，本模块不直接调用 IPC。
 */

import { fuzzyScore } from "../core/fuzzy";

export interface GitBranch {
  name: string;
  current: boolean;
  ahead: number;
  behind: number;
}

export interface BranchPickerDeps {
  load: () => Promise<GitBranch[]>;
  onPick: (name: string) => void;
  showMessage: (text: string) => void;
}

/** 一次最多渲染的分支数（分支极多的仓库截断，靠输入过滤） */
const MAX_RENDERED = 200;

export class BranchPicker {
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;

  private branches: GitBranch[] = [];
  private visible: GitBranch[] = [];
  private selected = 0;
  private loading = false;

  constructor(private deps: BranchPickerDeps) {}

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  open(): void {
    if (this.overlay) {
      this.input?.focus();
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "palette-overlay";

    const box = document.createElement("div");
    box.className = "palette-box";

    const input = document.createElement("input");
    input.className = "palette-input";
    input.placeholder = "切换分支…（输入分支名片段，Esc 关闭）";
    input.addEventListener("input", () => this.renderList());
    input.addEventListener("keydown", (e) => this.onKeydown(e));

    const list = document.createElement("div");
    list.className = "palette-list";

    const hint = document.createElement("div");
    hint.className = "palette-hint";

    box.append(input, list, hint);
    overlay.append(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });
    document.body.append(overlay);

    this.overlay = overlay;
    this.input = input;
    this.listEl = list;
    this.hintEl = hint;
    this.branches = [];
    this.visible = [];
    this.selected = 0;

    this.renderList();
    input.focus();
    void this.reload();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.input = null;
    this.listEl = null;
    this.hintEl = null;
  }

  /** 每次打开现取：分支可能被外部终端改动 */
  private async reload(): Promise<void> {
    this.loading = true;
    this.renderList();
    try {
      this.branches = await this.deps.load();
    } catch (e) {
      this.branches = [];
      this.deps.showMessage(`读取分支失败：${String(e).split("\n")[0]}`);
    } finally {
      this.loading = false;
      this.renderList();
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const branch = this.visible[this.selected];
      if (branch) this.pick(branch);
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      this.move(1);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      this.move(-1);
    }
  }

  private move(delta: number): void {
    if (this.visible.length === 0) return;
    this.selected = (this.selected + delta + this.visible.length) % this.visible.length;
    this.renderList();
  }

  private pick(branch: GitBranch): void {
    if (branch.current) {
      this.close();
      return;
    }
    this.close();
    this.deps.onPick(branch.name);
  }

  private renderList(): void {
    if (!this.listEl || !this.hintEl) return;
    const query = this.input?.value.trim() ?? "";
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    // 多关键词 AND：与快速打开同一套打分，命中越靠前分数越高
    const scored = this.branches
      .map((branch) => {
        let score = 0;
        for (const word of words) {
          const part = fuzzyScore(word, branch.name);
          if (part === 0) return { branch, score: 0 };
          score += part;
        }
        return { branch, score: words.length === 0 ? 1 : score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => {
        // 当前分支始终置顶，其余按匹配得分
        if (a.branch.current !== b.branch.current) return a.branch.current ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return a.branch.name.localeCompare(b.branch.name);
      });

    this.visible = scored.map((s) => s.branch);
    this.selected = Math.min(this.selected, Math.max(0, this.visible.length - 1));
    this.listEl.innerHTML = "";

    if (this.loading) {
      this.hintEl.textContent = "正在读取分支…";
      return;
    }
    if (this.branches.length === 0) {
      this.hintEl.textContent = "没有本地分支（当前工作区可能不是 Git 仓库）";
      return;
    }
    if (this.visible.length === 0) {
      this.hintEl.textContent = "无匹配分支";
      return;
    }

    this.hintEl.textContent = `共 ${this.branches.length} 个分支 · ↑↓ 选择 · Enter 切换 · Esc 关闭`;

    const frag = document.createDocumentFragment();
    for (const [i, branch] of this.visible.slice(0, MAX_RENDERED).entries()) {
      const item = document.createElement("div");
      item.className = `palette-item${i === this.selected ? " selected" : ""}`;

      const name = document.createElement("span");
      name.textContent = branch.name;

      const tag = document.createElement("span");
      tag.className = "palette-shortcut";
      const parts: string[] = [];
      if (branch.current) parts.push("当前");
      if (branch.ahead) parts.push(`↑${branch.ahead}`);
      if (branch.behind) parts.push(`↓${branch.behind}`);
      tag.textContent = parts.join(" ");

      item.append(name, tag);
      item.addEventListener("click", () => this.pick(branch));
      item.addEventListener("mouseenter", () => {
        if (this.selected !== i) {
          this.selected = i;
          this.updateSelection();
        }
      });
      frag.append(item);
    }
    this.listEl.append(frag);

    if (this.visible.length > MAX_RENDERED) {
      const more = document.createElement("div");
      more.className = "palette-empty";
      more.textContent = `仅显示前 ${MAX_RENDERED} 条（共 ${this.visible.length} 条），请细化关键词`;
      this.listEl.append(more);
    }
    this.updateSelection();
  }

  private updateSelection(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll(".palette-item").forEach((el, idx) => {
      el.classList.toggle("selected", idx === this.selected);
    });
    this.listEl.children[this.selected]?.scrollIntoView({ block: "nearest" });
  }
}
