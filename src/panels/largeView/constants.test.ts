import { describe, expect, it } from "vitest";
import { ENCODINGS } from "./constants";

describe("大文件视图编码候选", () => {
  it("包含 Windows-1252（与后端 CANDIDATES 对齐）", () => {
    expect(ENCODINGS).toContain("Windows-1252");
  });

  it("不包含 UTF-16（字节级行扫描会错位）", () => {
    expect(ENCODINGS.some((name) => name.startsWith("UTF-16"))).toBe(false);
  });
});
