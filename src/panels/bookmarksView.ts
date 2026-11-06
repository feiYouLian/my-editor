/**
 * 侧栏「书签」分区：列出当前文档的书签（行号 + 内容摘要），点击跳转、× 删除。
 *
 * 书签本体存在编辑器的每文档 RangeSet（editor/bookmarks.ts），随文档变更自动重映射；
 * 本视图只读快照并转发动作，不持有自己的状态——否则会出现"列表与 gutter 不一致"。
 */

export interface BookmarksViewDeps {
  /** 当前标签（书签只对单个文档有意义；虚拟视图 / 图片不支持） */
  activeTab: () => { id: string; kind: string; virtual?: boolean } | null;
  /** 某文档的书签行号（升序，1 基） */
  linesOf: (docId: string) => number[];
  /** 某行文本（编辑器里不是该文档时返回空串） */
  lineText: (line: number) => string;
  onJump: (line: number) => void;
  onRemove: (line: number) => void;
}

/** 行文本摘要上限：侧栏很窄，太长没有意义（完整内容在 title 里） */
const PREVIEW_CHARS = 120;

export class BookmarksView {
  /**
   * 不在构造时渲染：装配阶段编辑器实例尚未就绪（取当前文档会撞 TDZ），
   * 由宿主在切分区 / 载入文档 / 书签变化时调用 refresh()。
   */
  constructor(
    private host: HTMLElement,
    private deps: BookmarksViewDeps,
  ) {}

  refresh(): void {
    const tab = this.deps.activeTab();
    this.host.innerHTML = "";
    if (!tab || tab.kind !== "text" || tab.virtual) {
      this.host.append(this.hint("当前标签不支持书签（只读视图 / 图片）"));
      return;
    }
    const lines = this.deps.linesOf(tab.id);
    if (lines.length === 0) {
      this.host.append(this.hint("先打开一个文件，按 Ctrl+F2 在当前行加书签，这里会按文档分组列出"));
      return;
    }

    const list = document.createElement("div");
    list.className = "bookmark-list";
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "bookmark-row";
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.title = `跳转到第 ${line} 行`;

      const no = document.createElement("span");
      no.className = "bookmark-no";
      no.textContent = String(line);

      const text = document.createElement("span");
      text.className = "bookmark-text";
      const raw = this.deps.lineText(line).trim();
      text.textContent = raw.slice(0, PREVIEW_CHARS) || "（空行）";
      text.title = raw;

      const del = document.createElement("span");
      del.className = "bookmark-del";
      del.textContent = "×";
      del.title = "删除该书签";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deps.onRemove(line);
      });

      row.append(no, text, del);
      row.addEventListener("click", () => this.deps.onJump(line));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.deps.onJump(line);
        }
      });
      list.append(row);
    }
    this.host.append(list);
  }

  private hint(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "sidebar-hint";
    el.textContent = text;
    return el;
  }
}
