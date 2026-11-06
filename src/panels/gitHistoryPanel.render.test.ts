import { describe, expect, it, vi } from "vitest";

import { GitHistoryPanel, type GitHistoryPanelDeps } from "./gitHistoryPanel";
import type { GitCommit } from "./gitView";

function commit(i: number): GitCommit {
  return {
    hash: `hash${String(i).padStart(4, "0")}`,
    shortHash: `hash${String(i).padStart(4, "0")}`.slice(0, 7),
    author: "作者",
    date: "2026-01-01",
    refs: i === 0 ? "HEAD -> main" : "",
    subject: `提交 ${i}`,
  };
}

function makePanel(
  commits: GitCommit[],
  overrides: Partial<GitHistoryPanelDeps> = {},
): {
  host: HTMLElement;
  deps: GitHistoryPanelDeps;
  panel: GitHistoryPanel;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const deps: GitHistoryPanelDeps = {
    load: vi.fn(async () => commits),
    loadCommit: vi.fn(async () => "diff --git a/x b/x"),
    onFocusCommit: vi.fn(),
    onOpenHelp: vi.fn(),
    exportPatch: vi.fn(async () => {}),
    ...overrides,
  };
  const panel = new GitHistoryPanel(host, deps);
  panel.mount();
  return { host, deps, panel };
}

/** 等 open() 的异步 load 完成一轮 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );
}

describe("gitHistoryPanel", () => {
  it("千条提交只渲染可见窗口，DOM 节点数受控（虚拟化）", async () => {
    const commits = Array.from({ length: 1000 }, (_, i) => commit(i));
    const { host, panel } = makePanel(commits);
    panel.open();
    await flush();
    const items = host.querySelectorAll(".git-history-panel-item");
    expect(items.length).toBeGreaterThan(0);
    // 总量 1000，窗口渲染上限约（最小行数 + 上下余量）——远小于总量即达标
    expect(items.length).toBeLessThanOrEqual(80);
    host.remove();
  });

  it("↑↓ 移动选中并加载详情，Enter 复看当前选中，Esc 关闭面板", async () => {
    const commits = [commit(0), commit(1), commit(2)];
    const { host, deps, panel } = makePanel(commits);
    panel.open();
    await flush();
    // 打开后默认选中第一条
    expect(deps.loadCommit).toHaveBeenCalledWith(commits[0].hash);

    host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flush();
    expect(deps.loadCommit).toHaveBeenCalledWith(commits[1].hash);
    expect(host.querySelector(".git-history-panel-item.selected .git-history-panel-subject")?.textContent).toBe("提交 1");

    host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await flush();
    expect(deps.loadCommit).toHaveBeenCalledWith(commits[0].hash);

    const before = vi.mocked(deps.loadCommit).mock.calls.length;
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(vi.mocked(deps.loadCommit).mock.calls.length).toBe(before + 1);

    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.classList.contains("hidden")).toBe(true);
    host.remove();
  });

  it("头部说明当前范围与键盘操作，空仓库空态给「去提交」", async () => {
    const { host, deps, panel } = makePanel([]);
    panel.open();
    await flush();

    const scope = host.querySelector(".git-history-panel-scope")?.textContent ?? "";
    expect(scope).toContain("当前工作区");
    expect(scope).toContain("↑↓");
    expect(host.querySelector(".git-history-panel-count")?.textContent).toContain("最近 0 条");

    const empty = host.querySelector(".git-empty")?.textContent ?? "";
    expect(empty).toContain("还没有提交");
    expect(empty).toContain("先");

    buttonByText(host, "去提交")?.click();
    expect(deps.onFocusCommit).toHaveBeenCalledTimes(1);
    host.remove();
  });

  it("详情区说明改了 N 个文件，复制与导出动作可触发", async () => {
    const commits = [commit(0)];
    const { host, deps, panel } = makePanel(commits);
    panel.open();
    await flush();

    expect(host.querySelector(".git-history-detail-meta")?.textContent).toContain("改了 1 个文件");

    buttonByText(host, "导出为 .patch")?.click();
    await flush();
    expect(deps.exportPatch).toHaveBeenCalledWith(commits[0].shortHash, "diff --git a/x b/x");
    host.remove();
  });

  it("读取失败给「重试」与「检查是否为 Git 仓库」两个自救入口", async () => {
    const load = vi.fn(async (): Promise<GitCommit[]> => {
      throw new Error("not a git repository");
    });
    const { host, deps, panel } = makePanel([], { load });
    panel.open();
    await flush();

    const empty = host.querySelector(".git-empty")?.textContent ?? "";
    expect(empty).toContain("读取提交历史失败");

    buttonByText(host, "重试")?.click();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    buttonByText(host, "检查是否为 Git 仓库")?.click();
    expect(deps.onOpenHelp).toHaveBeenCalledTimes(1);
    host.remove();
  });
});
