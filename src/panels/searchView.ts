/**
 * 侧栏工作区搜索：输入关键词 → Rust search_workspace → 按文件分组展示。
 *
 * 结果点击跳转到对应行（复用 main.ts 的 openFileAt，含大文件分流）。
 * 请求号令牌：连续输入时丢弃过期结果，避免慢请求覆盖新结果。
 */

import { invoke } from "@tauri-apps/api/core";
import { getConfig } from "../config/settings";
import { confirmAction } from "../ui/dialogs";
import { bindOpenGesture, selectRowIn } from "../ui/openGesture";

interface SearchMatch {
  line: number;
  col: number;
  /** 命中前的行内文本（长行以省略号开头） */
  before: string;
  /** 命中的原文（预览时渲染为红色删除线） */
  hit: string;
  /** 命中后的行内文本（长行以省略号结尾） */
  after: string;
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

interface FileReplaceResult {
  path: string;
  relative: string;
  replaced: number;
  skipped_reason: string;
}

interface ReplaceReport {
  files: FileReplaceResult[];
  replaced_files: number;
  replaced_matches: number;
  /** 替换历史 id（空串 = 未保留历史，无法撤销） */
  history_id: string;
}

interface UndoSkip {
  relative: string;
  reason: string;
}

interface UndoReport {
  restored_files: number;
  restored_paths: string[];
  skipped: UndoSkip[];
}

export interface SearchViewDeps {
  getRoot: () => string | null;
  getIgnoreDirs: () => string[];
  onOpenLocation: (path: string, line: number) => void;
  /** 该路径是否有未保存的编辑器修改（批量替换前跳过，避免覆盖用户编辑） */
  isDirtyPath: (path: string) => boolean;
  /** 替换已写盘：同步已打开标签内容与文件树（新增 .bak 也要可见） */
  onFilesReplaced: (paths: string[]) => Promise<void>;
  /** durationMs 用于错误/跳过类提示停留更久 */
  showMessage: (text: string, durationMs?: number) => void;
}

const DEBOUNCE_MS = 300;
const MAX_FILES = 200;
const MAX_MATCHES = 2000;

/** 备份 / 临时文件：与后端 `replace_in_files` 的过滤保持一致 */
function isBackupPath(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  return name.endsWith(".bak") || name.endsWith(".tmp") || name.endsWith("~");
}

export class SearchView {
  private queryEl!: HTMLInputElement;
  private countEl!: HTMLElement;
  private listEl!: HTMLElement;
  private replaceEl!: HTMLInputElement;
  private replaceBtn!: HTMLButtonElement;
  private replaceRowEl!: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;
  private caseSensitive = false;
  private regexOn = false;
  /** 全词匹配：仅对 ASCII 查询生效（Rust 侧会忽略非 ASCII 查询的该开关） */
  private wholeWord = false;
  /** 已折叠的文件分组（按绝对路径记，刷新后仍保持折叠状态） */
  private collapsed = new Set<string>();
  /** 勾选要替换的文件（每次新搜索结果默认全选） */
  private selected = new Set<string>();
  private lastReport: SearchReport | null = null;
  private replaceOpen = false;
  private replacing = false;
  /** 上一次替换的历史 id（非空时结果区显示「撤销上次替换」） */
  private lastHistoryId = "";
  /** 上一次替换的跳过清单（显示在结果区顶部） */
  private notice = "";

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

