import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, commandScore, type CommandItem } from "./commandPalette";
import { showHelpDialog } from "./helpDialog";

// 帮助对话框会动态加载 Markdown 与 markdown-it：测试里只关心「跳没跳、跳到哪」
vi.mock("./helpDialog", () => ({ showHelpDialog: vi.fn() }));

/** 与 commandTable.ts 的元数据保持一致（关键词改动时同步这里） */
const items: CommandItem[] = [
  {
    id: "diff.gitHead",
    title: "比较：与 Git HEAD",
    section: "Git",
    description: "把当前文件与 Git 里最后一次提交的版本对比，可导出 .patch",
    keywords: ["git diff", "和上次提交比", "看改了哪", "patch", "git apply", "发给别人", "留个底"],
    outcome: {
      kind: "git",
      hint: "对比结果只读，不修改文件；导出得到统一 diff 补丁，可用 git apply 应用",
    },
    run: vi.fn(),
  },
  {
    id: "git.showHistory",
    title: "Git：查看提交历史",
    section: "Git",
    description: "按时间查看当前工作区的提交记录，选中一条可看它改了哪些文件",
    keywords: ["git log", "查看改动记录", "看看谁改的", "提交历史"],
    outcome: { kind: "git", hint: "选中提交后右侧显示它与上一版的差异，可复制或导出 .patch" },
    run: vi.fn(),
  },
  {
    id: "file.save",
    title: "保存",
    section: "文件",
    description: "把当前标签的改动写回原文件，不弹路径选择",
    keywords: ["ctrl+s", "存盘", "保存文件", "写回磁盘"],
    outcome: { kind: "file", hint: "写回原路径并保持原编码；未命名文档会先让你选保存位置" },
    run: vi.fn(),
  },
];

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

function openPalette(): CommandPalette {
  const palette = new CommandPalette();
  palette.registerAll(items);
  palette.open();
  return palette;
}

function typeQuery(text: string): void {
  const input = document.querySelector<HTMLInputElement>(".palette-input")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
}

function firstTitle(): string {
  return document.querySelector(".palette-item .palette-item-title")?.textContent ?? "";
}

describe("命令面板：搜索、两行渲染与详情区", () => {
  it("自然语言查询命中正确命令", () => {
    const palette = openPalette();

    typeQuery("发给别人");
    expect(firstTitle()).toContain("与 Git HEAD");

    typeQuery("查看改动记录");
    expect(firstTitle()).toContain("查看提交历史");

    palette.close();
  });

  it("关键词精确命中优先于说明与标题", () => {
    expect(commandScore("git apply", items[0]).score).toBeGreaterThan(0);
    expect(commandScore("git apply", items[2]).score).toBe(0);
    expect(commandScore("查看改动记录", items[1]).score).toBeGreaterThan(
      commandScore("查看改动记录", items[0]).score,
    );
  });

  it("列表项渲染两行：标题 + 一句话说明", () => {
    const palette = openPalette();
    const descs = [...document.querySelectorAll(".palette-item-desc")].map((el) => el.textContent);
    expect(descs).toContain("把当前文件与 Git 里最后一次提交的版本对比，可导出 .patch");
    expect(document.querySelectorAll(".palette-item-title")).toHaveLength(items.length);
    palette.close();
  });

  it("详情区显示选中命令的结果说明，并随选择更新", () => {
    const palette = openPalette();
    const detail = document.querySelector(".palette-detail")!;
    expect(detail.textContent).toContain("对比结果只读");

    const input = document.querySelector<HTMLInputElement>(".palette-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(detail.textContent).toContain("选中提交后右侧显示");

    palette.close();
  });

  it("无说明的命令不占第二行，空查询保留全部命令", () => {
    const palette = new CommandPalette();
    palette.registerAll([{ id: "x.y", title: "无说明命令", run: vi.fn() }]);
    palette.open();

    expect(document.querySelectorAll(".palette-item")).toHaveLength(1);
    expect(document.querySelectorAll(".palette-item-desc")).toHaveLength(0);
    // 详情区没有结果说明，但「查看完整说明」入口仍在：没有说明的命令也能反查
    expect(document.querySelector(".palette-detail-text")).toBeNull();
    expect(document.querySelector(".palette-detail-btn")?.textContent).toBe("查看完整说明");

    palette.close();
  });

  it("详情区「查看完整说明」跳到命令索引的对应条目", () => {
    const palette = openPalette();

    document.querySelector<HTMLButtonElement>(".palette-detail-btn")!.click();
    expect(vi.mocked(showHelpDialog)).toHaveBeenCalledWith("commands", "diff.gitHead");
    // 跳转前先关面板，避免两层浮层叠在一起
    expect(document.querySelector(".palette-overlay")).toBeNull();

    palette.close();
  });

  it("Ctrl+Enter 不执行命令，只打开说明", () => {
    const palette = openPalette();
    const input = document.querySelector<HTMLInputElement>(".palette-input")!;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(items[0].run).not.toHaveBeenCalled();
    expect(vi.mocked(showHelpDialog)).toHaveBeenCalledWith("commands", "diff.gitHead");

    palette.close();
  });
});
