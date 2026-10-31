/**
 * 结构化只读视图：CSV/TSV 表格 + JSON 树。
 *
 * 定位是"看一眼结构"，不是编辑器替代品：
 * - 只读，不写盘，也不改标签内容；
 * - CSV 用固定行高的虚拟滚动（十万行只渲染视口内几十行）；
 * - JSON 按层懒展开，每层最多渲染 200 项，其余用「显示更多」继续加载。
 */

import { parseCsv, type CsvTable } from "../core/csv";
import {
  JSON_CHILD_LIMIT,
  childCount,
  kindOf,
  parseJsonForView,
  previewOf,
} from "../core/jsonView";

export type StructuredMode = "csv" | "json";

export interface StructuredSource {
  name: string;
  path: string | null;
  content: string;
}

export interface StructuredViewDeps {
  /** 当前标签的快照（无可用标签时返回 null） */
  getSource: () => StructuredSource | null;
  onMessage: (text: string) => void;
}

/** 行高必须与 CSS `.sv-row` 一致：虚拟滚动按它换算 translateY */
const ROW_HEIGHT = 26;
/** 视口外多渲染几行，滚动时不易看到空白 */
const OVERSCAN = 12;
const CSV_MAX_ROWS = 100_000;
const CSV_MAX_COLS = 200;
/** 计算列宽时参考的行数（全量扫描会拖慢打开） */
const WIDTH_SAMPLE_ROWS = 200;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 分隔符的可读展示（Tab / 竖线直接显示符号） */
function delimiterLabel(delimiter: string): string {
  return delimiter === "\t" ? "Tab" : delimiter;
}

export class StructuredView {
  private backdrop: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private tabButtons: HTMLButtonElement[] = [];
  private mode: StructuredMode = "csv";
  private source: StructuredSource | null = null;

  // ---- CSV 虚拟滚动状态 ----
  private table: CsvTable | null = null;
  private colWidths: number[] = [];
  private scroller: HTMLElement | null = null;
  private headScroll: HTMLElement | null = null;
  private rowsEl: HTMLElement | null = null;
  private rafId = 0;

  constructor(private deps: StructuredViewDeps) {}

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  /** 按扩展名猜默认视图；.json/.jsonc 走树，其余走表格 */
  static modeForName(name: string | null): StructuredMode {
    return name && /\.jsonc?$/i.test(name) ? "json" : "csv";
  }

  toggle(mode?: StructuredMode): void {
    if (this.isOpen) this.close();
    else this.open(mode);
  }

  open(mode?: StructuredMode): void {
    const source = this.deps.getSource();
    if (!source || source.content.trim() === "") {
      this.deps.onMessage("当前标签没有可预览的文本内容（只读视图 / 图片不支持）");
      return;
    }
    this.source = source;
    this.mode = mode ?? StructuredView.modeForName(source.name);
    if (!this.backdrop) this.buildShell();
    this.render();
  }

  close(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.backdrop?.remove();
    this.backdrop = null;
    this.scroller = null;
    this.rowsEl = null;
    this.table = null;
  }

  // ---- 骨架 ----

