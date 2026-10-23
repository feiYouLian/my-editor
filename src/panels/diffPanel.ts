/**
 * 差异视图面板：双栏对齐行 + 差异块导航 + 折叠未变动区段 + 导出补丁。
 * 内容与差异块由 Rust 端计算，前端只负责排版与导航。
 *
 * 分层：类型在 diffPanel/types.ts，行构建与分帧渲染在 diffPanel/render.ts，
 * 本文件只做对话框外壳、头部按钮、场景动作与导航状态。
 */

import type {
  DiffAction,
  DiffPayload,
  HunkAdopt,
} from "./diffPanel/types";
import { gapStarts, renderDiffRows } from "./diffPanel/render";

export type {
  DiffAction,
  DiffPayload,
  DiffRow,
  DiffSession,
  HunkAdopt,
  HunkRef,
} from "./diffPanel/types";

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
  /** 渲染代际：新渲染开始后旧的分帧任务立即作废 */
  private renderToken = 0;

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
      for (const gap of gapStarts(payload.rows)) this.expandedGaps.add(gap);
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
    // 作废未完成的分帧渲染，避免关闭后仍往旧 body 里 append
    this.renderToken++;
    this.backdrop?.remove();
    this.backdrop = null;
    this.payload = null;
  }

  private renderRows(): void {
    const payload = this.payload;
    if (!payload) return;
    renderDiffRows({
      body: this.body,
      payload,
      expandedGaps: this.expandedGaps,
      onExpandGap: (start) => {
        this.expandedGaps.add(start);
        this.renderRows();
      },
      token: this.renderToken,
      isStale: (token) => token !== this.renderToken,
    });
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
