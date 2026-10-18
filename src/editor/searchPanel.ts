import type { EditorView } from "@codemirror/view";
import { getSearchQuery } from "@codemirror/search";
import { bookmarkAllMatches } from "./bookmarks";

/**
 * 搜索结果面板（设计文档 3.4）：列出所有命中行，双击跳转。
 * @codemirror/search 提供高亮/替换/面板，但不含"命中行列表"，
 * 按 spike 结论用 SearchCursor 枚举 + 自绘 DOM 面板实现，
 * 附带多文件结果二次过滤能力（当前作用于单文档结果列表）。
 */

interface MatchInfo {
  from: number;
  to: number;
  line: number;
  preview: string;
}

const MAX_MATCHES = 10000;
const MAX_PREVIEW = 200;

export class SearchResultsPanel {
  private matches: MatchInfo[] = [];
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private filterInput!: HTMLInputElement;

  constructor(
    private container: HTMLElement,
    private view: EditorView,
  ) {
    this.render();
    this.refresh();
  }

  private render(): void {
    this.container.innerHTML = "";
    this.container.classList.remove("hidden");

    const header = document.createElement("div");
    header.className = "search-results-header";

    const title = document.createElement("span");
    title.className = "search-results-title";
    title.textContent = "搜索结果";

    this.countEl = document.createElement("span");
    this.countEl.className = "search-results-count";
    this.countEl.textContent = "0 个结果";

    this.filterInput = document.createElement("input");
    this.filterInput.className = "search-results-filter";
    this.filterInput.type = "text";
    this.filterInput.placeholder = "在结果中二次过滤…";
    this.filterInput.addEventListener("input", () => this.renderList());

    const markBtn = document.createElement("button");
    markBtn.type = "button";
    markBtn.textContent = "标记书签";
    markBtn.addEventListener("click", () => bookmarkAllMatches(this.view));

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "search-results-close";
    closeBtn.textContent = "×";
    closeBtn.title = "关闭结果面板";
    closeBtn.addEventListener("click", () => this.destroy());

    header.append(title, this.countEl, this.filterInput, markBtn, closeBtn);

    this.listEl = document.createElement("div");
    this.listEl.className = "search-results-list";

    this.container.append(header, this.listEl);
  }

  /** 重新枚举当前搜索查询的命中 */
  refresh(): void {
    this.matches = [];
    const query = getSearchQuery(this.view.state);
    if (query) {
      const cursor = query.getCursor(this.view.state);
      for (let m = cursor.next(); !m.done; m = cursor.next()) {
        if (this.matches.length >= MAX_MATCHES) break;
        const line = this.view.state.doc.lineAt(m.value.from);
        this.matches.push({
          from: m.value.from,
          to: m.value.to,
          line: line.number,
          preview: line.text.trim().slice(0, MAX_PREVIEW),
        });
      }
    }
    this.renderList();
  }

  private renderList(): void {
    const filter = this.filterInput.value.trim().toLowerCase();
    const visible = filter
      ? this.matches.filter((m) => m.preview.toLowerCase().includes(filter))
      : this.matches;

    this.countEl.textContent = filter
      ? `${visible.length} / ${this.matches.length} 个结果`
      : `${this.matches.length} 个结果`;
    this.listEl.innerHTML = "";

    if (this.matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "search-results-empty";
      const hasQuery = getSearchQuery(this.view.state) !== null;
      empty.textContent = hasQuery ? "无命中" : "请先在查找面板（Ctrl+F）输入关键词";
      this.listEl.append(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of visible) {
      const item = document.createElement("div");
      item.className = "search-results-item";
      const ln = document.createElement("span");
      ln.className = "search-results-ln";
      ln.textContent = `L${m.line}`;
      const text = document.createElement("span");
      text.className = "search-results-text";
      text.textContent = m.preview || "(空行)";
      item.append(ln, text);
      item.addEventListener("dblclick", () => {
        this.view.dispatch({
          selection: { anchor: m.from, head: m.to },
          scrollIntoView: true,
        });
        this.view.focus();
      });
      frag.append(item);
    }
    this.listEl.append(frag);
  }

  destroy(): void {
    this.container.innerHTML = "";
    this.container.classList.add("hidden");
  }
}