  private buildShell(): void {
    const backdrop = el("div", "sv-backdrop");
    const panel = el("div", "sv-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "结构化视图");

    const head = el("div", "sv-head");
    this.titleEl = el("span", "sv-title", "结构化视图");
    const tabs = el("div", "sv-tabs");
    for (const [mode, label] of [
      ["csv", "表格"],
      ["json", "JSON 树"],
    ] as Array<[StructuredMode, string]>) {
      const btn = el("button", "sv-tab", label) as HTMLButtonElement;
      btn.type = "button";
      btn.dataset.mode = mode;
      btn.addEventListener("click", () => {
        this.mode = mode;
        this.render();
      });
      this.tabButtons.push(btn);
      tabs.append(btn);
    }
    const readonly = el("span", "sv-readonly", "只读");
    readonly.title = "结构化视图不会修改文件内容";
    const close = el("button", "sv-close", "×") as HTMLButtonElement;
    close.type = "button";
    close.title = "关闭（Esc）";
    close.addEventListener("click", () => this.close());
    head.append(this.titleEl, tabs, readonly, close);

    this.bodyEl = el("div", "sv-body");
    this.statusEl = el("div", "sv-status");

    panel.append(head, this.bodyEl, this.statusEl);
    backdrop.append(panel);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;
    panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
  }

  private render(): void {
    const source = this.source;
    if (!source || !this.bodyEl || !this.statusEl) return;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.table = null;
    this.scroller = null;
    this.rowsEl = null;
    this.headScroll = null;
    this.bodyEl.innerHTML = "";
    this.statusEl.textContent = "";
    for (const btn of this.tabButtons) {
      btn.classList.toggle("active", btn.dataset.mode === this.mode);
    }
    if (this.titleEl) {
      this.titleEl.textContent = source.name;
      this.titleEl.title = source.path ?? source.name;
    }
    if (this.mode === "csv") this.renderCsv(source);
    else this.renderJson(source);
  }

  // ---- CSV 表格 ----

  private renderCsv(source: StructuredSource): void {
    const body = this.bodyEl!;
    // 十万行解析在几十毫秒量级；先让「解析中」这一帧画出来，避免点击后像卡住
    body.append(el("div", "sv-hint", "正在解析表格…"));
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      const table = parseCsv(source.content, { maxRows: CSV_MAX_ROWS, maxCols: CSV_MAX_COLS });
      this.table = table;
      body.innerHTML = "";
      if (table.rows.length === 0) {
        body.append(el("div", "sv-hint", "没有可显示的行"));
        return;
      }
      this.colWidths = this.measureColumns(table);
      this.buildGrid(table);
      this.renderTableWindow();
      const truncated = table.truncated ? " · 已截断" : "";
      this.statusEl!.textContent =
        `${table.totalRows} 行 × ${table.columnCount} 列` +
        ` · 分隔符 ${delimiterLabel(table.delimiter)}${truncated}`;
    });
  }

  /** 列宽：按前若干行的最长文本估算，限制在 60–320px，避免超宽列挤掉其它列 */
  private measureColumns(table: CsvTable): number[] {
    const widths: number[] = [];
    for (let col = 0; col < table.columnCount; col += 1) {
      let max = 4;
      const limit = Math.min(table.rows.length, WIDTH_SAMPLE_ROWS);
      for (let row = 0; row < limit; row += 1) {
        const text = table.rows[row][col] ?? "";
        max = Math.max(max, Math.min(text.length, 40));
      }
      widths.push(Math.min(320, Math.max(60, max * 7 + 18)));
    }
    return widths;
  }

  private buildGrid(table: CsvTable): void {
    const body = this.bodyEl!;
    const grid = el("div", "sv-grid");

    // 表头独立于滚动容器：横向滚动时同步 scrollLeft，纵向不跟着走
    const headScroll = el("div", "sv-head-scroll");
    const headRow = el("div", "sv-row sv-row-head");
    headRow.style.width = `${this.totalWidth()}px`;
    for (let col = 0; col < table.columnCount; col += 1) {
      const cell = el("div", "sv-cell", table.rows[0][col] ?? "");
      cell.style.width = `${this.colWidths[col]}px`;
      cell.title = table.rows[0][col] ?? "";
      headRow.append(cell);
    }
    headScroll.append(headRow);

    const scroller = el("div", "sv-scroll");
    const spacer = el("div", "sv-spacer");
    spacer.style.height = `${table.rows.length * ROW_HEIGHT}px`;
    spacer.style.width = `${this.totalWidth()}px`;
    const rows = el("div", "sv-rows");
    spacer.append(rows);
    scroller.append(spacer);
    scroller.addEventListener("scroll", () => {
      if (this.headScroll) this.headScroll.scrollLeft = scroller.scrollLeft;
      this.scheduleTableWindow();
    });

    grid.append(headScroll, scroller);
    body.append(grid);
    this.headScroll = headScroll;
    this.scroller = scroller;
    this.rowsEl = rows;
  }

  private totalWidth(): number {
    return this.colWidths.reduce((sum, w) => sum + w, 0);
  }

  private scheduleTableWindow(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.renderTableWindow();
    });
  }

  /** 只渲染视口附近的行走（数据在内存里，渲染量恒定） */
  private renderTableWindow(): void {
    const table = this.table;
    const scroller = this.scroller;
    const rowsEl = this.rowsEl;
    if (!table || !scroller || !rowsEl) return;

    const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(table.rows.length, first + visible);

    const frag = document.createDocumentFragment();
    for (let row = first; row < end; row += 1) {
      const tr = el("div", "sv-row");
      // 数据行全部按行号定位（首行同时也作为表头固定显示，保留它在数据里的原貌）
      tr.style.transform = `translateY(${row * ROW_HEIGHT}px)`;
      const cells = table.rows[row];
      for (let col = 0; col < this.colWidths.length; col += 1) {
        const text = cells[col] ?? "";
        const cell = el("div", "sv-cell", text);
        cell.style.width = `${this.colWidths[col]}px`;
        cell.title = text;
        tr.append(cell);
      }
      frag.append(tr);
    }
    rowsEl.replaceChildren(frag);
  }

  // ---- JSON 树 ----

  private renderJson(source: StructuredSource): void {
    const body = this.bodyEl!;
    const result = parseJsonForView(source.content);
    if (!result.ok) {
      body.append(el("div", "sv-hint sv-hint-error", result.error));
      this.statusEl!.textContent = "解析失败";
      return;
    }
    const tree = el("div", "sv-json");
    tree.append(this.jsonNode(null, result.value, 0));
    body.append(tree);
    const kind = kindOf(result.value);
    this.statusEl!.textContent =
      kind === "object" || kind === "array" ? `根节点 ${previewOf(result.value)}` : `根节点 ${kind}`;
  }

  /** 造一个节点：容器带折叠箭头与懒加载的子容器 */
  private jsonNode(key: string | null, value: unknown, depth: number): HTMLElement {
    const kind = kindOf(value);
    const isContainer = kind === "object" || kind === "array";
    const wrap = el("div", "sv-json-node");
    const row = el("div", "sv-json-row");
    row.classList.add(`sv-kind-${kind}`);
    row.style.paddingLeft = `${depth * 14 + 6}px`;

    const toggle = el("span", "sv-json-toggle", isContainer ? "▸" : "·");
    row.append(toggle);
    if (key !== null) {
      row.append(el("span", "sv-json-key", kind === "array" ? `[${key}]` : key));
      row.append(el("span", "sv-json-colon", ":"));
    }
    row.append(el("span", `sv-json-value sv-json-${kind}`, previewOf(value)));

    if (!isContainer) {
      wrap.append(row);
      return wrap;
    }

    const children = el("div", "sv-json-children hidden");
    let expanded = false;
    let shown = 0;
    const total = childCount(value);

    const loadMore = (): void => {
      children.querySelector(".sv-json-more")?.remove();
      const entries =
        kind === "array"
          ? (value as unknown[]).map((item, index) => [String(index), item] as const)
          : Object.entries(value as Record<string, unknown>);
      const next = entries.slice(shown, shown + JSON_CHILD_LIMIT);
      const frag = document.createDocumentFragment();
      for (const [childKey, childValue] of next) {
        frag.append(this.jsonNode(childKey, childValue, depth + 1));
      }
      children.append(frag);
      shown += next.length;
      const rest = total - shown;
      if (rest > 0) {
        const more = el("button", "sv-json-more", `显示更多（剩余 ${rest} 项）`) as HTMLButtonElement;
        more.type = "button";
        more.addEventListener("click", loadMore);
        more.style.marginLeft = `${(depth + 1) * 14 + 6}px`;
        children.append(more);
      }
    };

    toggle.addEventListener("click", () => {
      expanded = !expanded;
      toggle.textContent = expanded ? "▾" : "▸";
      children.classList.toggle("hidden", !expanded);
      if (expanded && shown === 0) loadMore();
    });
    // 点整行也能展开：箭头太小，行内空白区域都算点击区
    row.addEventListener("click", (e) => {
      if (e.target === toggle) return;
      toggle.click();
    });

    wrap.append(row, children);
    return wrap;
  }
}
