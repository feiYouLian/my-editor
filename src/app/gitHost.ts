/**
 * Git 编排：状态刷新（防抖 + 请求令牌）、暂存 / 取消暂存 / 提交、串行队列。
 *
 * 串行队列保证 stage/unstage/commit 与 status 不交错读取；
 * 刷新失败保留旧列表，只通过状态栏与视图顶部提示。
 * 渲染在 panels/gitView.ts，本模块不碰 DOM。
 */

import { invoke } from "@tauri-apps/api/core";
import type { GitCommit, GitFileEntry, GitStatus } from "../types/app";
import type { GitView } from "../panels/gitView";
import type { GitBranch } from "../panels/branchPicker";
import type { BlameReport } from "../panels/gitBlame";
import { addNotice } from "../store/noticeStore";
import { firstLine } from "../core/errors";
import { getConfig } from "../config/settings";
import { reportResult } from "./resultCenter";

export interface GitHostDeps {
  getRoot: () => string | null;
  view: GitView;
  showMessage: (text: string, durationMs?: number) => void;
  /** 命令失败（分支 / 拉取 / 推送 / 暂存 / 提交 / 放弃）：弹窗展示完整 stderr */
  onError?: (title: string, detail: string) => void;
  /** 状态就绪：文件绝对路径 → 状态字母（供文件树染色）+ 完整状态（供状态栏） */
  onStatus?: (files: Map<string, string>, status: GitStatus | null) => void;
  /** 切换分支 / 拉取 / 推送 / 放弃后磁盘内容变化：重载未编辑的标签与派生视图 */
  onWorkspaceChanged?: () => void;
}

export class GitHost {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;
  /** 串行队列：上一任务（读状态 / 写操作）完成后再执行下一个 */
  private queue: Promise<void> = Promise.resolve();

  constructor(private deps: GitHostDeps) {}

  /** Git 只读模式：所有写操作先过这里（后端按 config.json 再校验一次） */
  private writable(): boolean {
    if (!getConfig().git.readOnly) return true;
    this.deps.showMessage("Git 只读模式已开启：只能查看，不能暂存 / 提交 / 推送 / 放弃更改");
    return false;
  }

  /** UI 据此禁用写入类按钮并提示 */
  isReadOnly(): boolean {
    return getConfig().git.readOnly;
  }

