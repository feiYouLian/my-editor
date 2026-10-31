import { describe, expect, it } from "vitest";
import { normalizeLogExtensions } from "./logExtensions";

describe("normalizeLogExtensions", () => {
  it("大小写、点号前缀与空项都归一到小写带点", () => {
    expect(normalizeLogExtensions(["LOG", "log", ".Log", "", "  "])).toEqual([
      ".log",
      ".log",
      ".log",
    ]);
  });

  it("保留非日志扩展名并补齐点", () => {
    expect(normalizeLogExtensions(["txt", ".out"])).toEqual([".txt", ".out"]);
  });
});
