/**
 * 底部 Git 历史面板（参考 IDEA 的 Log 工具窗）：
 * 左侧提交列表，右侧提交明细；作为终端/运行输出同级的非模态面板。
 *
 * 头部固定说明范围与操作，空态/失败态都给下一步动作：
 * 历史面板是新用户最容易「看不懂在干什么」的地方，文案必须自己解释。
 */

import type { GitCommit } from "./gitView";
import { firstLine } from "../core/errors";

/** 提交行高（与 CSS .git-history-panel-item 一致）：虚拟化按固定行高定位窗口 */
const ROW_H = 40;
/** 上下各多渲染的行数：滚动时不至于露白 */
const OVERSCAN = 15;
/** 可视高度未知（未挂载 / 测试环境）时的最小渲染行数 */
const MIN_ROWS = 15;

export interface GitHistoryPanelDeps {
  load: () => Promise<GitCommit[]>;
  loadCommit: (hash: string) => Promise<string>;
  /** 空仓库时「去提交」：切到源代码管理并聚焦提交框 */
  onFocusCommit?: () => void;
  /** 导出当前提交的 .patch（由 app 层落到工作区根目录） */
  exportPatch?: (name: string, patch: string) => Promise<void>;
  /** 头部「?」：打开用户指南的 Git 一节 */
  onOpenHelp?: () => void;
}

export class GitHistoryPanel {
  private commits: GitCommit[] | null = null;
  private selected = "";
  private detail = "";
  private error = "";
  private seq = 0;
  private listEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private scopeEl: HTMLElement | null = null;
  private detailBarEl: HTMLElement | null = null;
  private detailMetaEl: HTMLElement | null = null;
  /** 当前列表的窗口重绘（滚动时调用；每次 render 更新） */
  private paintList: (() => void) | null = null;

  constructor(
    private host: HTMLElement,
    private deps: GitHistoryPanelDeps,
  ) {}

  get isOpen(): boolean {
    return !this.host.classList.contains("hidden");
  }

