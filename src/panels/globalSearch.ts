import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 与 Rust search.rs 对应的类型 */
export interface SearchOptions {
  caseSensitive: boolean;
  useRegex: boolean;
  maxResults: number;
  maxFileBytes: number;
}

export interface MatchHit {
  path: string;
  name: string;
  line: number;
  column: number;
  before: string;
  matched: string;
  after: string;
  replacement: string;
}

export interface SearchOutcome {
  hits: MatchHit[];
  truncated: boolean;
  filesScanned: number;
  elapsedMs: number;
  cancelled: boolean;
}

export interface FileChange {
  path: string;
  name: string;
  count: number;
}

export interface ReplaceReport {
  filesChanged: number;
  totalReplacements: number;
  backups: string[];
  failures: { path: string; error: string }[];
}

export interface GlobalSearchDeps {
  getRoot: () => string | null;
  onOpenHit: (path: string, line: number) => void;
  onMessage: (text: string) => void;
}

const MAX_RESULTS = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 侧栏搜索视图：两个整行输入框（查找 / 替换）+ 行内开关，
 * 结果按文件分组，命中高亮；替换预览时被替换文本加下划线、替换内容高亮。
 */
export class GlobalSearchPanel {
  private queryInput!: HTMLInputElement;
  private replaceInput!: HTMLInputElement;
  private caseBtn!: HTMLButtonElement;
  private regexBtn!: HTMLButtonElement;
  private previewBtn!: HTMLButtonElement;
  private runBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private replaceBtn!: HTMLButtonElement;
  private statusEl!: HTMLDivElement;
  private resultsEl!: HTMLDivElement;
  private restoreBar!: HTMLDivElement;

  private caseOn = false;
  private regexOn = false;
  private previewOn = false;

  private searching = false;
  private lastBackups: string[] = [];
  private lastOutcome: SearchOutcome | null = null;
  private collapsed = new Set<string>();
  private unlisten: (() => void) | null = null;

  constructor(private host: HTMLElement, private deps: GlobalSearchDeps) {}

