/**
 * 侧栏工作区搜索：输入关键词 → Rust search_workspace → 按文件分组展示。
 *
 * 结果点击跳转到对应行（复用 main.ts 的 openFileAt，含大文件分流）。
 * 请求号令牌：连续输入时丢弃过期结果，避免慢请求覆盖新结果。
 */

import { invoke } from "@tauri-apps/api/core";

interface SearchMatch {
  line: number;
  col: number;
  preview: string;
}

interface FileMatches {
  path: string;
  relative: string;
  matches: SearchMatch[];
  truncated: boolean;
}

interface SearchReport {
  files: FileMatches[];
  total_matches: number;
  truncated: boolean;
}

export interface SearchViewDeps {
  getRoot: () => string | null;
  getIgnoreDirs: () => string[];
  onOpenLocation: (path: string, line: number) => void;
  showMessage: (text: string) => void;
}

const DEBOUNCE_MS = 300;
const MAX_FILES = 200;
const MAX_MATCHES = 2000;

export class SearchView {
  private queryEl!: HTMLInputElement;
  private countEl!: HTMLElement;
  private listEl!: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;
  private caseSensitive = false;
  private regexOn = false;
  /** 已折叠的文件分组（按绝对路径记，刷新后仍保持折叠状态） */
  private collapsed = new Set<string>();

  constructor(
    private host: HTMLElement,
    private deps: SearchViewDeps,
  ) {
    this.render();
  }

  /** 菜单 / 快捷键入口：聚焦输入框并选中已有内容 */
  focusInput(): void {
    this.queryEl.focus();
    this.queryEl.select();
  }

  private render(): void {
    this.host.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "sv-toolbar";

    this.queryEl = document.createElement("input");
    this.queryEl.type = "text";
    this.queryEl.className = "sv-input";
    this.queryEl.placeholder = "搜索工作区（Enter 立即搜索）";
    this.queryEl.spellcheck = false;
    this.queryEl.addEventListener("input", () => this.schedule());
    this.queryEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.run();
      } else if (e.key === "Escape") {
        this.queryEl.value = "";
        this.countEl.textContent = "";
        this.renderEmpty("输入关键词搜索工作区（尊重 .gitignore 与忽略目录）");
      }
    });

    const makeToggle = (label: string, title: string, apply: () => void): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sv-toggle";
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", () => {
        apply();
        btn.classList.toggle("active");
        void this.run();
      });
      return btn;
    };
    const caseBtn = makeToggle("Aa", "区分大小写", () => {
      this.caseSensitive = !this.caseSensitive;
    });
    const regexBtn = makeToggle(".*", "使用正则表达式", () => {
      this.regexOn = !this.regexOn;
    });

    toolbar.append(this.queryEl, caseBtn, regexBtn);

    this.countEl = document.createElement("div");
    this.countEl.className = "sv-count";

    this.listEl = document.createElement("div");
    this.listEl.className = "sv-list";

    this.host.append(toolbar, this.countEl, this.listEl);
    this.renderEmpty("输入关键词搜索工作区（尊重 .gitignore 与忽略目录）");
  }

  private renderEmpty(text: string): void {
    this.listEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "sv-empty";
    empty.textContent = text;
    this.listEl.append(empty);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const query = this.queryEl.value.trim();
    const root = this.deps.getRoot();
    if (!root) {
      this.countEl.textContent = "";
      this.renderEmpty("未打开工作区：先用「打开目录」选择文件夹");
      return;
    }
    if (!query) {
      this.countEl.textContent = "";
      this.renderEmpty("输入关键词搜索工作区（尊重 .gitignore 与忽略目录）");
      return;
    }

    const id = ++this.requestId;
    this.countEl.textContent = "搜索中…";
    try {
      const report = await invoke<SearchReport>("search_workspace", {
        root,
        query,
        caseSensitive: this.caseSensitive,
        regex: this.regexOn,
        ignoreDirs: this.deps.getIgnoreDirs(),
        maxFiles: MAX_FILES,
        maxMatches: MAX_MATCHES,
      });
      if (id !== this.requestId) return; // 过期结果丢弃
      this.renderReport(report);
    } catch (e) {
      if (id !== this.requestId) return;
      this.countEl.textContent = "";
      this.renderEmpty(`搜索失败: ${String(e).split("\n")[0]}`);
      this.deps.showMessage("工作区搜索失败（详见侧栏提示）");
    }
  }

  private renderReport(report: SearchReport): void {
    this.countEl.textContent =
      `${report.files.length} 个文件 · ${report.total_matches} 处` +
      (report.truncated ? "（已截断，请细化关键词）" : "");
    this.listEl.innerHTML = "";
    if (report.files.length === 0) {
      this.renderEmpty("无命中");
      return;
    }

    const frag = document.createDocumentFragment();
    for (const file of report.files) {
      const group = document.createElement("div");
      group.className = "sv-file";
      const folded = this.collapsed.has(file.path);
      if (folded) group.classList.add("collapsed");

      const head = document.createElement("button");
      head.type = "button";
      head.className = "sv-file-head";
      head.title = file.path;
      head.textContent = `${folded ? "▸" : "▾"} ${file.relative} (${file.matches.length})`;
      head.addEventListener("click", () => {
        if (this.collapsed.has(file.path)) this.collapsed.delete(file.path);
        else this.collapsed.add(file.path);
        const isFolded = this.collapsed.has(file.path);
        group.classList.toggle("collapsed", isFolded);
        head.textContent = `${isFolded ? "▸" : "▾"} ${file.relative} (${file.matches.length})`;
      });

      const rows = document.createElement("div");
      rows.className = "sv-matches";
      for (const match of file.matches) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "sv-match";
        row.title = `L${match.line}:${match.col}`;
        const ln = document.createElement("span");
        ln.className = "sv-line";
        ln.textContent = String(match.line);
        const text = document.createElement("span");
        text.className = "sv-text";
        text.textContent = match.preview || "(空行)";
        row.append(ln, text);
        row.addEventListener("click", () => this.deps.onOpenLocation(file.path, match.line));
        rows.append(row);
      }
      if (file.truncated) {
        const more = document.createElement("div");
        more.className = "sv-empty";
        more.textContent = "（该文件命中过多，已截断）";
        rows.append(more);
      }

      group.append(head, rows);
      frag.append(group);
    }
    this.listEl.append(frag);
  }
}
