/**
 * 状态栏左下角的 Git 入口（参考 VS Code 的状态栏分支区）：
 *
 *   〔⑂ main  ⟳ / ↓2↑1〕
 *
 * - 分支名点击 → 分支切换面板；
 * - 右侧同步图标点击 → 同步（先拉取，再推送）；有落后/领先时高亮，
 *   并显示 `↓落后` / `↑领先` 计数。
 *
 * 数据由 GitHost 推送（状态刷新后调用 update），本模块只负责渲染与交互，
 * 不直接调用 IPC（依赖方向 ui → panels 类型，无 store / 后端耦合）。
 */

import type { GitStatus } from "../panels/gitView";

export interface GitStatusItemDeps {
  /** 点击分支名：打开分支切换面板 */
  onPickBranch: () => void;
  /** 点击同步图标：拉取 + 推送 */
  onSync: () => void;
}

export class GitStatusItem {
  constructor(
    private root: HTMLElement,
    private branchEl: HTMLElement,
    private syncEl: HTMLElement,
    private deps: GitStatusItemDeps,
  ) {
    this.branchEl.addEventListener("click", () => this.deps.onPickBranch());
    // 冒泡到状态栏其它点击处理没有意义，这里独立响应并阻止冒泡
    this.syncEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deps.onSync();
    });
  }

  /** null / 非仓库 / 读取失败：整块隐藏（含分隔符） */
  update(status: GitStatus | null): void {
    const usable = status !== null && !status.error && status.branch !== "";
    this.root.classList.toggle("hidden", !usable);
    if (!usable || !status) return;

    this.branchEl.textContent = status.branch;
    this.branchEl.title = `当前分支：${status.branch}（点击切换）`;

    const parts: string[] = [];
    if (status.behind) parts.push(`↓${status.behind}`);
    if (status.ahead) parts.push(`↑${status.ahead}`);
    this.syncEl.textContent = parts.length > 0 ? parts.join("") : "⟳";
    this.syncEl.classList.toggle("attention", status.behind > 0);
    this.syncEl.title =
      status.behind > 0
        ? `同步：拉取 ${status.behind} 个提交并推送`
        : status.ahead > 0
          ? `同步：推送 ${status.ahead} 个提交`
          : "同步（拉取 + 推送）";
  }
}
