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
  /** 当前标签是否可用（大文件虚拟视图 / 图片没有大纲） */
  isAvailable: () => boolean;
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
      this.renderEmpty("当前标签不支持大纲（大文件只读视图 / 图片 / 未打开文件）");
      return;
    }
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
    const empty = document.createElement("div");
    empty.className = "sv-empty";
    empty.textContent = text;
    this.listEl.append(empty);
  }

  private renderItems(items: OutlineItem[]): void {
    this.listEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const item of items.slice(0, MAX_ITEMS)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "outline-item";
      row.style.paddingLeft = `${8 + item.depth * 12}px`;
      row.title = `L${item.line}: ${item.label}`;
      const label = document.createElement("span");
      label.className = "outline-label";
      label.textContent = item.label;
      const line = document.createElement("span");
      line.className = "outline-line";
      line.textContent = String(item.line);
      row.append(label, line);
      row.addEventListener("click", () => this.goto(item));
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
      const m = /^(#{1,6})\s+(.+)$/.exec(line.text);
      if (!m) continue;
      items.push({
        label: m[2].trim().slice(0, 120),
        line: i,
        pos: line.from,
        depth: m[1].length - 1,
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
