import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../config/settings";
import {
  GitView,
  type GitFileEntry,
  type GitStatus,
  type GitViewDeps,
} from "./gitView";

function entry(overrides: Partial<GitFileEntry> = {}): GitFileEntry {
  return {
    path: "D:/ws/a.ts",
    relative: "a.ts",
    status: "M",
    orig_relative: null,
    ...overrides,
  };
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    root: "D:/ws",
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    error: "",
    truncated: false,
    ...overrides,
  };
}

function makeDeps(): GitViewDeps {
  return {
    onRefresh: vi.fn(),
    onOpenDiff: vi.fn(),
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onDiscard: vi.fn(),
    onCommit: vi.fn(),
    onOpenHistory: vi.fn(),
    onResolveConflicts: vi.fn(),
    onOpenFile: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyRelative: vi.fn(),
    onReveal: vi.fn(),
    onOpenTerminal: vi.fn(),
  };
}

function mount(deps = makeDeps()): { host: HTMLElement; view: GitView } {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, view: new GitView(host, deps) };
}

function commitButton(host: HTMLElement): HTMLButtonElement {
  const btn = host.querySelector<HTMLButtonElement>(".git-commit-btn");
  if (!btn) throw new Error("提交按钮未渲染");
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = "";
  getConfig().git.readOnly = false;
});

afterEach(() => {
  getConfig().git.readOnly = false;
});

describe("GitView 状态渲染", () => {
  it("无工作区：给出下一步，提交按钮说明为什么不能点", () => {
    const { host, view } = mount();
    view.update(null);
    expect(host.textContent).toContain("未打开工作区：打开目录后自动读取 Git 状态");
    expect(commitButton(host).disabled).toBe(true);
    expect(commitButton(host).title).toBe("先暂存要提交的更改");
  });

  it("干净仓库：显示「没有更改」", () => {
    const { host, view } = mount();
    view.update(status());
    expect(host.querySelector(".git-body")?.textContent).toContain("没有更改");
  });

  it("有暂存条目：填了提交信息才允许提交", () => {
    const { host, view } = mount();
    view.update(status({ staged: [entry()] }));

    expect(host.querySelectorAll(".git-row")).toHaveLength(1);
    expect(host.querySelector(".git-name")?.textContent).toBe("a.ts");
    expect(commitButton(host).disabled).toBe(true);
    expect(commitButton(host).title).toBe("填写提交信息后即可提交（Ctrl+Enter）");

    const message = host.querySelector<HTMLTextAreaElement>(".git-message")!;
    message.value = "fix: demo";
    message.dispatchEvent(new Event("input"));

    expect(commitButton(host).disabled).toBe(false);
  });

  it("冲突未解决：顶部横幅说明原因，并禁用提交", () => {
    const { host, view } = mount();
    view.update(status({ changes: [entry({ status: "U" })] }));

    expect(host.querySelector(".git-conflict-banner")?.textContent).toContain(
      "检测到 1 个冲突文件，提交前需先解决",
    );
    expect(commitButton(host).disabled).toBe(true);
    expect(commitButton(host).title).toContain("先处理冲突再提交");
  });

  it("只读模式：提交区退出布局，行内不渲染写入按钮", () => {
    getConfig().git.readOnly = true;
    const { host, view } = mount();
    view.update(status({ changes: [entry()] }));

    expect(commitButton(host).parentElement?.style.display).toBe("none");
    expect(host.querySelectorAll(".git-row-action")).toHaveLength(0);
  });

  it("行内只保留一个暂存图标，放弃更改只在右键菜单（B3 回归）", () => {
    const { host, view } = mount();
    view.update(status({ changes: [entry(), entry({ path: "D:/ws/b.ts", relative: "b.ts" })] }));

    expect(host.querySelectorAll(".git-row")).toHaveLength(2);
    expect(host.querySelectorAll(".git-row-action")).toHaveLength(2);
    expect(host.textContent).not.toContain("放弃更改");
  });

  it("菜单点击即关：动作先执行，菜单随后移除（0.6.1 回归）", () => {
    const deps = makeDeps();
    const { host, view } = mount(deps);
    const changed = entry();
    view.update(status({ changes: [changed] }));

    const row = host.querySelector<HTMLElement>(".git-row")!;
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );

    const menu = document.querySelector<HTMLElement>(".context-menu");
    if (!menu) throw new Error("右键菜单未出现");
    const item = [...menu.querySelectorAll<HTMLElement>(".context-menu-item")].find((el) =>
      el.textContent?.includes("暂存更改"),
    );
    if (!item) throw new Error("菜单项「暂存更改」缺失");

    item.click();

    expect(deps.onStage).toHaveBeenCalledTimes(1);
    expect(deps.onStage).toHaveBeenCalledWith([changed]);
    expect(document.querySelector(".context-menu")).toBeNull();
  });
});
