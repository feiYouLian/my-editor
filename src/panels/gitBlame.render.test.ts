import { describe, expect, it, vi } from "vitest";

import { GitBlameDialog, type BlameLine, type BlameReport } from "./gitBlame";

function line(i: number): BlameLine {
  return {
    line: i + 1,
    hash: "a".repeat(40),
    shortHash: "aaaaaaa",
    author: "作者",
    authorTime: 1700000000,
    summary: `提交 ${i}`,
    content: `内容 ${i}`,
  };
}

describe("gitBlameDialog", () => {
  it("五千行只渲染可见窗口，DOM 节点数受控（虚拟化）", async () => {
    const report: BlameReport = {
      lines: Array.from({ length: 5000 }, (_, i) => line(i)),
      truncated: false,
    };
    const dialog = new GitBlameDialog();
    dialog.open("a.ts", async () => report, vi.fn(), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = document.querySelectorAll(".git-blame-row");
    expect(rows.length).toBeGreaterThan(0);
    // 总量 5000，窗口渲染上限约（最小行数 + 上下余量）
    expect(rows.length).toBeLessThanOrEqual(80);
    dialog.close();
  });

  it("点行跳转到对应行号并关闭对话框", async () => {
    const report: BlameReport = { lines: [line(0), line(1)], truncated: false };
    const onOpenLine = vi.fn();
    const dialog = new GitBlameDialog();
    dialog.open("a.ts", async () => report, onOpenLine, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    (document.querySelectorAll(".git-blame-row")[1] as HTMLElement).click();
    expect(onOpenLine).toHaveBeenCalledWith(2);
    expect(dialog.isOpen).toBe(false);
    dialog.close();
  });
});
