import { describe, expect, it } from "vitest";

import { parseLanguageEntries, parseUserLanguage } from "./userLanguages";

const MINIMAL = JSON.stringify({ extensions: [".toml"] });

describe("parseUserLanguage", () => {
  it("只有 extensions 也能成立，其余取默认值", () => {
    const result = parseUserLanguage("toml", MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { spec } = result.value;
    expect(spec.name).toBe("toml");
    expect(spec.extensions).toEqual([".toml"]);
    expect(spec.quotes).toBe("\"'");
    expect(spec.brackets).toBe("()[]{}");
    expect(spec.numbers).toBe(true);
    expect(spec.caseInsensitive).toBe(false);
    expect(spec.keywords).toEqual([]);
    expect(result.value.unknownKeys).toEqual([]);
  });

  it("扩展名统一转小写", () => {
    const result = parseUserLanguage("x", JSON.stringify({ extensions: [".TOML", ".Conf"] }));
    expect(result.ok && result.value.spec.extensions).toEqual([".toml", ".conf"]);
  });

  it("extensions 缺失 / 为空 / 格式错都失败", () => {
    expect(parseUserLanguage("x", JSON.stringify({})).ok).toBe(false);
    expect(parseUserLanguage("x", JSON.stringify({ extensions: [] })).ok).toBe(false);
    expect(parseUserLanguage("x", JSON.stringify({ extensions: ["toml"] })).ok).toBe(false);
    expect(parseUserLanguage("x", JSON.stringify({ extensions: ".toml" })).ok).toBe(false);
  });

  it("JSON 语法错误给出原因", () => {
    const result = parseUserLanguage("x", "{ extensions: ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("JSON");
  });

  it("关键字去重且空白项忽略", () => {
    const result = parseUserLanguage(
      "x",
      JSON.stringify({ extensions: [".x"], keywords: ["if", "if", " ", "else"] }),
    );
    expect(result.ok && result.value.spec.keywords).toEqual(["if", "else"]);
  });

  it("关键字里的空白项格式非法", () => {
    const result = parseUserLanguage(
      "x",
      JSON.stringify({ extensions: [".x"], keywords: ["a b"] }),
    );
    expect(result.ok).toBe(false);
  });

  it("lineComment 不能含空白或过长", () => {
    expect(
      parseUserLanguage("x", JSON.stringify({ extensions: [".x"], lineComment: "# #" })).ok,
    ).toBe(false);
    expect(
      parseUserLanguage("x", JSON.stringify({ extensions: [".x"], lineComment: "#####" })).ok,
    ).toBe(false);
    const ok = parseUserLanguage("x", JSON.stringify({ extensions: [".x"], lineComment: "//" }));
    expect(ok.ok && ok.value.spec.lineComment).toBe("//");
  });

  it("blockComment 必须是两端字符串", () => {
    expect(
      parseUserLanguage("x", JSON.stringify({ extensions: [".x"], blockComment: "/*" })).ok,
    ).toBe(false);
    const ok = parseUserLanguage(
      "x",
      JSON.stringify({ extensions: [".x"], blockComment: ["/*", "*/"] }),
    );
    expect(ok.ok && ok.value.spec.blockComment).toEqual(["/*", "*/"]);
  });

  it("quotes / numbers / caseInsensitive 类型校验", () => {
    expect(parseUserLanguage("x", JSON.stringify({ extensions: [".x"], quotes: "" })).ok).toBe(false);
    // 上限 4 个字符
    expect(parseUserLanguage("x", JSON.stringify({ extensions: [".x"], quotes: "'''''" })).ok).toBe(
      false,
    );
    expect(
      parseUserLanguage("x", JSON.stringify({ extensions: [".x"], numbers: "yes" })).ok,
    ).toBe(false);
    expect(
      parseUserLanguage("x", JSON.stringify({ extensions: [".x"], caseInsensitive: 1 })).ok,
    ).toBe(false);
  });

  it("未知键进入 unknownKeys", () => {
    const result = parseUserLanguage(
      "x",
      JSON.stringify({ extensions: [".x"], keyword: ["if"], keywords: ["else"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unknownKeys).toContain("keyword");
    expect(result.value.spec.keywords).toEqual(["else"]);
  });
});

describe("parseLanguageEntries", () => {
  it("坏文件进 errors，好文件照常返回", () => {
    const { languages, errors } = parseLanguageEntries([
      { name: "toml", content: MINIMAL },
      { name: "broken", content: "{}" },
    ]);
    expect(languages.map((l) => l.name)).toEqual(["toml"]);
    expect(errors[0]).toContain("broken.json");
  });

  it("未知键作为提示返回", () => {
    const { languages, errors } = parseLanguageEntries([
      { name: "typo", content: JSON.stringify({ extensions: [".x"], keyword: ["if"] }) },
    ]);
    expect(languages).toHaveLength(1);
    expect(errors[0]).toContain("keyword");
  });
});
