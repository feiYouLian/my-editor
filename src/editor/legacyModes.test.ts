import { describe, expect, it } from "vitest";

import { extensionToLanguage } from "./languages";
import { LEGACY_MODES, isLegacyMode, legacyModeNames } from "./legacyModes";

describe("附加语言表", () => {
  it("键名与条目一致且非空", () => {
    const names = legacyModeNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(LEGACY_MODES[name].label.trim().length).toBeGreaterThan(0);
      expect(isLegacyMode(name)).toBe(true);
    }
    expect(isLegacyMode("not-a-mode")).toBe(false);
  });

  it("扩展名格式合法（小写、含点）且表内不重复", () => {
    const seen = new Set<string>();
    for (const entry of Object.values(LEGACY_MODES)) {
      for (const ext of entry.extensions) {
        expect(ext.startsWith(".")).toBe(true);
        expect(ext).toBe(ext.toLowerCase());
        // 同一个扩展名被两个可选语言声明 -> 谁生效取决于勾选顺序，属于配置事故
        expect(seen.has(ext)).toBe(false);
        seen.add(ext);
      }
    }
  });

  it("不与内置语言的扩展名冲突（否则勾选后永远不生效）", () => {
    for (const entry of Object.values(LEGACY_MODES)) {
      for (const ext of entry.extensions) {
        expect(extensionToLanguage[ext]).toBeUndefined();
      }
    }
  });

  it("basenames 全部小写", () => {
    for (const entry of Object.values(LEGACY_MODES)) {
      for (const base of entry.basenames ?? []) {
        expect(base).toBe(base.toLowerCase());
        expect(base.length).toBeGreaterThan(0);
      }
    }
  });
});
