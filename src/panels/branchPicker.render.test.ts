import { describe, expect, it, vi } from "vitest";

import { BranchPicker, type BranchPickerDeps, type GitBranch } from "./branchPicker";

function branch(name: string, current = false): GitBranch {
  return { name, current, ahead: 0, behind: 0 };
}

function makePicker(branches: GitBranch[]): {
  deps: BranchPickerDeps;
  picker: BranchPicker;
} {
  const deps: BranchPickerDeps = {
    load: vi.fn(async () => branches),
    onPick: vi.fn(),
    onCreate: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onRename: vi.fn(async () => {}),
    showMessage: vi.fn(),
  };
  return { deps, picker: new BranchPicker(deps) };
}

/** 等分支列表加载完成 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("branchPicker", () => {
  it("↑↓ 移动选中，Enter 切换选中分支，Esc 关闭", async () => {
    const { deps, picker } = makePicker([branch("main", true), branch("feature"), branch("fix")]);
    picker.open();
    await flush();

    const items = document.querySelectorAll(".palette-item");
    expect(items.length).toBe(3);

    // 键盘监听在输入框上（与快速打开一致）
    const input = document.querySelector(".palette-overlay input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.querySelector(".palette-item.selected")?.textContent).toContain("feature");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(deps.onPick).toHaveBeenCalledWith("feature");

    picker.open();
    await flush();
    const input2 = document.querySelector(".palette-overlay input") as HTMLInputElement;
    input2.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".palette-overlay")).toBeNull();
    picker.close();
  });
});
