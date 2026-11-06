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
  HunkAction,
  HunkAdopt,
} from "./diffPanel/types";
import { gapStarts, renderDiffRows } from "./diffPanel/render";
import { showHelpDialog } from "./helpDialog";

export type {
  DiffAction,
  DiffPayload,
  DiffRow,
  DiffSession,
  HunkAction,
  HunkAdopt,
  HunkRef,
} from "./diffPanel/types";

export class DiffPanel {
  private backdrop: HTMLElement | null = null;
  private payload: DiffPayload | null = null;
  private actions: DiffAction[] = [];
  private adopt: HunkAdopt | null = null;
  private adoptBtn: HTMLButtonElement | null = null;
  private hunkAction: HunkAction | null = null;
  private hunkActionBtn: HTMLButtonElement | null = null;
  private body!: HTMLElement;
  private navInfo!: HTMLElement;
  private currentHunk = -1;
  private expandedGaps = new Set<number>();
  private wrap = true;
  /** 渲染代际：新渲染开始后旧的分帧任务立即作废 */
  private renderToken = 0;
  /** 目标 hunk 尚未渲染：等 onDone 后再跳转 */
  private pendingHunk: number | null = null;

  /** 当前展示的差异数据（供调用方在采用差异块后重新合并） */
  getPayload(): DiffPayload | null {
    return this.payload;
  }

  /** 打开差异视图；actions 为场景相关操作按钮，adopt 为差异块级采用（可选） */
  open(
    payload: DiffPayload,
    actions: DiffAction[] = [],
    adopt?: HunkAdopt,
    hunkAction?: HunkAction,
    initialHunk?: number,
  ): void {
    this.close();
    this.payload = payload;
    this.actions = actions;
    this.adopt = adopt ?? null;
    this.adoptBtn = null;
    this.hunkAction = hunkAction ?? null;
    this.hunkActionBtn = null;
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

    // 按钮文案直接取来源标签：四处「导出补丁」语义不同，不能都叫同一个名字
    const exportAction = this.actions.find((a) => a.label.includes("导出"));
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "df-btn df-btn-wide";
    exportBtn.textContent = exportAction?.label ?? "导出补丁";
    exportBtn.title = exportAction?.title ?? "把差异导出为 .patch 文件，不修改原文件";
    exportBtn.addEventListener("click", () => void exportAction?.run());

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "df-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭（Esc）";
    closeBtn.setAttribute("aria-label", "关闭差异面板");
    closeBtn.addEventListener("click", () => this.close());

    const helpBtn = document.createElement("button");
    helpBtn.type = "button";
    helpBtn.className = "df-btn";
    helpBtn.textContent = "?";
    helpBtn.title = "查看「对比两个文件」帮助";
    helpBtn.addEventListener("click", () => showHelpDialog("guide", "对比两个文件"));

    head.append(
      title,
      stats,
      this.navInfo,
      prevBtn,
      nextBtn,
      wrapBtn,
      collapseBtn,
      exportBtn,
      helpBtn,
      closeBtn,
    );

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

    // ---- 差异块操作（块级合并 / Git 暂存） ----
    if (this.adopt || this.hunkAction) {
      const adoptBar = document.createElement("div");
      adoptBar.className = "diff-action-bar";
      if (this.adopt) {
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
        this.adoptBtn = btn;
      }
      if (this.hunkAction) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "df-btn df-btn-wide";
        btn.textContent = this.hunkAction.label;
        if (this.hunkAction.title) btn.title = this.hunkAction.title;
        btn.addEventListener("click", () => {
          if (this.currentHunk >= 0) this.hunkAction?.run(this.currentHunk);
        });
        adoptBar.append(btn);
        this.hunkActionBtn = btn;
      }
      dialog.append(adoptBar);
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
    this.pendingHunk = null;
    this.backdrop?.remove();
    this.backdrop = null;
    this.payload = null;
  }

  private renderRows(): void {
    const payload = this.payload;
    if (!payload) return;
    // 每次重渲染都换一代：展开折叠段/采用差异块时，旧分帧任务必须立即作废
    this.renderToken += 1;
    const token = this.renderToken;
    renderDiffRows({
      body: this.body,
      payload,
      expandedGaps: this.expandedGaps,
      onExpandGap: (start) => {
        this.expandedGaps.add(start);
        this.renderRows();
      },
      token,
      isStale: (t) => t !== this.renderToken,
      onDone: () => {
        const pending = this.pendingHunk;
        if (pending !== null) {
          this.pendingHunk = null;
          this.scrollToHunk(pending);
        }
      },
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
    const target = this.body.querySelector<HTMLElement>(`[data-hunk="${index}"]`);
    if (target) {
      this.pendingHunk = null;
      target.scrollIntoView({ block: "center" });
      return;
    }
    // 行是分帧渲染的：目标还没构建出来，等 onDone 再跳
    this.pendingHunk = index;
  }

  private syncNav(): void {
    const total = this.payload?.hunks.length ?? 0;
    this.navInfo.textContent = total === 0 ? "无差异" : `第 ${this.currentHunk + 1} / ${total} 处`;
    if (this.adoptBtn) {
      this.adoptBtn.disabled = total === 0 || this.currentHunk < 0 || !this.adopt?.enabled();
    }
    if (this.hunkActionBtn) {
      this.hunkActionBtn.disabled =
        total === 0 || this.currentHunk < 0 || !this.hunkAction?.enabled();
    }
  }
}
