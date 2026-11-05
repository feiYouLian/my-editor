/**
 * 底部 Git 历史面板（参考 IDEA 的 Log 工具窗）：
 * 左侧提交列表，右侧提交明细；作为终端/运行输出同级的非模态面板。
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
    this.countEl = document.createElement("span");
    this.countEl.className = "git-history-panel-count";
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
    close.addEventListener("click", () => this.hide());
    head.append(title, this.countEl, refresh, close);

    const body = document.createElement("div");
    body.className = "git-history-panel-body";
    this.listEl = document.createElement("div");
    this.listEl.className = "git-history-panel-list";
    // 键盘导航：列表可聚焦（↑↓ 选择 / Enter 查看 / Esc 关闭，与分支面板一致）
    this.listEl.tabIndex = 0;
    this.detailEl = document.createElement("pre");
    this.detailEl.className = "git-history-panel-detail";
    this.detailEl.textContent = "选择提交查看补丁";
    body.append(this.listEl, this.detailEl);

    this.host.append(head, body);

    // 滚动重绘窗口：监听器只挂一次，paintList 随 render 更新
    this.listEl.addEventListener("scroll", () => this.paintList?.(), { passive: true });
    this.host.addEventListener("keydown", (e) => this.onKeyDown(e));
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

  private render(): void {
    if (!this.listEl || !this.detailEl) return;
    if (this.countEl) {
      this.countEl.textContent = this.commits ? `共 ${this.commits.length} 条` : "";
    }
    this.listEl.innerHTML = "";
    if (this.error) {
      const err = document.createElement("div");
      err.className = "git-empty";
      err.textContent = this.error;
      this.listEl.append(err);
    } else if (this.commits === null) {
      const loading = document.createElement("div");
      loading.className = "git-empty";
      loading.textContent = "加载提交历史…";
      this.listEl.append(loading);
    } else if (this.commits.length === 0) {
      const empty = document.createElement("div");
      empty.className = "git-empty";
      empty.textContent = "没有提交";
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
    this.detailEl.textContent = this.detail || "选择提交查看补丁";
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