  /** 带入关键词（编辑器选区）：填入并立即搜索；空串则退化为仅聚焦 */
  setQuery(text: string): void {
    const query = text.trim();
    if (!query) {
      this.focusInput();
      return;
    }
    this.queryEl.value = query;
    this.queryEl.focus();
    this.queryEl.select();
    void this.run();
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
    const wordBtn = makeToggle("ab", "全词匹配（仅对英文、数字等 ASCII 单词有效）", () => {
      this.wholeWord = !this.wholeWord;
      // 中文没有词边界：与其"勾了没反应"，不如当场说清楚
      const query = this.queryEl.value.trim();
      if (this.wholeWord && query && !/^[\x20-\x7e]+$/.test(query)) {
        this.deps.showMessage("全词匹配只对 ASCII 单词生效，当前查询含中文等字符，已按普通匹配处理");
      }
    });

    // 替换模式开关（默认收起，不改变现有搜索体验）
    const replaceToggle = document.createElement("button");
    replaceToggle.type = "button";
    replaceToggle.className = "sv-toggle";
    replaceToggle.textContent = "⇄";
    replaceToggle.title = "展开 / 收起替换行";
    replaceToggle.addEventListener("click", () => {
      this.replaceOpen = !this.replaceOpen;
      this.replaceRowEl.classList.toggle("hidden", !this.replaceOpen);
      replaceToggle.classList.toggle("active", this.replaceOpen);
      if (this.replaceOpen) this.replaceEl.focus();
      // 展开 / 收起时刷新行内预览样式
      this.renderList();
    });

    toolbar.append(this.queryEl, caseBtn, regexBtn, wordBtn, replaceToggle);

    // 替换行：输入框 + 全部替换（勾选文件后可用）
    this.replaceRowEl = document.createElement("div");
    this.replaceRowEl.className = "sv-replace hidden";
    this.replaceEl = document.createElement("input");
    this.replaceEl.type = "text";
    this.replaceEl.className = "sv-input";
    this.replaceEl.placeholder = "替换为…（正则模式支持 $1）";
    this.replaceEl.spellcheck = false;
    this.replaceEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.runReplace();
      }
    });
    // 替换文本变化：只重绘行内预览（不重新搜索）
    this.replaceEl.addEventListener("input", () => this.renderList());
    this.replaceBtn = document.createElement("button");
    this.replaceBtn.type = "button";
    this.replaceBtn.className = "sv-replace-btn";
    this.replaceBtn.textContent = "全部替换";
    this.replaceBtn.disabled = true;
    this.replaceBtn.addEventListener("click", () => void this.runReplace());
    this.replaceRowEl.append(this.replaceEl, this.replaceBtn);

    this.countEl = document.createElement("div");
    this.countEl.className = "sv-count";

    this.listEl = document.createElement("div");
    this.listEl.className = "sv-list";

    this.host.append(toolbar, this.replaceRowEl, this.countEl, this.listEl);
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
        wholeWord: this.wholeWord,
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
    this.lastReport = report;
    // 新结果默认全选，但备份/临时文件不选：替换它们会毁掉 .bak 回退能力
    this.selected = new Set(
      report.files.filter((f) => !isBackupPath(f.path)).map((f) => f.path),
    );
    this.countEl.textContent =
      `${report.files.length} 个文件 · ${report.total_matches} 处` +
      (report.truncated ? "（已截断，请细化关键词）" : "");
    this.renderList();
  }

  /**
   * 结果列表渲染（可重入）：替换输入变化时只重绘行内预览，不重新请求搜索。
   * 展开替换行且替换文本非空时，命中显示为红色删除线、替换内容绿色高亮。
   */
  private renderList(): void {
    const report = this.lastReport;
    if (!report) return;
    this.listEl.innerHTML = "";
    if (this.notice) {
      const note = document.createElement("div");
      note.className = "sv-notice";
      note.textContent = this.notice;
      this.listEl.append(note);
    }
    // 替换历史：一次替换对应一条可撤销记录（集中存于应用配置目录）
    if (this.lastHistoryId) {
      const bar = document.createElement("div");
      bar.className = "sv-history";
      const text = document.createElement("span");
      text.textContent = "已保留替换历史";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sv-replace-btn";
      btn.textContent = "撤销上次替换";
      btn.addEventListener("click", () => void this.undoLastReplace());
      bar.append(text, btn);
      this.listEl.append(bar);
    }
    if (report.files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sv-empty";
      empty.textContent = "无命中";
      this.listEl.append(empty);
      this.updateReplaceButton();
      return;
    }

    const frag = document.createDocumentFragment();
    for (const file of report.files) {
      const group = document.createElement("div");
      group.className = "sv-file";
      const folded = this.collapsed.has(file.path);
      if (folded) group.classList.add("collapsed");

      // 组头 = 复选框 + 折叠按钮（复选框不触发展开）
      const headRow = document.createElement("div");
      headRow.className = "sv-file-head";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = this.selected.has(file.path);
      check.title = isBackupPath(file.path)
        ? "备份/临时文件不参与替换（后端会拒绝）"
        : "勾选后参与批量替换";
      check.addEventListener("click", (e) => e.stopPropagation());
      check.addEventListener("change", () => {
        if (check.checked) this.selected.add(file.path);
        else this.selected.delete(file.path);
        this.updateReplaceButton();
      });

      const head = document.createElement("button");
      head.type = "button";
      head.className = "sv-file-toggle";
      head.title = file.path;
      const backupTag = isBackupPath(file.path) ? " · 备份" : "";
      head.textContent = `${folded ? "▸" : "▾"} ${file.relative} (${file.matches.length})${backupTag}`;
      head.addEventListener("click", () => {
        if (this.collapsed.has(file.path)) this.collapsed.delete(file.path);
        else this.collapsed.add(file.path);
        const isFolded = this.collapsed.has(file.path);
        group.classList.toggle("collapsed", isFolded);
        head.textContent = `${isFolded ? "▸" : "▾"} ${file.relative} (${file.matches.length})${backupTag}`;
      });
      headRow.append(check, head);

      const rows = document.createElement("div");
      rows.className = "sv-matches";
      // 展开替换行即预览（替换文本可为空 = 删除命中）；命中红色删除线，替换内容绿色高亮
      const showPreview = this.replaceOpen;
      const hasReplacement = this.replaceEl.value.length > 0;
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
        if (!match.before && !match.hit && !match.after) {
          text.textContent = "(空行)";
        } else {
          text.append(document.createTextNode(match.before));
          const hitEl = document.createElement("span");
          hitEl.className = showPreview ? "sv-hit" : "";
          hitEl.textContent = match.hit;
          text.append(hitEl);
          if (showPreview && hasReplacement) {
            const replEl = document.createElement("span");
            replEl.className = "sv-repl";
            replEl.textContent = this.expandReplacement(match.hit);
            text.append(replEl);
          }
          text.append(document.createTextNode(match.after));
        }
        row.append(ln, text);
        bindOpenGesture(row, {
          onSelect: () => selectRowIn(row),
          onOpen: () => this.deps.onOpenLocation(file.path, match.line),
        });
        rows.append(row);
      }
      if (file.truncated) {
        const more = document.createElement("div");
        more.className = "sv-empty";
        more.textContent = "（该文件命中过多，已截断）";
        rows.append(more);
      }

      group.append(headRow, rows);
      frag.append(group);
    }
    this.listEl.append(frag);
    this.updateReplaceButton();
  }

  /** 预览替换后的命中文本：正则模式按 JS 语义展开 $1（失败则原样显示模板） */
  private expandReplacement(hit: string): string {
    const replacement = this.replaceEl.value;
    if (!this.regexOn) return replacement;
    const query = this.queryEl.value.trim();
    if (!query) return replacement;
    try {
      const re = new RegExp(query, this.caseSensitive ? "" : "i");
      const out = hit.replace(re, replacement);
      // 命中片段单独匹配不上（如 ^ 或依赖上下文的断言）时退回模板原样
      return out === hit ? replacement : out;
    } catch {
      return replacement;
    }
  }

  /** 撤销上次替换：把历史快照写回原文件，再刷新标签 / 文件树 / 搜索结果 */
  private async undoLastReplace(): Promise<void> {
    const historyId = this.lastHistoryId;
    if (!historyId || this.replacing) return;
    const ok = await confirmAction("将把上次替换的文件还原为替换前内容，是否继续？");
    if (!ok) return;
    this.replacing = true;
    this.updateReplaceButton();
    try {
      const result = await invoke<UndoReport>("undo_replace", { historyId });
      this.lastHistoryId = "";
      if (result.restored_paths.length > 0) {
        await this.deps.onFilesReplaced(result.restored_paths);
      }
      const reasons = result.skipped.map((s) => `${s.relative}（${s.reason}）`);
      this.notice =
        reasons.length > 0 ? `撤销跳过 ${reasons.length} 个：${reasons.join("；")}` : "";
      this.deps.showMessage(
        `已撤销 ${result.restored_files} 个文件` +
          (reasons.length > 0 ? `；跳过 ${reasons.length} 个（见侧栏）` : ""),
        reasons.length > 0 ? 8000 : 4000,
      );
      await this.run();
    } catch (e) {
      this.deps.showMessage(`撤销失败: ${String(e).split("\n")[0]}`, 8000);
    } finally {
      this.replacing = false;
      this.updateReplaceButton();
    }
  }

  /** 替换按钮状态：文件数与命中数来自当前选择的文件 */
  private updateReplaceButton(): void {
    if (!this.replaceBtn) return;
    const files = this.lastReport?.files.filter((f) => this.selected.has(f.path)) ?? [];
    const matches = files.reduce((sum, f) => sum + f.matches.length, 0);
    this.replaceBtn.disabled = this.replacing || files.length === 0 || matches === 0;
    this.replaceBtn.textContent = this.replacing
      ? "替换中…"
      : files.length > 0
        ? `全部替换（${files.length}）`
        : "全部替换";
  }

  /** 批量替换：确认 → 调 Rust → 汇总 + 刷新结果 */
  private async runReplace(): Promise<void> {
    const root = this.deps.getRoot();
    const report = this.lastReport;
    const query = this.queryEl.value.trim();
    if (!root || !report || !query || this.replacing) return;
    const targets = report.files.filter((f) => this.selected.has(f.path));
    if (targets.length === 0) {
      this.deps.showMessage("请先勾选要替换的文件");
      return;
    }
    // 有未保存修改的文件不参与：磁盘替换后用户再保存会覆盖替换结果
    const dirty = targets.filter((t) => this.deps.isDirtyPath(t.path));
    const writable = targets.filter((t) => !this.deps.isDirtyPath(t.path));
    if (writable.length === 0) {
      this.deps.showMessage("选中的文件都有未保存修改，请先保存再替换");
      return;
    }
    const matches = writable.reduce((sum, f) => sum + f.matches.length, 0);
    const keepHistory = getConfig().globalReplace.backup;
    const removal = this.replaceEl.value.length === 0;
    const parts = [
      `将替换 ${writable.length} 个文件（共 ${matches} 处）`,
      removal ? "替换文本为空 = 删除命中内容" : "",
      keepHistory ? "保留替换历史（可撤销）" : "不保留替换历史",
      dirty.length > 0 ? `将跳过 ${dirty.length} 个有未保存修改的文件` : "",
    ].filter(Boolean);
    const ok = await confirmAction(`${parts.join("；")}。是否继续？`);
    if (!ok) return;

    this.replacing = true;
    this.updateReplaceButton();
    this.notice = "";
    try {
      const result = await invoke<ReplaceReport>("replace_in_files", {
        root,
        query,
        replacement: this.replaceEl.value,
        caseSensitive: this.caseSensitive,
        regex: this.regexOn,
        wholeWord: this.wholeWord,
        keepHistory,
        targets: writable.map((t) => t.path),
      });
      this.lastHistoryId = result.history_id;
      if (keepHistory && !result.history_id) {
        this.deps.showMessage("替换历史保留失败，本次替换无法撤销", 8000);
      }
      const skipped = result.files.filter((f) => f.skipped_reason);
      const replacedPaths = result.files
        .filter((f) => !f.skipped_reason)
        .map((f) => f.path);
      if (replacedPaths.length > 0) {
        // 磁盘已变更：先把已打开标签重载为新内容，再刷新搜索（否则编辑器显示旧内容）
        await this.deps.onFilesReplaced(replacedPaths);
      }
      const reasons = [
        ...dirty.map((d) => `${d.relative}（有未保存修改）`),
        ...skipped.map((s) => `${s.relative}（${s.skipped_reason}）`),
      ];
      this.notice =
        reasons.length > 0 ? `上次替换跳过 ${reasons.length} 个：${reasons.join("；")}` : "";
      this.deps.showMessage(
        `已替换 ${result.replaced_files} 个文件 / ${result.replaced_matches} 处` +
          (reasons.length > 0 ? `；跳过 ${reasons.length} 个（见侧栏）` : ""),
        reasons.length > 0 ? 8000 : 4000,
      );
      await this.run();
    } catch (e) {
      this.deps.showMessage(`替换失败: ${String(e).split("\n")[0]}`, 8000);
    } finally {
      this.replacing = false;
      this.updateReplaceButton();
    }
  }
}
