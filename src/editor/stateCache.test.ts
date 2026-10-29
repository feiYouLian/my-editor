import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { DocumentStateCache, type CachedState } from "./stateCache";

function entry(text: string): Omit<CachedState, "state"> & { state: EditorState } {
  return {
    state: EditorState.create({ doc: text }),
    generation: 1,
    langKey: null,
    readonly: false,
  };
}

describe("DocumentStateCache 的「撤销历史已释放」判定", () => {
  it("从没缓存过（首次打开）不算丢失", () => {
    const cache = new DocumentStateCache();
    // 首次打开一个文件时缓存里当然没有它：此时不该提示"历史已释放"
    expect(cache.takeLost("doc-1")).toBe(false);
  });

  it("超大文档切走时存不下 → 记为丢失", () => {
    const cache = new DocumentStateCache();
    const big = "a".repeat(2 * 1024 * 1024 + 1);
    cache.set("big", entry(big));
    expect(cache.get("big")).toBeUndefined(); // 确实没缓存
    expect(cache.takeLost("big")).toBe(true); // 但历史确实丢了，要提示一次
    expect(cache.takeLost("big")).toBe(false); // 只算一次
  });

  it("正常缓存命中不算丢失", () => {
    const cache = new DocumentStateCache();
    cache.set("small", entry("hello"));
    expect(cache.get("small")).toBeDefined();
    expect(cache.takeLost("small")).toBe(false);
  });

  it("超过 8 条时被淘汰的那条记为丢失，其余不算", () => {
    const cache = new DocumentStateCache();
    for (let i = 0; i < 9; i += 1) cache.set(`doc-${i}`, entry(`text ${i}`));
    expect(cache.takeLost("doc-0")).toBe(true); // 最旧的被挤出
    expect(cache.takeLost("doc-8")).toBe(false); // 最新的还在
  });

  it("超大文档仍保留光标位置", () => {
    const cache = new DocumentStateCache();
    const big = "a".repeat(2 * 1024 * 1024 + 1);
    cache.set("big", entry(big));
    expect(cache.takeCursor("big")).toBe(0);
  });
});
