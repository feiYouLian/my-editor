import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompareWorkbench,
  type CompareContent,
  type CompareWorkbenchDeps,
} from "./compareWorkbench";
import type { DiffPayload } from "./diffPanel/types";

function payload(overrides: Partial<DiffPayload> = {}): DiffPayload {
  return {
    leftLabel: "左侧",
    rightLabel: "右侧",
    rows: [
      { kind: "equal", oldNo: 1, newNo: 1, left: "one", right: "one" },
      { kind: "change", oldNo: 2, newNo: 2, left: "two", right: "TWO" },
      { kind: "equal", oldNo: 3, newNo: 3, left: "three", right: "three" },
    ],
    hunks: [{ row: 1, oldStart: 2, newStart: 2 }],
    added: 1,
    removed: 1,
    identical: false,
    newlineNormalized: false,
    patch: "--- a\n+++ b\n",
    ...overrides,
  };
}

const ACTIVE: CompareContent = { label: "编辑中 · a.txt", text: "one\ntwo\n" };

function makeDeps(overrides: Partial<CompareWorkbenchDeps> = {}): CompareWorkbenchDeps {
  return {
    activeContent: () => ACTIVE,
    activeSelection: () => ({ label: "选区 · a.txt", text: "two\n" }),
    activeDiskContent: async () => ({ label: "磁盘 · a.txt", text: "one\ntwo\nthree\n" }),
    listTabs: () => [{ id: "t2", label: "b.txt" }],
    tabContent: (id) =>
      id === "t2" ? { label: "标签 · b.txt", text: "one\ntwo\nthree\n" } : null,
    pickFile: async () => null,
    readFile: async () => ({ label: "文件 · x.txt", text: "x\n" }),
    readClipboard: async () => "clip\n",
    computeDiff: vi.fn(async () => payload()),
    copyText: vi.fn(async () => true),
    showMessage: vi.fn(),
    ...overrides,
  };
}

let workbench: CompareWorkbench | null = null;

function open(deps = makeDeps()): {
  deps: CompareWorkbenchDeps;
  left: HTMLTextAreaElement;
  right: HTMLTextAreaElement;
} {
  workbench = new CompareWorkbench(deps);
  workbench.open();
  const areas = document.querySelectorAll<HTMLTextAreaElement>(".compare-text");
  return { deps, left: areas[0], right: areas[1] };
}

beforeEach(() => {
  // 分帧渲染在测试里改为同步执行，避免等下一帧
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});

afterEach(() => {
  workbench?.close();
  workbench = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CompareWorkbench", () => {
  it("打开时左侧带入当前标签、右侧为空文本，来源可切换", async () => {
    const { left, right } = open();
    expect(document.querySelector(".compare-dialog")).not.toBeNull();
    expect(left.value).toBe("one\ntwo\n");
    expect(right.value).toBe("");

    const options = Array.from(
      document.querySelectorAll<HTMLSelectElement>(".compare-source")[0].options,
    ).map((option) => option.textContent);
    expect(options).toContain("当前标签（含未保存）");
    expect(options).toContain("当前选区（如有）");
    expect(options).toContain("磁盘版本（当前文件）");
    expect(options).toContain("标签 · b.txt");
    expect(options).toContain("剪贴板");
    expect(options).toContain("磁盘文件…");
    expect(options).toContain("空文本");

    const select = document.querySelectorAll<HTMLSelectElement>(".compare-source")[0];
    select.value = "tab:t2";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(left.value).toBe("one\ntwo\nthree\n"));
  });

  it("一侧为空时先提示，点「重新比较」按两侧当前内容重算并渲染差异行", async () => {
    const { deps, left, right } = open();
    const diff = deps.computeDiff as ReturnType<typeof vi.fn>;
    // 打开时不把「左边有内容、右边空」误算成全删
    expect(diff).not.toHaveBeenCalled();
    expect(document.querySelector(".compare-dialog .diff-note")?.textContent).toContain(
      "有一侧为空",
    );
    expect(left.value).toBe("one\ntwo\n");
    expect(right.value).toBe("");

    right.value = "one\nTWO\n";
    document
      .querySelector<HTMLButtonElement>(".df-btn[title='立即按两侧当前内容重算差异']")
      ?.click();
    await vi.waitFor(() =>
      expect(diff).toHaveBeenCalledWith(
        { label: "编辑中 · a.txt", text: "one\ntwo\n" },
        { label: "空文本", text: "one\nTWO\n" },
      ),
    );
    await vi.waitFor(() => expect(document.querySelectorAll(".df-row").length).toBe(3));
    expect(document.querySelector(".diff-stats")?.textContent).toBe("+1-1");
    expect(document.querySelector(".df-nav-info")?.textContent).toContain("第 1 / 1 处");
  });

  it("编辑文本框后停顿自动重算", async () => {
    vi.useFakeTimers();
    const { deps, right } = open();
    right.value = "one\nTWO\n";
    right.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(500);
    const diff = deps.computeDiff as ReturnType<typeof vi.fn>;
    expect(diff).toHaveBeenCalled();
    const lastCall = diff.mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual({ label: "空文本", text: "one\nTWO\n" });
  });

  it("当前选区 / 磁盘版本可作为来源（只比较某个代码块 / 修改前后）", async () => {
    const { left } = open();
    const select = document.querySelectorAll<HTMLSelectElement>(".compare-source")[0];
    select.value = "selection";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(left.value).toBe("two\n"));

    select.value = "disk";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(left.value).toBe("one\ntwo\nthree\n"));
  });

  it("剪贴板来源会把内容读进该侧", async () => {
    const { right } = open();
    const select = document.querySelectorAll<HTMLSelectElement>(".compare-source")[1];
    select.value = "clipboard";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(right.value).toBe("clip\n"));
  });
});
