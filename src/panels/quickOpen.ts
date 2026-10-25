/**
 * 快速打开（Ctrl+P）：工作区文件模糊过滤 + 键盘选择。
 *
 * 数据来自 Rust `list_workspace_files`（尊重 .gitignore 与 ignoreDirs），
 * 30s 内存缓存；打开动作经 deps 交回 main.ts（含大文件分流）。
 * 视觉复用命令面板的 palette-* 样式，不引入新浮层体系。
 */

import { invoke } from "@tauri-apps/api/core";
import { fuzzyScore } from "../core/fuzzy";

interface WorkspaceFile {
  path: string;
  relative: string;
  name: string;
}

export interface QuickOpenDeps {
  getRoot: () => string | null;
  getIgnoreDirs: () => string[];
  onOpen: (path: string) => void;
  showMessage: (text: string) => void;
}

/** 文件列表缓存时长：工作区内的新增/删除通过重新打开面板刷新 */
const CACHE_TTL_MS = 30_000;
/** 列表一次最多渲染的条数 */
const MAX_RENDERED = 200;
/** 后端返回上限（超过只保留前 N 个，避免超大仓库撑爆内存） */
const FILE_LIMIT = 5000;

export class QuickOpen {
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;

  private files: WorkspaceFile[] = [];
  private root: string | null = null;
  private fetchedAt = 0;
  private loading = false;
  private visible: WorkspaceFile[] = [];
  private selected = 0;

  constructor(private deps: QuickOpenDeps) {}

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
    input.placeholder = "跳转到文件…（输入文件名或路径片段，Esc 关闭）";
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

    this.renderList();
    input.focus();
    void this.ensureFiles();
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.input = null;
    this.listEl = null;
    this.hintEl = null;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const file = this.visible[this.selected];
      if (file) this.pick(file);
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

  private pick(file: WorkspaceFile): void {
    this.close();
    this.deps.onOpen(file.path);
  }

  /** 拉取文件列表（30s 缓存；工作区根变化时强制重拉） */
  private async ensureFiles(): Promise<void> {
    const root = this.deps.getRoot();
    if (!root) {
      this.files = [];
      this.root = null;
      this.renderList();
      return;
    }
    const fresh =
      this.root === root &&
      this.files.length > 0 &&
      Date.now() - this.fetchedAt < CACHE_TTL_MS;
    if (fresh || this.loading) return;

    this.loading = true;
    try {
      const files = await invoke<WorkspaceFile[]>("list_workspace_files", {
        root,
        ignoreDirs: this.deps.getIgnoreDirs(),
        limit: FILE_LIMIT,
      });
      this.files = files;
      this.root = root;
      this.fetchedAt = Date.now();
    } catch (e) {
      this.files = [];
      this.deps.showMessage(`文件列表读取失败: ${String(e).split("\n")[0]}`);
    } finally {
      this.loading = false;
      // 面板可能在等待期间被关闭：renderList 内部对空引用已做保护
      this.renderList();
    }
  }

  private renderList(): void {
    if (!this.listEl || !this.hintEl) return;
    const query = this.input?.value.trim() ?? "";
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored = this.files
      .map((file) => {
        let score = 0;
        for (const word of words) {
          // 每个关键词都必须命中（AND 语义），否则 "src pre" 会命中整个 src
          const part = fuzzyScore(word, file.relative);
          if (part === 0) return { file, score: 0 };
          score += part;
        }
        return { file, score: words.length === 0 ? 1 : score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // 同分时路径更短的更可能是目标
        return a.file.relative.length - b.file.relative.length;
      });

    this.visible = scored.map((s) => s.file);
    this.selected = Math.min(this.selected, Math.max(0, this.visible.length - 1));
    this.listEl.innerHTML = "";

    if (!this.deps.getRoot()) {
      this.hintEl.textContent = "未打开工作区：先用「打开目录」选择一个文件夹";
      return;
    }
    if (this.loading && this.files.length === 0) {
      this.hintEl.textContent = "正在读取文件列表…";
      return;
    }
    if (this.visible.length === 0) {
      this.hintEl.textContent = this.files.length === 0 ? "工作区内没有可打开的文件" : "无匹配文件";
      return;
    }

    this.hintEl.textContent = `共 ${this.files.length} 个文件 · ↑↓ 选择 · Enter 打开 · Esc 关闭`;

    const frag = document.createDocumentFragment();
    for (const [i, file] of this.visible.slice(0, MAX_RENDERED).entries()) {
      const item = document.createElement("div");
      item.className = `palette-item${i === this.selected ? " selected" : ""}`;

      const name = document.createElement("span");
      name.textContent = file.name;

      const path = document.createElement("span");
      path.className = "palette-shortcut";
      path.textContent = file.relative;

      item.append(name, path);
      item.addEventListener("click", () => this.pick(file));
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
