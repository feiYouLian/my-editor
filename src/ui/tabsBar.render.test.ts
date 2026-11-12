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

  it("点击标签任意位置都能激活（不只是文件名）", () => {
    const first = tabStore.open(content("a.ts"));
    const second = tabStore.open(content("b.ts"));
    tabStore.activate(first.id);
    const callbacks = makeCallbacks();
    const container = document.querySelector<HTMLElement>("#tabs")!;
    const bar = new TabsBar(container, callbacks);
    bar.render();

    const target = container.querySelectorAll<HTMLElement>(".tab")[1];
    // 直接点在标签本身（内边距 / 空白处），事件不经过 .tab-name
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(callbacks.onActivate).toHaveBeenCalledWith(second.id);
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });

  it("点击关闭按钮只关闭，不触发激活", () => {
    const first = tabStore.open(content("a.ts"));
    tabStore.open(content("b.ts"));
    tabStore.activate(first.id);
    const callbacks = makeCallbacks();
    const container = document.querySelector<HTMLElement>("#tabs")!;
    const bar = new TabsBar(container, callbacks);
    bar.render();

    const close = container.querySelectorAll<HTMLElement>(".tab-close")[1];
    close.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(callbacks.onClose).toHaveBeenCalled();
    expect(callbacks.onActivate).not.toHaveBeenCalled();
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

  it("标签页按文件名颜色表达 Git 状态（不插字母 / 图标），就地更新 / 清空", () => {
    const first = tabStore.open(content("a.ts"));
    const second = tabStore.open(content("b.ts"));
    const container = document.querySelector<HTMLElement>("#tabs")!;
    const bar = new TabsBar(container, makeCallbacks());
    bar.render();

    // 大小写 / 分隔符与工作区返回值不同也要能对上（Windows 路径归一）
    bar.setGitStatus(new Map([[`D:\\ws\\a.ts`, "M"]]));
    const mark = container.querySelector<HTMLElement>(`.tab[data-tab-id="${first.id}"]`)!;
    expect(mark.dataset.gitStatus).toBe("M");
    // 状态只体现在颜色上：不加任何字母标记
    expect(mark.querySelector(".tab-git")).toBeNull();
    const name = mark.querySelector<HTMLElement>(".tab-name")!;
    expect(name.textContent).toBe("a.ts");
    expect(name.title).toContain("Git：已修改");

    // 未修改的标签没有状态
    expect(
      container.querySelector<HTMLElement>(`.tab[data-tab-id="${second.id}"]`)?.dataset
        .gitStatus,
    ).toBeUndefined();

    bar.setGitStatus(new Map());
    expect(container.querySelectorAll(".tab[data-git-status]")).toHaveLength(0);
  });

  it("Git 状态先到、标签后渲染时也带上状态", () => {
    const container = document.querySelector<HTMLElement>("#tabs")!;
    const bar = new TabsBar(container, makeCallbacks());
    bar.setGitStatus(new Map([["d:/ws/a.ts", "?"]]));

    const tab = tabStore.open(content("a.ts"));
    bar.render();

    const mark = container.querySelector<HTMLElement>(`.tab[data-tab-id="${tab.id}"]`)!;
    expect(mark.dataset.gitStatus).toBe("?");
    expect(mark.querySelector<HTMLElement>(".tab-name")!.title).toContain("未跟踪");
  });
});
