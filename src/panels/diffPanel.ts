/**
 * 差异视图：双栏对齐行 + 差异块导航 + 折叠未变动区段 + 导出补丁。
 * 内容与差异块由 Rust 端计算，前端只负责排版与导航。
 */

export interface DiffRow {
  kind: "equal" | "change" | "del" | "ins";
  oldNo: number | null;
  newNo: number | null;
  left: string;
  right: string;
}

export interface HunkRef {
  row: number;
  oldStart: number;
  newStart: number;
}

export interface DiffPayload {
  leftLabel: string;
  rightLabel: string;
  rows: DiffRow[];
  hunks: HunkRef[];
  added: number;
  removed: number;
  identical: boolean;
  /** 行尾差异（CRLF / LF）是否已被忽略 */
  newlineNormalized: boolean;
  patch: string;
}

/** 场景相关动作（由调用方决定语义，如「还原改动」「采用左侧」） */
export interface DiffAction {
  label: string;
  title?: string;
  run: () => void | Promise<void>;
}

/**
 * 差异块级「采用某一侧」。
 * side 为要采用的一侧；另一侧视为文档基线，采用后写回编辑器内容（由调用方实现）。
 */
export interface HunkAdopt {
  side: "left" | "right";
  /** 当前是否可执行（如标签有未保存改动时禁用） */
  enabled: () => boolean;
  /** 不可用时的解释（作为按钮 title） */
  title?: string;
  run: (hunkIndex: number) => void;
}

/** 未变动区段超过该行数时折叠 */
const COLLAPSE_OVER = 8;
const COLLAPSE_KEEP = 3;

export class DiffPanel {
  private backdrop: HTMLElement | null = null;
  private payload: DiffPayload | null = null;
  private actions: DiffAction[] = [];
  private adopt: HunkAdopt | null = null;
  private adoptBtn: HTMLButtonElement | null = null;
  private body!: HTMLElement;
  private navInfo!: HTMLElement;
  private currentHunk = -1;
  private expandedGaps = new Set<number>();
  private wrap = true;

  /** 当前展示的差异数据（供调用方在采用差异块后重新合并） */
  getPayload(): DiffPayload | null {
    return this.payload;
  }

  /** 打开差异视图；actions 为场景相关操作按钮，adopt 为差异块级采用（可选） */
  open(
    payload: DiffPayload,
    actions: DiffAction[] = [],
    adopt?: HunkAdopt,
    initialHunk?: number,
  ): void {
    this.close();
    this.payload = payload;
    this.actions = actions;
    this.adopt = adopt ?? null;
    this.adoptBtn = null;
    const last = payload.hunks.length - 1;
    this.currentHunk = payload.hunks.length
      ? Math.min(Math.max(initialHunk ?? 0, 0), last)
      : -1;
    this.expandedGaps.clear();

    const backdrop = document.createElement("div");
    backdrop.className = "diff-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "diff-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "差异比较");

    // ---- 头部 ----
    const head = document.createElement("div");
    head.className = "diff-head";

    const title = document.createElement("div");
    title.className = "diff-title";
    title.textContent = `${payload.leftLabel}  ⇄  ${payload.rightLabel}`;
    title.title = title.textContent;

    const stats = document.createElement("div");
    stats.className = "diff-stats";
    stats.append(
      Object.assign(document.createElement("span"), {
        className: "df-add",
        textContent: `+${payload.added}`,
      }),
      Object.assign(document.createElement("span"), {
        className: "df-del",
        textContent: `-${payload.removed}`,
      }),
    );

    this.navInfo = document.createElement("span");
    this.navInfo.className = "df-nav-info";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "df-btn";
    prevBtn.textContent = "▲";
    prevBtn.title = "上一处差异";
    prevBtn.disabled = payload.hunks.length === 0;
    prevBtn.addEventListener("click", () => this.gotoHunk(-1));

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "df-btn";
    nextBtn.textContent = "▼";
    nextBtn.title = "下一处差异";
    nextBtn.disabled = payload.hunks.length === 0;
    nextBtn.addEventListener("click", () => this.gotoHunk(1));