  mount(): void {
    this.host.innerHTML = "";
    this.host.className = "git-history-panel hidden";

    const head = document.createElement("div");
    head.className = "git-history-panel-head";
    const title = document.createElement("span");
    title.className = "git-history-panel-title";
    title.textContent = "Git 历史";
    // 范围与操作进头部：不点任何东西就知道看的是哪份数据、能怎么操作
    this.scopeEl = document.createElement("span");
    this.scopeEl.className = "git-history-panel-scope";
    this.scopeEl.textContent = "当前工作区 · ↑↓ 选择 / Enter 查看 / Esc 关闭";
    this.countEl = document.createElement("span");
    this.countEl.className = "git-history-panel-count";

    const help = document.createElement("button");
    help.type = "button";
    help.className = "gs-head-btn";
    help.textContent = "?";
    help.title = "查看「Git 日常」帮助";
    help.setAttribute("aria-label", "查看帮助");
    help.addEventListener("click", () => this.deps.onOpenHelp?.());

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "gs-head-btn";
    refresh.textContent = "⟳";
    refresh.title = "刷新提交历史";
    refresh.addEventListener("click", () => void this.load());
    const close = document.createElement("button");
    close.type = "button";
    close.className = "gs-head-btn";
    close.textContent = "✕";
    close.title = "关闭历史面板";
    close.setAttribute("aria-label", "关闭历史面板");
    close.addEventListener("click", () => this.hide());
    head.append(title, this.scopeEl, this.countEl, help, refresh, close);

    const body = document.createElement("div");
    body.className = "git-history-panel-body";
    this.listEl = document.createElement("div");
    this.listEl.className = "git-history-panel-list";
    // 键盘导航：列表可聚焦（↑↓ 选择 / Enter 查看 / Esc 关闭，与分支面板一致）
    this.listEl.tabIndex = 0;

    const detailWrap = document.createElement("div");
    detailWrap.className = "git-history-panel-detail-wrap";
    const bar = document.createElement("div");
    bar.className = "git-history-detail-bar";
    this.detailMetaEl = document.createElement("span");
    this.detailMetaEl.className = "git-history-detail-meta";
    this.detailBarEl = document.createElement("div");
    this.detailBarEl.className = "git-history-detail-actions";
    bar.append(this.detailMetaEl, this.detailBarEl);
    this.detailEl = document.createElement("pre");
    this.detailEl.className = "git-history-panel-detail";
    this.detailEl.textContent = this.emptyDetailText();
    detailWrap.append(bar, this.detailEl);

    body.append(this.listEl, detailWrap);
    this.host.append(head, body);

    // 滚动重绘窗口：监听器只挂一次，paintList 随 render 更新
    this.listEl.addEventListener("scroll", () => this.paintList?.(), { passive: true });
    this.host.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  private emptyDetailText(): string {
    return "选择一条提交查看它改了哪些文件：右侧是 diff 原文，可复制或导出为 .patch";
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      this.hide();
      return;
    }
    const commits = this.commits;
    if (!commits || commits.length === 0) return;
    if (e.key === "Enter") {
      if (this.selected) void this.select(this.selected);
      e.preventDefault();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const idx = commits.findIndex((c) => c.hash === this.selected);
    const next =
      e.key === "ArrowDown"
        ? Math.min(commits.length - 1, idx + 1)
        : Math.max(0, (idx < 0 ? 0 : idx) - 1);
    e.preventDefault();
    this.ensureVisible(next);
    void this.select(commits[next].hash);
  }

  /** 把第 index 行滚进可视区（虚拟化下必须显式对齐） */
  private ensureVisible(index: number): void {
    const list = this.listEl;
    if (!list) return;
    const top = index * ROW_H;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (top + ROW_H > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + ROW_H - list.clientHeight;
    }
  }

  open(): void {
    this.host.classList.remove("hidden");
    void this.load();
  }

  hide(): void {
    this.host.classList.add("hidden");
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    this.commits = null;
    this.selected = "";
    this.detail = "";
    this.error = "";
    this.render();
    try {
      const commits = await this.deps.load();
      if (seq !== this.seq) return;
      this.commits = commits;
      this.render();
      if (commits[0]) void this.select(commits[0].hash, seq);
    } catch (e) {
      if (seq !== this.seq) return;
      this.commits = [];
      this.error = `读取提交历史失败：${firstLine(e)}`;
      this.render();
    }
  }

  private async select(hash: string, seq = this.seq): Promise<void> {
    this.selected = hash;
    this.detail = "加载中…";
    this.render();
    try {
      const text = await this.deps.loadCommit(hash);
      if (seq !== this.seq || this.selected !== hash) return;
      this.detail = text;
    } catch (e) {
      if (seq !== this.seq || this.selected !== hash) return;
      this.detail = `读取提交详情失败：${firstLine(e)}`;
    }
    this.render();
  }

  /** diff 里「改了 N 个文件」的口径：git 的 diff --git 头计数 */
  private fileCountOf(detail: string): number {
    return detail.split("\n").filter((line) => line.startsWith("diff --git ")).length;
  }

  private render(): void {
    if (!this.listEl || !this.detailEl) return;
    if (this.countEl) {
      this.countEl.textContent = this.commits ? `· 最近 ${this.commits.length} 条` : "";
    }
    this.listEl.innerHTML = "";
    if (this.error) {
      const err = document.createElement("div");
      err.className = "git-empty";
      err.textContent = this.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "git-empty-action";
      retry.textContent = "重试";
      retry.addEventListener("click", () => void this.load());
      const help = document.createElement("button");
      help.type = "button";
      help.className = "git-empty-action";
      help.textContent = "检查是否为 Git 仓库";
      help.addEventListener("click", () => this.deps.onOpenHelp?.());
      const row = document.createElement("div");
      row.className = "git-empty-actions";
      row.append(retry, help);
      err.append(row);
      this.listEl.append(err);
    } else if (this.commits === null) {
      const loading = document.createElement("div");
      loading.className = "git-empty";
      loading.textContent = "加载提交历史…";
      this.listEl.append(loading);
    } else if (this.commits.length === 0) {
      const empty = document.createElement("div");
      empty.className = "git-empty";
      empty.textContent = "这个仓库还没有提交 · 可先在左侧提交一次，历史会从这里开始记录";
      const go = document.createElement("button");
      go.type = "button";
      go.className = "git-empty-action";
      go.textContent = "去提交";
      go.addEventListener("click", () => this.deps.onFocusCommit?.());
      const row = document.createElement("div");
      row.className = "git-empty-actions";
      row.append(go);
      empty.append(row);
      this.listEl.append(empty);
    } else {
      const commits = this.commits;
      const total = commits.length;
      // 虚拟化：spacer 撑出总高度，行窗口按滚动位置摆放——DOM 里只有可见的十几行，
      // 千条级历史滚动不掉帧（行高固定，与 CSS .git-history-panel-item 一致）
      const spacer = document.createElement("div");
      spacer.className = "git-history-panel-spacer";
      spacer.style.height = `${total * ROW_H}px`;
      const window = document.createElement("div");
      window.className = "git-history-panel-window";
      spacer.append(window);
      this.listEl.append(spacer);
      this.paintList = (): void => {
        const list = this.listEl;
        if (!list) return;
        const visible = Math.max(MIN_ROWS, Math.ceil(list.clientHeight / ROW_H));
        const start = Math.max(0, Math.floor(list.scrollTop / ROW_H) - OVERSCAN);
        const end = Math.min(total, start + visible + OVERSCAN * 2);
        const items: HTMLElement[] = [];
        for (let i = start; i < end; i++) items.push(this.itemFor(commits[i]));
        window.replaceChildren(...items);
        window.style.transform = `translateY(${start * ROW_H}px)`;
      };
      this.paintList();
    }
    this.renderDetail();
  }

  /** 详情区：一行「改了 N 个文件」+ 复制 / 导出动作，下面是 diff 原文 */
  private renderDetail(): void {
    if (!this.detailEl || !this.detailMetaEl || !this.detailBarEl) return;
    const detail = this.detail || this.emptyDetailText();
    this.detailEl.textContent = detail;

    // 后端返回 `git show --stat --patch`：commit 头与 stat 在前，补丁从第一个 diff --git 开始。
    // 复制与导出一律只取补丁部分，否则 git apply 会报「unrecognized input」。
    const patchStart = detail.indexOf("diff --git ");
    const patch = patchStart >= 0 ? detail.slice(patchStart) : "";
    const commit = this.commits?.find((c) => c.hash === this.selected);
    this.detailMetaEl.textContent = patch
      ? `这次提交改了 ${this.fileCountOf(patch)} 个文件 · 下面是 diff 原文`
      : "";
    this.detailBarEl.replaceChildren();

    if (!patch || !commit) return;

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "git-detail-btn";
    copy.textContent = "复制 diff";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(patch).then(
        () => {
          copy.textContent = "已复制";
          window.setTimeout(() => {
            copy.textContent = "复制 diff";
          }, 1500);
        },
        () => {
          copy.textContent = "复制失败";
        },
      );
    });
    this.detailBarEl.append(copy);

