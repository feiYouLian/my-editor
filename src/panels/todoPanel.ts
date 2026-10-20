import { invoke } from "@tauri-apps/api/core";

/**
 * 侧栏 TODO 视图：扫描工作区内的 TODO / FIXME 等标记，按文件分组列出。
 * 样式复用搜索视图的 gs-* 类，保证与其它模块观感一致。
 */

/** 与 Rust todo.rs 对应 */
export interface TodoHit {
  path: string;
  name: string;
  /** 行号（1 基） */
  line: number;
  /** 命中的关键字（大写） */
  kind: string;
  /** 行内容（已去掉注释前缀） */
  text: string;
}

export interface TodoOutcome {
  items: TodoHit[];
  filesScanned: number;
  truncated: boolean;
}

export const DEFAULT_TODO_KEYWORDS = "TODO,FIXME,XXX,HACK";
const MAX_RESULTS = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface TodoPanelDeps {
  getRoot: () => string | null;
  onOpenHit: (path: string, line: number) => void;
}

export class TodoPanel {
  private keywordInput!: HTMLInputElement;
  private statusEl!: HTMLDivElement;
  private resultsEl!: HTMLDivElement;
  private readonly collapsed = new Set<string>();
  private running = false;

  constructor(private host: HTMLElement, private deps: TodoPanelDeps) {}

  mount(): void {
    this.host.innerHTML = "";

    const head = document.createElement("div");
    head.className = "gs-head";
    const title = document.createElement("span");
    title.className = "gs-title";
    title.textContent = "TODO";

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "gs-head-btn";
    runBtn.textContent = "↻";
    runBtn.title = "重新扫描（Enter）";
    runBtn.addEventListener("click", () => void this.run());

    head.append(title, runBtn);

    const field = document.createElement("div");
    field.className = "gs-field";
    this.keywordInput = document.createElement("input");
    this.keywordInput.className = "gs-input";
    this.keywordInput.placeholder = "关键字（逗号分隔）";
    this.keywordInput.spellcheck = false;
    this.keywordInput.value = DEFAULT_TODO_KEYWORDS;
    this.keywordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.run();
    });
    field.append(this.keywordInput);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "gs-status";

    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "gs-results";
    this.resultsEl.innerHTML = '<div class="gs-empty">打开工作区后点击 ↻ 扫描</div>';

    this.host.append(head, field, this.statusEl, this.resultsEl);
  }

  show(): void {
    this.host.classList.remove("hidden");
    void this.run();
  }

  hide(): void {
    this.host.classList.add("hidden");
  }

  /** 扫描并渲染（打开视图或点击 ↻ 时调用） */
  async run(): Promise<void> {
    if (this.running) return;
    const root = this.deps.getRoot();
    if (!root) {
      this.statusEl.textContent = "未打开工作区";
      this.resultsEl.innerHTML = '<div class="gs-empty">请先打开工作区目录</div>';
      return;
    }
    this.running = true;
    this.statusEl.textContent = "扫描中…";
    try {
      const keywords = this.keywordInput.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const outcome = await invoke<TodoOutcome>("scan_todos", {
        root,
        keywords,
        maxFileBytes: MAX_FILE_BYTES,
        maxResults: MAX_RESULTS,
      });
      this.render(outcome);
    } catch (e) {
      this.statusEl.textContent = `扫描失败：${String(e).split("\n")[0]}`;
    } finally {
      this.running = false;
    }
  }

  private render(outcome: TodoOutcome): void {
    const files = new Set(outcome.items.map((h) => h.path)).size;
    const tail = outcome.truncated ? `（仅显示前 ${MAX_RESULTS} 条）` : "";
    this.statusEl.textContent = `${files} 个文件中 ${outcome.items.length} 处标记${tail}｜扫描 ${outcome.filesScanned} 个文件`;

    if (outcome.items.length === 0) {
      this.resultsEl.innerHTML = '<div class="gs-empty">未找到标记</div>';
      return;
    }

    const groups = new Map<string, TodoHit[]>();
    for (const hit of outcome.items) {
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

      const isCollapsed = this.collapsed.has(path);
      const chevron = document.createElement("span");
      chevron.className = "gs-chevron";
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
        this.render(outcome);
      });
      fileEl.append(head);

      if (!isCollapsed) {
        for (const hit of hits) fileEl.append(this.renderHit(hit));
      }
      frag.append(fileEl);
    }

    this.resultsEl.innerHTML = "";
    this.resultsEl.append(frag);
  }

  /** 单条标记：行号 + 行内容（关键字高亮，与搜索命中的高亮一致） */
  private renderHit(hit: TodoHit): HTMLElement {
    const row = document.createElement("div");
    row.className = "gs-hit";
    row.title = `${hit.kind} · ${hit.path}:${hit.line}`;

    const lineNo = document.createElement("span");
    lineNo.className = "gs-line";
    lineNo.textContent = `${hit.line}`;

    const text = document.createElement("span");
    text.className = "gs-text";
    const at = hit.text.toUpperCase().indexOf(hit.kind);
    if (at >= 0) {
      text.append(document.createTextNode(hit.text.slice(0, at)));
      const match = document.createElement("span");
      match.className = "gs-match";
      match.textContent = hit.text.slice(at, at + hit.kind.length);
      text.append(match, document.createTextNode(hit.text.slice(at + hit.kind.length)));
    } else {
      text.textContent = hit.text;
    }

    row.append(lineNo, text);
    row.addEventListener("click", () => this.deps.onOpenHit(hit.path, hit.line));
    return row;
  }
}
