import { describe, expect, it } from "vitest";
import {
  MAX_IGNORE_DIRS,
  hasOverride,
  normalizeOverrides,
} from "./workspaceOverrides";

describe("hasOverride", () => {
  it("空对象 / null 都不算覆盖", () => {
    expect(hasOverride(null)).toBe(false);
    expect(hasOverride({})).toBe(false);
    expect(hasOverride({ tabSize: null, ignoreDirs: [] })).toBe(false);
  });

  it("任一有效项即算覆盖", () => {
    expect(hasOverride({ tabSize: 4 })).toBe(true);
    expect(hasOverride({ ignoreDirs: ["build"] })).toBe(true);
  });
});

describe("normalizeOverrides", () => {
  it("丢弃越界缩进（前后端同口径）", () => {
    expect(normalizeOverrides({ tabSize: 0 }).tabSize).toBeUndefined();
    expect(normalizeOverrides({ tabSize: 17 }).tabSize).toBeUndefined();
    expect(normalizeOverrides({ tabSize: 2.5 }).tabSize).toBeUndefined();
    expect(normalizeOverrides({ tabSize: 4 }).tabSize).toBe(4);
  });

  it("忽略目录去空白、去重、保序", () => {
    expect(normalizeOverrides({ ignoreDirs: [" build ", "build", "", ".cache"] }).ignoreDirs).toEqual([
      "build",
      ".cache",
    ]);
  });

  it("忽略目录超上限时截断", () => {
    const dirs = Array.from({ length: MAX_IGNORE_DIRS + 10 }, (_, i) => `d${i}`);
    expect(normalizeOverrides({ ignoreDirs: dirs }).ignoreDirs?.length).toBe(MAX_IGNORE_DIRS);
  });

  it("全部无效时返回空对象（调用方据此回退全局）", () => {
    expect(normalizeOverrides({ tabSize: null, ignoreDirs: [] })).toEqual({});
    expect(normalizeOverrides({ ignoreDirs: ["  "] })).toEqual({});
  });

  it("保留 root 便于人工排查", () => {
    expect(normalizeOverrides({ root: "D:/repo", tabSize: 3 })).toEqual({
      root: "D:/repo",
      tabSize: 3,
    });
  });
});