  /** 防抖刷新：保存后 / 窗口聚焦 / 分区展开 */
  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, 300);
  }

  refresh(): void {
    const root = this.deps.getRoot();
    if (!root) {
      this.deps.view.update(null);
      // 工作区关闭：状态栏 Git 入口同步隐藏
      this.deps.onStatus?.(new Map(), null);
      return;
    }
    const id = ++this.requestId;
    this.enqueue(async () => {
      try {
        const status = await invoke<GitStatus>("git_status", { root });
        if (id !== this.requestId) return; // 过期结果丢弃
        this.deps.view.update(status);
        this.publishStatus(status);
      } catch (e) {
        if (id !== this.requestId) return;
        this.deps.view.fail(`读取 Git 状态失败：${firstLine(e)}`);
      }
    });
  }

  stage(entries: GitFileEntry[]): void {
    if (!this.writable()) return;
    this.act("暂存", async () => {
      await invoke("git_stage", {
        root: this.requireRoot(),
        paths: expandPaths(entries),
      });
    });
  }

  unstage(entries: GitFileEntry[]): void {
    if (!this.writable()) return;
    this.act("取消暂存", async () => {
      await invoke("git_unstage", {
        root: this.requireRoot(),
        paths: expandPaths(entries),
      });
    });
  }

  commit(message: string): void {
    if (!this.writable()) return;
    this.act("提交", async () => {
      const hash = await invoke<string>("git_commit", {
        root: this.requireRoot(),
        message,
      });
      this.deps.view.clearCommitMessage();
      reportResult({
        title: `已提交 ${hash.slice(0, 7)}`,
        hint: "提交只在本地仓库；要同步到远程需要再点「推送」",
        key: "git-commit",
      });
    });
  }

  /**
   * 放弃更改：后端按每个文件的实际状态恢复——
   * 工作区修改回退到索引、未跟踪与已暂存的新增文件删除。
   * 动作本身不可撤销，但后端会在覆盖 / 删除前把工作区内容快照到配置目录，
   * 所以结果里带回 `backupDir`：必须把「去哪儿找」说出来，否则备份等于没备份。
   * 确认交互由调用方（main.ts）负责，这里只管执行与刷新。
   */
  discard(entries: GitFileEntry[]): void {
    if (!this.writable()) return;
    this.act("放弃更改", async () => {
      const outcome = await invoke<{
        count: number;
        backupDir: string | null;
        skipped: number;
      }>("git_discard", {
        root: this.requireRoot(),
        paths: expandPaths(entries),
      });
      const skipNote = outcome.skipped > 0 ? `；${outcome.skipped} 个过大文件未备份` : "";
      reportResult({
        title: `已放弃 ${outcome.count} 个文件的更改`,
        path: outcome.backupDir ?? undefined,
        hint: outcome.backupDir
          ? `原内容已备份到上面的目录，需要找回时按文件名取${skipNote}`
          : `工作区已回退到索引状态，此操作不可撤销${skipNote}`,
        key: "git-discard",
      });
      this.deps.onWorkspaceChanged?.();
    });
  }

  /** 本地分支列表（切入面板时现取，避免陈旧） */
  async listBranches(): Promise<GitBranch[]> {
    return invoke<GitBranch[]>("git_branches", { root: this.requireRoot() });
  }

  checkout(branch: string): Promise<void> {
    if (!this.writable()) return Promise.resolve();
    return this.act(`切换到 ${branch}`, async () => {
      await invoke("git_checkout", { root: this.requireRoot(), branch });
      this.deps.showMessage(`已切换到 ${branch}`, 4000);
      this.deps.onWorkspaceChanged?.();
    });
  }

  /** 提交历史（只读；最新在前） */
  async listCommits(): Promise<GitCommit[]> {
    return invoke<GitCommit[]>("git_log", { root: this.requireRoot(), limit: 100 });
  }

  /** 单个提交的 stat + patch 文本（Rust 侧截断） */
  async showCommit(hash: string): Promise<string> {
    return invoke<string>("git_show_commit", { root: this.requireRoot(), hash });
  }

  /** 当前文件的逐行 blame（基于磁盘版本） */
  async blame(path: string): Promise<BlameReport> {
    return invoke<BlameReport>("git_blame", { path });
  }

  /** 新建分支；checkout=true 会切换过去 */
  createBranch(name: string, checkout: boolean): Promise<void> {
    if (!this.writable()) return Promise.resolve();
    return this.act("新建分支", async () => {
      await invoke("git_create_branch", {
        root: this.requireRoot(),
        branch: name,
        checkout,
      });
      this.deps.showMessage(checkout ? `已新建并切换到 ${name}` : `已新建分支 ${name}`, 4000);
      if (checkout) this.deps.onWorkspaceChanged?.();
    });
  }

  /** 删除本地分支（未合并时由 git 拒绝） */
  deleteBranch(name: string, force = false): Promise<void> {
    if (!this.writable()) return Promise.resolve();
    return this.act("删除分支", async () => {
      await invoke("git_delete_branch", { root: this.requireRoot(), branch: name, force });
      this.deps.showMessage(`已删除分支 ${name}`, 4000);
    });
  }

  pull(): void {
    if (!this.writable()) return;
    this.act("拉取", async () => {
      const summary = await invoke<string>("git_pull", { root: this.requireRoot() });
      this.deps.showMessage(`拉取完成：${summary}`, 4000);
      this.deps.onWorkspaceChanged?.();
    });
  }

  push(): void {
    if (!this.writable()) return;
    this.act("推送", async () => {
      const summary = await invoke<string>("git_push", { root: this.requireRoot() });
      this.deps.showMessage(`推送完成：${summary}`, 4000);
      // 推送不改磁盘内容：只需状态刷新（act 已做），不重载标签
    });
  }

  /** 同步：先拉取（快进）再推送；任一步失败都会中断并弹窗 */
  sync(): void {
    this.act("同步", async () => {
      const root = this.requireRoot();
      const pulled = await invoke<string>("git_pull", { root });
      const pushed = await invoke<string>("git_push", { root });
      this.deps.showMessage(`同步完成：${pulled}，${pushed}`, 4000);
      this.deps.onWorkspaceChanged?.();
    });
  }

  private requireRoot(): string {
    const root = this.deps.getRoot();
    if (!root) throw new Error("请先打开工作区");
    return root;
  }

  /** 串行执行一次写操作，完成后立即刷新（不走防抖，避免读回旧状态） */
  private act(label: string, op: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      this.deps.view.setBusy(true);
      try {
        await op();
      } catch (e) {
        // git 的失败信息是多行 stderr：状态栏只放首行，完整内容进弹窗
        const detail = String(e).trim();
        const first = firstLine(detail);
        const title = `${label}失败`;
        console.warn(`[git] ${label}失败`, detail);
        this.deps.showMessage(`${title}：${first}`, 8000);
        this.deps.onError?.(title, detail);
        // 状态栏 8 秒后消失、弹窗一关就再无入口：进通知中心留一条可回看的记录
        addNotice(
          "gitFail",
          `${title}：${first}`,
          [{ label: "查看详情", run: () => this.deps.onError?.(title, detail) }],
          `git:${label}`,
        );
      } finally {
        // 失败也可能已部分改动磁盘（如放弃更改逐个执行中途失败）：统一重读一次
        try {
          await this.refreshNow();
        } catch (err) {
          console.warn("[git] 操作后刷新失败", err);
        }
        this.deps.view.setBusy(false);
      }
    });
  }

  private async refreshNow(): Promise<void> {
    const root = this.deps.getRoot();
    if (!root) return;
    const status = await invoke<GitStatus>("git_status", { root });
    this.deps.view.update(status);
    this.publishStatus(status);
  }

  /** 文件树染色 / 状态栏用：暂存组与更改组合并（工作区状态优先覆盖） */
  private publishStatus(status: GitStatus): void {
    const map = new Map<string, string>();
    if (!status.error) {
      for (const entry of status.staged) map.set(entry.path, entry.status);
      for (const entry of status.changes) map.set(entry.path, entry.status);
    }
    this.deps.onStatus?.(map, status);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }
}

/** 重命名条目同时传旧路径，保证 add / restore 能识别 */
function expandPaths(entries: GitFileEntry[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.orig_relative) out.add(entry.orig_relative);
    out.add(entry.relative);
  }
  return [...out];
}
