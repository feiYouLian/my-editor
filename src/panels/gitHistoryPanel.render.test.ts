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

function makePanel(commits: GitCommit[]): {
  host: HTMLElement;
  deps: GitHistoryPanelDeps;
  panel: GitHistoryPanel;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const deps: GitHistoryPanelDeps = {
    load: vi.fn(async () => commits),
    loadCommit: vi.fn(async () => "diff --git a/x b/x"),
  };
  const panel = new GitHistoryPanel(host, deps);
  panel.mount();
  return { host, deps, panel };
}

/** 等 open() 的异步 load 完成一轮 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
});
