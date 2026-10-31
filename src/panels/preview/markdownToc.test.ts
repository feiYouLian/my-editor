import { describe, expect, it } from "vitest";
import { applyHeadingAnchors, slugify, type MdToken } from "./markdownToc";

interface TestToken extends MdToken {
  attrs: Map<string, string>;
  classes: string[];
}

/** 构造最小 token：只实现被测代码用到的字段与方法，并保留可断言的记录 */
function token(
  type: string,
  extra: { tag?: string; content?: string; children?: MdToken["children"] } = {},
): TestToken {
  const attrs = new Map<string, string>();
  const classes: string[] = [];
  return {
    type,
    tag: extra.tag ?? "",
    content: extra.content ?? "",
    children: extra.children ?? null,
    attrs,
    classes,
    attrSet(name, value) {
      attrs.set(name, value);
    },
    attrJoin(name, value) {
      if (name === "class") classes.push(value);
    },
  };
}

function heading(level: number, text: string): MdToken[] {
  return [
    token("heading_open", { tag: `h${level}` }),
    token("inline", { content: text, children: [{ type: "text", content: text }] }),
    token("heading_close", { tag: `h${level}` }),
  ];
}

describe("slugify", () => {
  it("空白转连字符并小写", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("  多   空格  ")).toBe("多-空格");
  });

  it("保留中文，去掉标点", () => {
    expect(slugify("中文：标题（一）")).toBe("中文标题一");
  });

  it("空标题回退为 section", () => {
    expect(slugify("!!!")).toBe("section");
    expect(slugify("")).toBe("section");
  });
});

describe("applyHeadingAnchors", () => {
  it("给标题加 id 与 data 锚点，并产出目录", () => {
    const tokens = [...heading(1, "使用手册"), token("paragraph_open"), token("inline"), ...heading(3, "安装")];
    const toc = applyHeadingAnchors(tokens);
    expect(toc.map((e) => [e.level, e.text, e.id])).toEqual([
      [1, "使用手册", "使用手册"],
      [3, "安装", "安装"],
    ]);
    const first = tokens[0] as TestToken;
    expect(first.attrs.get("id")).toBe("使用手册");
    expect(first.attrs.get("data-toc-anchor")).toBe("使用手册");
    expect(first.classes).toContain("md-heading");
  });

  it("同名标题自动去重（依次加 -2 / -3）", () => {
    const tokens = [...heading(2, "注意"), ...heading(2, "注意"), ...heading(2, "注意")];
    expect(applyHeadingAnchors(tokens).map((e) => e.id)).toEqual(["注意", "注意-2", "注意-3"]);
  });

  it("标题里的强调与行内代码按纯文本拼接", () => {
    const tokens = [
      token("heading_open", { tag: "h2" }),
      token("inline", {
        children: [
          { type: "text", content: "用 " },
          { type: "code_inline", content: "Ctrl+S" },
          { type: "text", content: " 保存" },
        ],
      }),
      token("heading_close", { tag: "h2" }),
    ];
    expect(applyHeadingAnchors(tokens)[0].text).toBe("用 Ctrl+S 保存");
  });
});
