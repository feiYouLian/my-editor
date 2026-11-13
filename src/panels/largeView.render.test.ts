import { afterEach, describe, expect, it, vi } from "vitest";

// 视图只在这些命令被调用时才发 IPC：测试里给空实现，避免真实 Tauri 运行时
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ start: 0, lineNos: [], lines: [], truncatedLines: 0 })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { LargeView, type LargeFileInfo } from "./largeView";
import type { FilterBatch } from "./largeView/types";

interface ViewInternals {
  info: LargeFileInfo | null;
  matchBuf: {
    active: boolean;
    length: number;
    begin: () => void;
    append: (batch: number[]) => void;
  };
  applyFilterBatch: (p: FilterBatch) => void;
}

function makeInfo(): LargeFileInfo {
  return {
    id: "large:D:/logs/a.log",
    path: "D:/logs/a.log",
    name: "a.log",
    size: 100,
    encoding: "UTF-8",
    newline: "LF",
    totalLines: 10,
    indexedBytes: 100,
    complete: true,
  };
}

function batch(overrides: Partial<FilterBatch> = {}): FilterBatch {
  return {
    id: "large:D:/logs/a.log",
    requestId: 1,
    matches: [3, 5],
    scanned: 100,
    total: 100,
    truncated: false,
    done: true,
    cancelled: false,
    ...overrides,
  };
}

/** 等 loadWindow 的异步读取跑完，避免测试结束后还有挂起的 Promise */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mountView(): { view: LargeView; internals: ViewInternals } {
  const host = document.createElement("div");
  host.id = "large-view";
  document.body.append(host);
  const view = new LargeView(host, {
    onMessage: vi.fn(),
    onOpenInEditor: vi.fn(),
    reportResult: vi.fn(),
    reportFailure: vi.fn(),
  });
  const internals = view as unknown as ViewInternals;
  internals.info = makeInfo();
  return { view, internals };
}

describe("LargeView 过滤取消", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("取消批次不把半截命中留在视图里", async () => {
    const { view, internals } = mountView();
    internals.matchBuf.begin();
    internals.matchBuf.append([1, 2]);

    internals.applyFilterBatch(batch({ cancelled: true, matches: [9] }));

    // 取消 = 结果作废：退回未过滤全文，而不是按半截命中虚拟化
    expect(internals.matchBuf.active).toBe(false);
    expect(internals.matchBuf.length).toBe(0);
    view.dispose();
    await flush();
  });

  it("正常批次继续追加命中", async () => {
    const { view, internals } = mountView();
    internals.matchBuf.begin();

    internals.applyFilterBatch(batch({ done: false }));

    expect(internals.matchBuf.active).toBe(true);
    expect(internals.matchBuf.length).toBe(2);
    view.dispose();
    await flush();
  });
});
