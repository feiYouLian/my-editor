/**
 * 底部 Git 历史面板（参考 IDEA 的 Log 工具窗）：
 * 左侧提交列表，右侧提交明细；作为终端/运行输出同级的非模态面板。
 */

import type { GitCommit } from "./gitView";
import { firstLine } from "../core/errors";

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
    this.detailEl = document.createElement("pre");
    this.detailEl.className = "git-history-panel-detail";
    this.detailEl.textContent = "选择提交查看补丁";
    body.append(this.listEl, this.detailEl);

    this.host.append(head, body);
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
      for (const commit of this.commits) {
        const item = document.createElement("div");
        item.className = `git-history-panel-item${commit.hash === this.selected ? " selected" : ""}`;
        item.title = `${commit.hash}\n${commit.author} · ${commit.date}`;
        const subject = document.createElement("div");
        subject.className = "git-history-panel-subject";
        subject.textContent = commit.subject;
        const meta = document.createElement("div");
        meta.className = "git-history-panel-meta";
        meta.textContent = `${commit.shortHash} · ${commit.author} · ${commit.date}`;
        item.append(subject, meta);
        if (commit.refs) {
          const refs = document.createElement("div");
          refs.className = "git-history-panel-refs";
          refs.textContent = commit.refs;
          item.append(refs);
        }
        item.addEventListener("click", () => void this.select(commit.hash));
        this.listEl.append(item);
      }
    }
    this.detailEl.textContent = this.detail || "选择提交查看补丁";
  }
}