  mount(): void {
    this.host.innerHTML = "";

    // ---- 头部：标题 + 动作按钮 ----
    const head = document.createElement("div");
    head.className = "gs-head";
    const title = document.createElement("span");
    title.className = "gs-title";
    title.textContent = "搜索";

    this.runBtn = this.headButton("↻", "搜索（Enter）", () => void this.run());
    this.cancelBtn = this.headButton("■", "停止", () => void this.cancel());
    this.cancelBtn.classList.add("hidden");
    this.replaceBtn = this.headButton("⇄", "全部替换…", () => void this.replaceAll());

    head.append(title, this.runBtn, this.cancelBtn, this.replaceBtn);

    // ---- 查找行：输入框占满整行，右侧内嵌开关 ----
    const queryField = document.createElement("div");
    queryField.className = "gs-field";
    this.queryInput = document.createElement("input");
    this.queryInput.className = "gs-input";
    this.queryInput.placeholder = "搜索";
    this.queryInput.spellcheck = false;

    const queryInline = document.createElement("div");
    queryInline.className = "gs-inline";
    this.caseBtn = this.makeToggle("Aa", "区分大小写", () => {
      this.caseOn = !this.caseOn;
      this.syncToggles();
    });
    this.regexBtn = this.makeToggle(".*", "使用正则表达式", () => {
      this.regexOn = !this.regexOn;
      this.syncToggles();
    });
    queryInline.append(this.caseBtn, this.regexBtn);
    queryField.append(this.queryInput, queryInline);

    // ---- 替换行 ----
    const replaceField = document.createElement("div");
    replaceField.className = "gs-field";
    this.replaceInput = document.createElement("input");
    this.replaceInput.className = "gs-input gs-input-replace";
    this.replaceInput.placeholder = "替换（支持 $1 / $0）";
    this.replaceInput.spellcheck = false;

    const replaceInline = document.createElement("div");
    replaceInline.className = "gs-inline";
    this.previewBtn = this.makeToggle("预览", "在结果中预览替换效果", () => {
      this.previewOn = !this.previewOn;
      this.syncToggles();
      if (this.previewOn && this.replaceInput.value) void this.run();
      else this.renderOutcome(this.lastOutcome);
    });
    replaceInline.append(this.previewBtn);
    replaceField.append(this.replaceInput, replaceInline);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "gs-status";
    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "gs-results";

    this.restoreBar = document.createElement("div");
    this.restoreBar.className = "gs-actions hidden";
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.textContent = "还原备份";
    restoreBtn.addEventListener("click", () => void this.restore());
    this.restoreBar.append(restoreBtn);

    this.host.append(head, queryField, replaceField, this.statusEl, this.resultsEl, this.restoreBar);

    this.syncToggles();

    // ---- 事件 ----
    this.queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.run();
      }
    });
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.run();
      }
    });
  }

  private headButton(icon: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gs-head-btn";
    b.textContent = icon;
    b.title = title;
    b.addEventListener("click", run);
    return b;
  }

  private makeToggle(label: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gs-toggle";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", run);
    return b;
  }

  private syncToggles(): void {
    this.caseBtn.classList.toggle("active", this.caseOn);
    this.regexBtn.classList.toggle("active", this.regexOn);
    this.previewBtn.classList.toggle("active", this.previewOn);
  }

  private async ensureListener(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await listen<{ scanned: number; hits: number }>(
      "search://progress",
      (e) => {
        if (this.searching) {
          this.setStatus(`扫描中… 已检查 ${e.payload.scanned} 个文件，命中 ${e.payload.hits} 处`);
        }
      },
    );
  }

  isVisible(): boolean {
    return !this.host.classList.contains("hidden");
  }

  show(): void {
    this.host.classList.remove("hidden");
    this.queryInput.focus();
    this.queryInput.select();
  }

  hide(): void {
    this.host.classList.add("hidden");
  }

  toggle(): void {
    if (this.isVisible()) this.hide();
    else this.show();
  }

  private options(): SearchOptions {
    return {
      caseSensitive: this.caseOn,
      useRegex: this.regexOn,
      maxResults: MAX_RESULTS,
      maxFileBytes: MAX_FILE_BYTES,
    };
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private requireRoot(): string | null {
    const root = this.deps.getRoot();
    if (!root) {
      this.setStatus("请先打开一个目录（工作区）");
      this.deps.onMessage("搜索需要先打开工作区目录");
      return null;
    }
    return root;
  }

  private async run(): Promise<void> {
    const root = this.requireRoot();
    const query = this.queryInput.value;
    if (!root) return;
    if (!query) {
      this.setStatus("请输入搜索内容");
      return;
    }
    await this.ensureListener();
    this.searching = true;
    this.runBtn.classList.add("hidden");
    this.cancelBtn.classList.remove("hidden");
    this.resultsEl.innerHTML = "";
    this.setStatus("搜索中…");

    try {
      const outcome = await invoke<SearchOutcome>("search_in_files", {
        root,
        query,
        options: this.options(),
        replacement: this.replaceInput.value || null,
      });
      this.renderOutcome(outcome);
    } catch (e) {
      this.setStatus(`搜索失败：${String(e).split("\n")[0]}`);
    } finally {
      this.searching = false;
      this.runBtn.classList.remove("hidden");
      this.cancelBtn.classList.add("hidden");
    }
  }

  private async cancel(): Promise<void> {
    try {
      await invoke("cancel_search", {});
    } catch {
      // 取消失败无需提示
    }
  }

  private renderOutcome(outcome: SearchOutcome | null): void {
    this.lastOutcome = outcome;
    if (!outcome) return;

    const previewOn = this.previewOn;
    const files = new Set(outcome.hits.map((h) => h.path)).size;
    const tail = outcome.truncated ? `（仅显示前 ${MAX_RESULTS} 条）` : "";
    this.setStatus(
      `${files} 个文件中 ${outcome.hits.length} 个结果${
        outcome.cancelled ? "（已停止）" : ""
      }${tail}｜扫描 ${outcome.filesScanned} 个文件，${outcome.elapsedMs} ms`,
    );

    if (outcome.hits.length === 0) {
      this.resultsEl.innerHTML = '<div class="gs-empty">未找到结果</div>';
      return;
    }

    const groups = new Map<string, MatchHit[]>();
    for (const hit of outcome.hits) {
      const list = groups.get(hit.path);
      if (list) list.push(hit);
      else groups.set(hit.path, [hit]);
    }

    const frag = document.createDocumentFragment();
    for (const [path, hits] of groups) {
      const fileEl = document.createElement("div");
      fileEl.className = "gs-file";

      const head = document.createElement("div");
      head.className = "gs-file-head";
      head.title = path;

      const chevron = document.createElement("span");
      chevron.className = "gs-chevron";
      const isCollapsed = this.collapsed.has(path);
      chevron.textContent = isCollapsed ? "▸" : "▾";

      const fileName = document.createElement("span");
      fileName.className = "gs-file-name";
      fileName.textContent = hits[0].name;

      const badge = document.createElement("span");
      badge.className = "gs-badge";
      badge.textContent = `${hits.length}`;

      head.append(chevron, fileName, badge);
      head.addEventListener("click", () => {
        if (isCollapsed) this.collapsed.delete(path);
        else this.collapsed.add(path);
        this.renderOutcome(this.lastOutcome);
      });
      fileEl.append(head);

      if (!isCollapsed) {
        for (const hit of hits) fileEl.append(this.renderHit(hit, previewOn));
      }
      frag.append(fileEl);
    }
    this.resultsEl.innerHTML = "";
    this.resultsEl.append(frag);
  }

  private renderHit(hit: MatchHit, previewOn: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = previewOn ? "gs-hit gs-preview" : "gs-hit";

    const lineNo = document.createElement("span");
    lineNo.className = "gs-line";
    lineNo.textContent = `${hit.line}`;

    const text = document.createElement("span");
    text.className = "gs-text";
    text.append(document.createTextNode(hit.before));

    const matched = document.createElement("span");
    matched.className = "gs-match";
    matched.textContent = hit.matched;
    text.append(matched);

    if (previewOn && hit.replacement) {
      const ins = document.createElement("span");
      ins.className = "gs-ins";
      ins.textContent = hit.replacement;
      text.append(ins);
    }

    text.append(document.createTextNode(hit.after));
    row.append(lineNo, text);
    row.title = hit.path;
    row.addEventListener("click", () => this.deps.onOpenHit(hit.path, hit.line));
    return row;
  }

  private async replaceAll(): Promise<void> {
    const root = this.requireRoot();
    const query = this.queryInput.value;
    if (!root) return;
    if (!query) {
      this.setStatus("请输入搜索内容");
      return;
    }
    try {
      const changes = await invoke<FileChange[]>("preview_replace", {
        root,
        query,
        options: this.options(),
      });
      if (changes.length === 0) {
        this.setStatus("没有可替换的命中");
        return;
      }
      const selected = await this.confirmReplace(changes);
      if (!selected) return;

      const report = await invoke<ReplaceReport>("replace_in_files", {
        files: selected,
        query,
        replacement: this.replaceInput.value,
        options: this.options(),
        backup: true,
      });
      this.lastBackups = report.backups;
      this.restoreBar.classList.toggle("hidden", report.backups.length === 0);
      const failed = report.failures.length
        ? `，失败 ${report.failures.length} 个（${report.failures[0].error}）`
        : "";
      this.setStatus(
        `替换完成：${report.filesChanged} 个文件，共 ${report.totalReplacements} 处${failed}`,
      );
      this.deps.onMessage(`全局替换完成：${report.totalReplacements} 处`);
      await this.run();
    } catch (e) {
      this.setStatus(`替换失败：${String(e).split("\n")[0]}`);
    }
  }

  private confirmReplace(changes: FileChange[]): Promise<string[] | null> {
    return new Promise((resolve) => {
      if (document.querySelector(".dialog-backdrop")) {
        resolve(null);
        return;
      }
      const backdrop = document.createElement("div");
      backdrop.className = "dialog-backdrop";
      const dialog = document.createElement("div");
      dialog.className = "dialog";
      dialog.style.width = "min(560px, 92vw)";

      const total = changes.reduce((s, c) => s + c.count, 0);
      const title = document.createElement("h3");
      title.textContent = `将替换 ${changes.length} 个文件、共 ${total} 处`;
      dialog.append(title);

      const list = document.createElement("div");
      list.style.maxHeight = "40vh";
      list.style.overflow = "auto";
      list.style.margin = "6px 0";
      list.style.fontSize = "12px";
      const boxes: HTMLInputElement[] = [];
      for (const c of changes) {
        const row = document.createElement("label");
        row.style.display = "flex";
        row.style.gap = "8px";
        row.style.padding = "2px 0";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = true;
        box.dataset.path = c.path;
        const name = document.createElement("span");
        name.textContent = `${c.name}（${c.count} 处）`;
        name.title = c.path;
        const path = document.createElement("span");
        path.textContent = c.path;
        path.style.opacity = "0.5";
        path.style.marginLeft = "auto";
        path.style.maxWidth = "55%";
        path.style.overflow = "hidden";
        path.style.textOverflow = "ellipsis";
        path.style.whiteSpace = "nowrap";
        row.append(box, name, path);
        list.append(row);
        boxes.push(box);
      }
      dialog.append(list);

      const note = document.createElement("p");
      note.className = "dialog-text";
      note.textContent = "替换前会自动备份为 <文件>.bak，可在面板中一键还原。";
      dialog.append(note);

      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "取消";
      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "primary";
      okBtn.textContent = "替换";
      actions.append(cancelBtn, okBtn);
      dialog.append(actions);
      backdrop.append(dialog);
      document.body.append(backdrop);

      const done = (value: string[] | null) => {
        backdrop.remove();
        resolve(value);
      };
      cancelBtn.addEventListener("click", () => done(null));
      okBtn.addEventListener("click", () => {
        const picked = boxes.filter((b) => b.checked).map((b) => b.dataset.path ?? "");
        done(picked.length ? picked : null);
      });
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) done(null);
      });
      dialog.addEventListener("keydown", (e) => {
        if (e.key === "Escape") done(null);
      });
      okBtn.focus();
    });
  }

  private async restore(): Promise<void> {
    if (this.lastBackups.length === 0) return;
    try {
      const n = await invoke<number>("restore_backups", { files: this.lastBackups });
      this.lastBackups = [];
      this.restoreBar.classList.add("hidden");
      this.setStatus(`已从备份还原 ${n} 个文件`);
      this.deps.onMessage(`已还原 ${n} 个文件`);
      await this.run();
    } catch (e) {
      this.setStatus(`还原失败：${String(e).split("\n")[0]}`);
    }
  }
}
