import { describe, expect, it } from "vitest";
import { childCount, kindOf, parseJsonForView, previewOf } from "./jsonView";

describe("kindOf / childCount", () => {
  it("区分容器与标量", () => {
    expect(kindOf({})).toBe("object");
    expect(kindOf([])).toBe("array");
    expect(kindOf("x")).toBe("string");
    expect(kindOf(1)).toBe("number");
    expect(kindOf(true)).toBe("boolean");
    expect(kindOf(null)).toBe("null");
    expect(childCount({ a: 1, b: 2 })).toBe(2);
    expect(childCount([1, 2, 3])).toBe(3);
    expect(childCount("x")).toBe(0);
  });
});

describe("previewOf", () => {
  it("容器显示项数", () => {
    expect(previewOf({ a: 1 })).toBe("{…} 1 项");
    expect(previewOf([1, 2, 3])).toBe("[…] 3 项");
  });

  it("字符串加引号并按长度截断", () => {
    expect(previewOf("abc")).toBe('"abc"');
    const long = previewOf("x".repeat(200));
    expect(long.startsWith('"')).toBe(true);
    expect(long.endsWith('…"')).toBe(true);
  });

  it("标量直接展示", () => {
    expect(previewOf(12.5)).toBe("12.5");
    expect(previewOf(false)).toBe("false");
    expect(previewOf(null)).toBe("null");
  });
});

describe("parseJsonForView", () => {
  it("正常 JSON 返回结构化值", () => {
    const result = parseJsonForView('{"a":[1,2]}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(previewOf(result.value)).toBe("{…} 1 项");
  });

  it("语法错误给出中文说明", () => {
    const result = parseJsonForView("{a:1}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("JSON 解析失败");
  });

  it("空内容与超限分别拒绝", () => {
    expect(parseJsonForView("   ")).toEqual({ ok: false, error: "内容为空" });
    const big = "[" + "1,".repeat(5 * 1024 * 1024) + "1]";
    const result = parseJsonForView(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("超过只读视图上限");
  });
});
