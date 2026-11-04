import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { QuickOpen } from "./quickOpen";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

function makeFiles(count: number): { path: string; relative: string; name: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `D:/ws/dir/f${i}.ts`,
    relative: `dir/f${i}.ts`,
    name: `f${i}.ts`,
  }));
}

function makeQuickOpen() {
  return new QuickOpen({
    getRoot: () => "D:/ws",
    getIgnoreDirs: () => [],
    onOpen: vi.fn(),
    showMessage: vi.fn(),
  });
}

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

beforeEach(() => {
  document.body.innerHTML = "";
  invokeMock.mockReset();
});

describe("QuickOpen 渲染与选中态", () => {
  it("文件数超过 200 时只渲染 200 行，并说明当前窗口", async () => {
    invokeMock.mockResolvedValue(makeFiles(250));
    const quick = makeQuickOpen();
    quick.open();

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".palette-item")).toHaveLength(200);
    });
    expect(document.querySelector(".palette-hint")?.textContent).toContain("共 250 个文件");
    expect(document.querySelector(".palette-empty")?.textContent).toContain("显示第 1–200 条");
  });

  it("选中项越过第 200 条后仍在窗口内（0.6.1 回归）", async () => {
    invokeMock.mockResolvedValue(makeFiles(250));
    const quick = makeQuickOpen();
    quick.open();

    const input = document.querySelector<HTMLInputElement>(".palette-input")!;
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".palette-item")).toHaveLength(200);
    });

    for (let i = 0; i < 240; i++) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    }

    const items = document.querySelectorAll<HTMLElement>(".palette-item");
    const selected = document.querySelectorAll(".palette-item.selected");
    expect(items).toHaveLength(200);
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("f240.ts");
    expect(document.querySelector(".palette-empty")?.textContent).toContain("显示第 51–250 条");
  });
});
