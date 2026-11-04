import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tabStore } from "../store/tabs";
import type { FileContent } from "../types/app";
import { TabsBar, type TabsBarCallbacks } from "./tabsBar";

function content(name: string, text = ""): FileContent {
  return {
    path: `D:/ws/${name}`,
    name,
    size: text.length,
    content: text,
    encoding: "UTF-8",
    newline: "LF",
    has_bom: false,
    encoding_confidence: "high",
    encoding_candidates: ["UTF-8"],
    readonly: false,
    readonly_reason: "",
  };
}

function makeCallbacks(): TabsBarCallbacks {
  return {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCompareWith: vi.fn(),
    onBulkClose: vi.fn(),
    onNewTab: vi.fn(),
  };
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver !== "function") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  for (const tab of [...tabStore.list()]) tabStore.close(tab.id);
  document.body.innerHTML = '<div class="tabsbar"><div id="tabs"></div></div>';
});

describe("TabsBar 状态渲染与键盘", () => {
  it("渲染全部标签，激活项带 aria-selected", () => {
    const first = tabStore.open(content("a.ts"));
    tabStore.open(content("b.ts"));
    tabStore.activate(first.id);
    const container = document.querySelector<HTMLElement>("#tabs")!;
    const bar = new TabsBar(container, makeCallbacks());
    bar.render();

    const tabs = container.querySelectorAll<HTMLElement>(".tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain("a.ts");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].classList.contains("active")).toBe(true);
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
  });

  it("→ 键把焦点语义交给下一个标签（与历史面板 / 分支选择一致）", () => {
    const first = tabStore.open(content("a.ts"));
    const second = tabStore.open(content("b.ts"));
    tabStore.activate(first.id);
    const callbacks = makeCallbacks();
    const container = document.querySelector<HTMLElement>("#tabs")!;
    const bar = new TabsBar(container, callbacks);
    bar.render();

    const active = container.querySelector<HTMLElement>(".tab.active")!;
    active.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(callbacks.onActivate).toHaveBeenCalledWith(second.id);
  });
});
