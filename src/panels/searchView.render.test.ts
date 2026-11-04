import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SearchView, type SearchViewDeps } from "./searchView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

function makeDeps(): SearchViewDeps {
  return {
    getRoot: () => "D:/ws",
    getIgnoreDirs: () => [],
    onOpenLocation: vi.fn(),
    isDirtyPath: () => false,
    onFilesReplaced: async () => {},
    showMessage: vi.fn(),
  };
}

function mount(deps = makeDeps()): { host: HTMLElement; view: SearchView } {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, view: new SearchView(host, deps) };
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  invokeMock.mockReset();
});

describe("SearchView 状态渲染", () => {
  it("初始空态给出入口说明", () => {
    const { host } = mount();
    expect(host.querySelector(".sv-empty")?.textContent).toBe(
      "输入关键词搜索工作区（尊重 .gitignore 与忽略目录）",
    );
  });

  it("结果计数同时说明截断与跳过的大文件", async () => {
    invokeMock.mockResolvedValue({
      files: [
        {
          path: "D:/ws/a.ts",
          relative: "a.ts",
          matches: [{ line: 3, col: 5, before: "const ", hit: "foo", after: " = 1;" }],
          truncated: false,
        },
      ],
      total_matches: 3,
      truncated: true,
      skipped_oversize: 2,
    });

    const { host } = mount();
    const input = host.querySelector<HTMLInputElement>(".sv-toolbar .sv-input")!;
    input.value = "foo";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => {
      expect(host.querySelector(".sv-count")?.textContent).toContain("1 个文件 · 3 处");
    });
    expect(host.querySelector(".sv-count")?.textContent).toBe(
      "1 个文件 · 3 处（已截断，请细化关键词）（已跳过 2 个超过 2MB 的文件）",
    );
    expect(host.querySelectorAll(".sv-file")).toHaveLength(1);
    expect(host.querySelectorAll(".sv-match")).toHaveLength(1);
    expect(host.querySelector(".sv-match")?.textContent).toContain("foo");
  });
});