    const wrapBtn = document.createElement("button");
    wrapBtn.type = "button";
    wrapBtn.className = "df-btn df-btn-wide active";
    wrapBtn.textContent = "换行";
    wrapBtn.title = "长行换行显示 / 溢出裁剪";
    wrapBtn.addEventListener("click", () => {
      this.wrap = !this.wrap;
      wrapBtn.classList.toggle("active", this.wrap);
      this.body.classList.toggle("df-wrap", this.wrap);
    });

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "df-btn df-btn-wide";
    collapseBtn.textContent = "展开全部";
    collapseBtn.title = "展开所有未变动区段";
    collapseBtn.addEventListener("click", () => {
      for (const gap of this.gapStarts()) this.expandedGaps.add(gap);
      this.renderRows();
    });

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "df-btn df-btn-wide";
    exportBtn.textContent = "导出补丁";
    exportBtn.addEventListener("click", () => {
      const action = this.actions.find((a) => a.label.includes("导出"));
      void action?.run();
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "df-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭（Esc）";
    closeBtn.addEventListener("click", () => this.close());

    head.append(title, stats, this.navInfo, prevBtn, nextBtn, wrapBtn, collapseBtn, exportBtn, closeBtn);

    // ---- 场景动作 ----
    const extra = this.actions.filter((a) => !a.label.includes("导出"));
    if (extra.length) {
      const actionBar = document.createElement("div");
      actionBar.className = "diff-action-bar";
      for (const item of extra) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "df-btn df-btn-wide";
        btn.textContent = item.label;
        if (item.title) btn.title = item.title;
        btn.addEventListener("click", () => void item.run());
        actionBar.append(btn);
      }
      dialog.append(actionBar);
    }

    // ---- 差异块采用（块级合并：把当前差异块替换为某一侧内容） ----
    if (this.adopt) {
      const adoptBar = document.createElement("div");
      adoptBar.className = "diff-action-bar";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "df-btn df-btn-wide";
      btn.textContent = this.adopt.side === "left" ? "采用左侧" : "采用右侧";
      btn.title =
        this.adopt.title ??
        `把当前差异块替换为${this.adopt.side === "left" ? "左侧" : "右侧"}内容（写回编辑器，需手动保存）`;
      btn.addEventListener("click", () => {
        if (this.currentHunk >= 0) this.adopt?.run(this.currentHunk);
      });
      adoptBar.append(btn);
      dialog.append(adoptBar);
      this.adoptBtn = btn;
    }

    // ---- 主体 ----
    this.body = document.createElement("div");
    this.body.className = `diff-body${this.wrap ? " df-wrap" : ""}`;

    const hint = document.createElement("div");
    hint.className = "diff-note";
    const base = payload.identical
      ? "两侧内容完全一致"
      : "左侧为原内容，右侧为新内容；红底为删除 / 修改，绿底为新增 / 修改后。";
    hint.textContent = payload.newlineNormalized
      ? `${base}（行尾差异 CRLF / LF 已忽略）`
      : base;

    dialog.append(head, this.body, hint);
    backdrop.append(dialog);
    document.body.append(backdrop);

    this.backdrop = backdrop;
    this.renderRows();
    this.syncNav();

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      } else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        this.gotoHunk(1);
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        this.gotoHunk(-1);
      }
    });
    dialog.tabIndex = -1;
    dialog.focus();

    if (payload.hunks.length) this.scrollToHunk(0);
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
    this.payload = null;
  }

  private gapStarts(): number[] {
    const rows = this.payload?.rows ?? [];
    const starts: number[] = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].kind !== "equal") {
        i += 1;
        continue;
      }
      let j = i;
      while (j < rows.length && rows[j].kind === "equal") j += 1;
      if (j - i > COLLAPSE_OVER) starts.push(i);
      i = j;
    }
    return starts;
  }

  private renderRows(): void {
    const payload = this.payload;
    if (!payload) return;
    const frag = document.createDocumentFragment();
    const rows = payload.rows;
    const hunkOf = new Map<number, number>();
    payload.hunks.forEach((h, idx) => hunkOf.set(h.row, idx));

    const push = (index: number) => {
      const el = this.rowEl(rows[index]);
      const hunkIndex = hunkOf.get(index);
      if (hunkIndex !== undefined) el.dataset.hunk = `${hunkIndex}`;
      frag.append(el);
    };

    let i = 0;
    while (i < rows.length) {
      if (rows[i].kind === "equal") {
        let j = i;
        while (j < rows.length && rows[j].kind === "equal") j += 1;
        const run = j - i;
        if (run > COLLAPSE_OVER && !this.expandedGaps.has(i)) {
          for (let k = i; k < i + COLLAPSE_KEEP && k < j; k += 1) push(k);
          frag.append(this.gapEl(i, run - COLLAPSE_KEEP * 2));
          for (let k = j - COLLAPSE_KEEP; k < j; k += 1) push(k);
        } else {
          for (let k = i; k < j; k += 1) push(k);
        }
        i = j;
        continue;
      }
      push(i);
      i += 1;
    }

    this.body.innerHTML = "";
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "diff-hint";
      empty.textContent = "无可比较内容";
      this.body.append(empty);
      return;
    }
    this.body.append(frag);
  }

  private gapEl(start: number, hidden: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "df-gap";
    el.textContent = `⋯ 展开 ${hidden} 行未变动`;
    el.title = "点击展开该区段";
    el.addEventListener("click", () => {
      this.expandedGaps.add(start);
      this.renderRows();
    });
    return el;
  }

  private rowEl(row: DiffRow): HTMLElement {
    const el = document.createElement("div");
    el.className = `df-row df-${row.kind}`;
    if (row.kind !== "equal") el.dataset.change = "1";

    const leftNo = document.createElement("span");
    leftNo.className = "df-no";
    leftNo.textContent = row.oldNo === null ? "" : `${row.oldNo}`;

    const leftText = document.createElement("span");
    leftText.className = "df-cell df-left";
    leftText.textContent = row.left;
    if (row.kind === "del" || row.kind === "change") leftText.title = row.left;

    const rightNo = document.createElement("span");
    rightNo.className = "df-no";
    rightNo.textContent = row.newNo === null ? "" : `${row.newNo}`;

    const rightText = document.createElement("span");
    rightText.className = "df-cell df-right";
    rightText.textContent = row.right;
    if (row.kind === "ins" || row.kind === "change") rightText.title = row.right;

    el.append(leftNo, leftText, rightNo, rightText);
    return el;
  }

  private gotoHunk(delta: number): void {
    const hunks = this.payload?.hunks ?? [];
    if (hunks.length === 0) return;
    this.currentHunk = (this.currentHunk + delta + hunks.length) % hunks.length;
    this.scrollToHunk(this.currentHunk);
  }

  private scrollToHunk(index: number): void {
    const hunk = this.payload?.hunks[index];
    if (!hunk) return;
    this.currentHunk = index;
    this.syncNav();
    this.body
      .querySelector<HTMLElement>(`[data-hunk="${index}"]`)
      ?.scrollIntoView({ block: "center" });
  }

  private syncNav(): void {
    const total = this.payload?.hunks.length ?? 0;
    this.navInfo.textContent = total === 0 ? "无差异" : `第 ${this.currentHunk + 1} / ${total} 处`;
    if (this.adoptBtn) {
      this.adoptBtn.disabled = total === 0 || this.currentHunk < 0 || !this.adopt?.enabled();
    }
  }
}
