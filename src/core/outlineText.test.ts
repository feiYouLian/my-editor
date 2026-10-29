import { describe, expect, it } from "vitest";

import { parseMarkdownHeading } from "./outlineText";

describe("parseMarkdownHeading", () => {
  it("识别 1–6 级标题并给出深度", () => {
    expect(parseMarkdownHeading("# 标题")).toEqual({ label: "标题", depth: 0 });
    expect(parseMarkdownHeading("### 三级")).toEqual({ label: "三级", depth: 2 });
    expect(parseMarkdownHeading("###### 六级")).toEqual({ label: "六级", depth: 5 });
  });

  it("7 个 # 不是标题（CommonMark 只认 1–6）", () => {
    expect(parseMarkdownHeading("####### 七个")).toBeNull();
  });

  it("# 后必须有空白", () => {
    expect(parseMarkdownHeading("#没有空格")).toBeNull();
    expect(parseMarkdownHeading("#\t制表符分隔")).toEqual({ label: "制表符分隔", depth: 0 });
  });

  it("缩进的 # 不算标题（代码块里的注释常这样）", () => {
    expect(parseMarkdownHeading("  # 缩进")).toBeNull();
  });

  it("普通文本与空行返回 null", () => {
    expect(parseMarkdownHeading("普通一行")).toBeNull();
    expect(parseMarkdownHeading("")).toBeNull();
    expect(parseMarkdownHeading("# ")).toBeNull();
  });

  it("兼容 CRLF 文档残留的 \\r", () => {
    expect(parseMarkdownHeading("# 标题\r")).toEqual({ label: "标题", depth: 0 });
  });

  it("标题超长时截断到 120 字符", () => {
    const long = "长".repeat(200);
    const parsed = parseMarkdownHeading(`# ${long}`);
    expect(parsed?.label.length).toBe(120);
  });
});
