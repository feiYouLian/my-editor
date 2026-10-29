/**
 * 侧栏大纲：Markdown 标题 / 代码符号（CM6 syntaxTree）→ 可点击跳转。
 *
 * 提取规则（v1，零新依赖）：
 * - Markdown：`#` 标题，按数量缩进；
 * - 其他语言：syntaxTree 命中常见声明节点，取首行文本（不深入子节点，避免重复）。
 * 超过 500 条截断，防止超大文件卡住侧栏渲染。
 */

import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { parseMarkdownHeading } from "../core/outlineText";
import { bindOpenGesture, selectRowIn } from "../ui/openGesture";

interface OutlineItem {
  label: string;
  line: number;
  pos: number;
  depth: number;
}

export interface OutlineDeps {
  getView: () => EditorView;
  /** 当前生效语言（markdown 走标题正则，其余走语法树） */
  getLanguage: () => string | null;
  /** 当前标签是否支持大纲（大文件虚拟视图 / 图片没有大纲） */
  isAvailable: () => boolean;
  /**
   * 编辑器里装的是不是当前标签的文档。
   * 切标签瞬间 `setState` 还没发生：此时既不能按旧文档渲染，也不能报"不支持"，
   * 只能先保持现状，等 `onDocLoaded` 再刷。
   */
  isDocReady?: () => boolean;
}

const MAX_ITEMS = 500;
const REFRESH_MS = 200;

/** 常见声明节点名（跨 JS/TS、Python、Java、Rust、Go 的并集） */
const SYMBOL_NODES = new Set([
  "FunctionDeclaration",
  "FunctionDefinition",
  "FunctionItem",
  "FunctionDecl",
  "MethodDeclaration",
  "ClassDeclaration",
  "ClassDefinition",
  "ClassItem",
  "InterfaceDeclaration",
  "InterfaceItem",
  "EnumDeclaration",
  "EnumItem",
  "TypeAliasDeclaration",
  "TypeDecl",
  "StructItem",
  "TraitItem",
  "ImplItem",
  "ModuleItem",
  "ObjectDeclaration",
]);

export class OutlineView {
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 已渲染的行（行号升序）：光标跟随用 */
  private rows: { line: number; el: HTMLElement }[] = [];
  /** 上次高亮的行，避免每次光标移动都重排 */
  private currentLine = -1;

  constructor(
    private host: HTMLElement,
    private deps: OutlineDeps,
  ) {
    this.render();
  }

  /** 文档 / 标签变化后防抖刷新（编辑期间不对每次按键重建列表） */
  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, REFRESH_MS);
  }

  refresh(): void {
    if (!this.deps.isAvailable()) {
      this.countEl.textContent = "";
      this.renderEmpty("当前标签不支持大纲（未打开文件 / 图片 / 大文件只读视图）");
      return;
    }
    // 文档还没切到当前标签（切标签瞬间）：保持现状，等 onDocLoaded 再刷。
    // 不能在这里报"不支持"——那会在每次切标签时闪一条误报。
    if (this.deps.isDocReady && !this.deps.isDocReady()) return;
    const view = this.deps.getView();
    if (view.state.doc.length === 0) {
      this.countEl.textContent = "";
      this.renderEmpty("当前文档为空");
      return;
    }
    const language = this.deps.getLanguage();
    const items =
      language === "markdown" ? this.markdownItems(view) : this.symbolItems(view);
    this.countEl.textContent = `${items.length} 项`;
    if (items.length === 0) {
      this.renderEmpty(
        language === "markdown" ? "没有标题" : "当前语言未识别到可导航的符号",
      );
      return;
    }
    this.renderItems(items);
  }

  private render(): void {
    this.host.innerHTML = "";

    this.countEl = document.createElement("div");
    this.countEl.className = "sv-count";

    this.listEl = document.createElement("div");
    this.listEl.className = "outline-list";

    this.host.append(this.countEl, this.listEl);
    this.renderEmpty("打开文件后显示大纲");
  }

  private renderEmpty(text: string): void {
    this.listEl.innerHTML = "";
    this.rows = [];
    this.currentLine = -1;
    const empty = document.createElement("div");
    empty.className = "sv-empty";
    empty.textContent = text;
    this.listEl.append(empty);
  }

  /**
   * 光标跟随：高亮"包含当前行的最后一个符号"（光标所在的章节 / 函数）。
   * 由 main 的光标回调驱动；只切 class + 必要时滚动，不重建列表。
   */
  followCursor(line: number): void {
    if (line === this.currentLine) return;
    this.currentLine = line;
    if (this.rows.length === 0) return;
    let index = -1;
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].line <= line) index = i;
      else break;
    }
    this.rows.forEach((row, i) => row.el.classList.toggle("current", i === index));
    if (index >= 0) this.rows[index].el.scrollIntoView({ block: "nearest" });
  }

  private renderItems(items: OutlineItem[]): void {
    this.listEl.innerHTML = "";
    this.rows = [];
    const frag = document.createDocumentFragment();
    for (const item of items.slice(0, MAX_ITEMS)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "outline-item";
      this.rows.push({ line: item.line, el: row });
      row.style.paddingLeft = `${8 + item.depth * 12}px`;
      row.title = `L${item.line}: ${item.label}`;
      const label = document.createElement("span");
      label.className = "outline-label";
      label.textContent = item.label;
      const line = document.createElement("span");
      line.className = "outline-line";
      line.textContent = String(item.line);
      row.append(label, line);
      bindOpenGesture(row, {
        onSelect: () => selectRowIn(row),
        onOpen: () => this.goto(item),
      });
      frag.append(row);
    }
    if (items.length > MAX_ITEMS) {
      const more = document.createElement("div");
      more.className = "sv-empty";
      more.textContent = `仅显示前 ${MAX_ITEMS} 项（共 ${items.length} 项）`;
      frag.append(more);
    }
    this.listEl.append(frag);
  }

  private goto(item: OutlineItem): void {
    const view = this.deps.getView();
    view.dispatch({
      selection: { anchor: item.pos },
      effects: EditorView.scrollIntoView(item.pos, { y: "start", yMargin: 8 }),
    });
    view.focus();
  }

  private markdownItems(view: EditorView): OutlineItem[] {
    const items: OutlineItem[] = [];
    const doc = view.state.doc;
    for (let i = 1; i <= doc.lines && items.length < MAX_ITEMS; i++) {
      const line = doc.line(i);
      // 行级解析抽到 core/outlineText.ts（纯函数，有单测）
      const heading = parseMarkdownHeading(line.text);
      if (!heading) continue;
      items.push({
        label: heading.label,
        line: i,
        pos: line.from,
        depth: heading.depth,
      });
    }
    return items;
  }

  private symbolItems(view: EditorView): OutlineItem[] {
    const items: OutlineItem[] = [];
    const tree = syntaxTree(view.state);
    tree.iterate({
      enter: (node) => {
        if (items.length >= MAX_ITEMS) return false;
        if (!SYMBOL_NODES.has(node.name)) return undefined;
        const lineInfo = view.state.doc.lineAt(node.from);
        items.push({
          label: lineInfo.text.trim().slice(0, 120) || node.name,
          line: lineInfo.number,
          pos: node.from,
          depth: 0,
        });
        // 不深入：方法/内部类不重复列出（v1 只要"能跳到定义"）
        return false;
      },
    });
    return items;
  }
}