    if (this.deps.exportPatch) {
      const exportBtn = document.createElement("button");
      exportBtn.type = "button";
      exportBtn.className = "git-detail-btn";
      exportBtn.textContent = "导出为 .patch";
      exportBtn.title = "把这次提交的 diff 保存成 .patch 文件，可发给别人用 git apply 应用";
      exportBtn.addEventListener("click", () => {
        void this.deps.exportPatch?.(commit.shortHash, patch).catch((e) => {
          exportBtn.textContent = "导出失败";
          exportBtn.title = firstLine(e);
        });
      });
      this.detailBarEl.append(exportBtn);
    }
  }

  private itemFor(commit: GitCommit): HTMLElement {
    const item = document.createElement("div");
    item.className = `git-history-panel-item${commit.hash === this.selected ? " selected" : ""}`;
    item.title = `${commit.hash}\n${commit.author} · ${commit.date}${commit.refs ? `\n${commit.refs}` : ""}`;
    const subject = document.createElement("div");
    subject.className = "git-history-panel-subject";
    subject.textContent = commit.subject;
    const meta = document.createElement("div");
    meta.className = "git-history-panel-meta";
    // refs 并进 meta 行：行高固定才能量化滚动；完整 refs 在 title 里
    meta.textContent = [commit.shortHash, commit.author, commit.date, commit.refs]
      .filter(Boolean)
      .join(" · ");
    item.append(subject, meta);
    item.addEventListener("click", () => void this.select(commit.hash));
    return item;
  }
}
