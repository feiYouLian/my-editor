import { describe, expect, it } from "vitest";
import { formatBytes, parseEnv } from "./runConfig";

describe("parseEnv", () => {
  it("解析 KEY=VALUE、保留值中的等号、忽略空行与注释", () => {
    expect(
      parseEnv(
        ["# comment", "A=1", "", "B=x=y", "  C = hello world  ", "invalid"].join("\n"),
      ),
    ).toEqual([
      ["A", "1"],
      ["B", "x=y"],
      ["C", "hello world"],
    ]);
  });
});

describe("formatBytes", () => {
  it("按 KB/MB 格式化", () => {
    expect(formatBytes(1024)).toBe("1KB");
    expect(formatBytes(1024 * 1024)).toBe("1MB");
    expect(formatBytes(1536 * 1024)).toBe("1.5MB");
  });
});
