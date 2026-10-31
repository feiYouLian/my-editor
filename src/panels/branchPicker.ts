/**
 * 分支切换面板（参考 VS Code 的 Quick Pick）。
 *
 * 列出本地分支（当前分支置顶并由后端标记），输入框模糊过滤、
 * ↑↓ 选择、Enter 切换、Esc 关闭；视觉复用命令面板的 palette-* 样式。
 * 数据加载与切换动作经 deps 注入，本模块不直接调用 IPC。
 */

import { fuzzyScore } from "../core/fuzzy";
import { firstLine } from "../core/errors";

export interface GitBranch {
  name: string;
  current: boolean;
  ahead: number;
  behind: number;
}

export interface BranchPickerDeps {
  load: () => Promise<GitBranch[]>;
  onPick: (name: string) => void;
  /** 新建并切换分支（在左下角分支入口内完成，不弹对话框） */
  onCreate: (name: string) => Promise<void>;
  /** 删除本地分支（未合并时由 git 拒绝） */
  onDelete: (name: string) => Promise<void>;
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
  /** 当前渲染窗口在 visible 中的起始下标（选中项始终在窗口内） */
  private renderStart = 0;
  private loading = false;
  /** 上次渲染时的查询：查询变了要把选中项复位 */
  private lastQuery = "";
  /** 新建模式：输入框暂时充当新分支名 */
  private creating = false;
  private pendingDelete = "";

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

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "palette-create";
    createBtn.textContent = "＋ 新建分支";
    createBtn.title = "新建并切换到新分支";
    createBtn.addEventListener("click", () => this.startCreate());

    const list = document.createElement("div");
    list.className = "palette-list";

    const hint = document.createElement("div");
    hint.className = "palette-hint";

    box.append(input, createBtn, list, hint);
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
    this.creating = false;
    this.pendingDelete = "";

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
      this.deps.showMessage(`读取分支失败：${firstLine(e)}`);
    } finally {
      this.loading = false;
      this.renderList();
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.creating) this.cancelCreate();
      else this.close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this.creating) {
        void this.create();
        return;
      }
      const branch = this.visible[this.selected];
      if (branch) this.pick(branch);
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      if (this.creating) return;
      e.preventDefault();
      this.move(1);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      if (this.creating) return;
      e.preventDefault();
      this.move(-1);
    }
  }

  private startCreate(): void {
    if (!this.input) return;
    this.creating = true;
    this.input.value = "";
    this.input.placeholder = "新分支名，Enter 创建并切换（Esc 取消）";
    this.input.focus();
    this.renderList();
  }

  private cancelCreate(): void {
    this.creating = false;
    this.pendingDelete = "";
    if (this.input) {
      this.input.value = "";
      this.input.placeholder = "切换分支…（输入分支名片段，Esc 关闭）";
      this.input.focus();
    }
    this.renderList();
  }

  private async create(): Promise<void> {
    const name = this.input?.value.trim() ?? "";
    if (!name) {
      this.deps.showMessage("请输入分支名");
      return;
    }
    try {
      await this.deps.onCreate(name);
      this.close();
    } catch {
      // GitHost 已提示错误；保留面板供用户修改名称
    }
  }

  private async removeBranch(name: string): Promise<void> {
    if (this.pendingDelete !== name) {
      this.pendingDelete = name;
      this.renderList();
      window.setTimeout(() => {
        if (this.pendingDelete === name) {
          this.pendingDelete = "";
          this.renderList();
        }
      }, 3000);
      return;
    }
    this.pendingDelete = "";
    try {
      await this.deps.onDelete(name);
      await this.reload();
    } catch {
      // GitHost 已提示错误
    }
  }

  private move(delta: number): void {
    if (this.visible.length === 0) return;
    this.selected = (this.selected + delta + this.visible.length) % this.visible.length;
    const idx = this.selected - this.renderStart;
    if (idx < 0 || idx >= MAX_RENDERED) {
      this.renderList();
      return;
    }
    this.updateSelection();
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
    if (this.creating) {
      this.listEl.innerHTML = "";
      this.hintEl.textContent = "输入新分支名后按 Enter 创建并切换；Esc 取消";
      return;
    }
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
    if (query !== this.lastQuery) {
      this.lastQuery = query;
      this.selected = 0;
    }
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
    const maxStart = Math.max(0, this.visible.length - MAX_RENDERED);
    this.renderStart = Math.max(
      0,
      Math.min(this.selected - Math.floor(MAX_RENDERED / 2), maxStart),
    );
    const slice = this.visible.slice(this.renderStart, this.renderStart + MAX_RENDERED);
    for (const [offset, branch] of slice.entries()) {
      const index = this.renderStart + offset;
      const item = document.createElement("div");
      item.className = `palette-item${index === this.selected ? " selected" : ""}`;

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
      if (!branch.current) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "palette-branch-delete";
        del.textContent = this.pendingDelete === branch.name ? "确认" : "×";
        del.title = this.pendingDelete === branch.name ? "再次点击确认删除" : "删除该本地分支";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.removeBranch(branch.name);
        });
        item.append(del);
      }
      item.addEventListener("click", () => this.pick(branch));
      item.addEventListener("mouseenter", () => {
        if (this.selected !== index) {
          this.selected = index;
          this.updateSelection();
        }
      });
      frag.append(item);
    }
    this.listEl.append(frag);

    if (this.visible.length > MAX_RENDERED) {
      const more = document.createElement("div");
      more.className = "palette-empty";
      more.textContent = `显示第 ${this.renderStart + 1}–${this.renderStart + slice.length} 条（共 ${this.visible.length} 条），↑↓ 继续选择或细化关键词`;
      this.listEl.append(more);
    }
    this.updateSelection();
  }

  private updateSelection(): void {
    if (!this.listEl) return;
    const idx = this.selected - this.renderStart;
    this.listEl.querySelectorAll(".palette-item").forEach((el, i) => {
      el.classList.toggle("selected", i === idx);
    });
    this.listEl.children[idx]?.scrollIntoView({ block: "nearest" });
  }
}
