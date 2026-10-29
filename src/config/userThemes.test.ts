import { describe, expect, it } from "vitest";

import {
  customThemeName,
  isValidColor,
  parseThemeEntries,
  parseUserTheme,
  themeValue,
} from "./userThemes";

const VALID = JSON.stringify({
  dark: true,
  ui: { background: "#0f172a", foreground: "#cbd5e1" },
  syntax: { keyword: "#c792ea", string: "#c3e88d" },
});

describe("themeValue / customThemeName", () => {
  it("往返一致", () => {
    expect(customThemeName(themeValue("slate"))).toBe("slate");
  });

  it("内置主题不是自定义主题", () => {
    expect(customThemeName("dark")).toBeNull();
    expect(customThemeName("high-contrast")).toBeNull();
  });

  it("空名字视为未指定", () => {
    expect(customThemeName("custom:")).toBeNull();
    expect(customThemeName("custom:   ")).toBeNull();
  });
});

describe("isValidColor", () => {
  it("接受常见写法", () => {
    for (const c of ["#fff", "#0f172a", "rgb(1, 2, 3)", "hsl(200 50% 40%)", "red"]) {
      expect(isValidColor(c)).toBe(true);
    }
  });

  it("拒绝会破坏 CSS 的结构性字符与空值", () => {
    for (const c of ["", "   ", "#fff;", "red}", "a{b}", "@import", "url(x)"]) {
      expect(isValidColor(c)).toBe(false);
    }
  });

  it("拒绝非字符串", () => {
    expect(isValidColor(12)).toBe(false);
    expect(isValidColor(null)).toBe(false);
  });
});

describe("parseUserTheme", () => {
  it("合法主题解析成功", () => {
    const result = parseUserTheme("slate", VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.name).toBe("slate");
    expect(result.value.theme.dark).toBe(true);
    expect(result.value.theme.ui.background).toBe("#0f172a");
    expect(result.value.theme.syntax.keyword).toBe("#c792ea");
    expect(result.value.unknownKeys).toEqual([]);
  });

  it("JSON 语法错误给出原因", () => {
    const result = parseUserTheme("bad", "{ syntax: ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("JSON");
  });

  it("缺少 syntax 直接失败（否则主题看起来「没生效」）", () => {
    const result = parseUserTheme("bad", JSON.stringify({ ui: { background: "#000" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("syntax");
  });

  it("syntax 为空对象也算失败", () => {
    const result = parseUserTheme("bad", JSON.stringify({ syntax: {} }));
    expect(result.ok).toBe(false);
  });

  it("未知键进入 unknownKeys 而不是静默丢弃", () => {
    const result = parseUserTheme(
      "typo",
      JSON.stringify({ syntax: { keywrd: "#fff", keyword: "#eee" }, ui: { backgroud: "#000" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unknownKeys).toContain("syntax.keywrd");
    expect(result.value.unknownKeys).toContain("ui.backgroud");
    expect(result.value.theme.syntax.keyword).toBe("#eee");
  });

  it("非法颜色失败并指出键名", () => {
    const result = parseUserTheme("bad", JSON.stringify({ syntax: { keyword: "#fff;" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("syntax.keyword");
  });

  it("dark 省略时按背景亮度推断", () => {
    const dark = parseUserTheme("d", JSON.stringify({ ui: { background: "#000000" }, syntax: { keyword: "#fff" } }));
    const light = parseUserTheme("l", JSON.stringify({ ui: { background: "#ffffff" }, syntax: { keyword: "#000" } }));
    expect(dark.ok && dark.value.theme.dark).toBe(true);
    expect(light.ok && light.value.theme.dark).toBe(false);
  });

  it("背景色无法推断时默认深色", () => {
    const result = parseUserTheme("x", JSON.stringify({ ui: { background: "hsl(0 0% 50%)" }, syntax: { keyword: "#fff" } }));
    expect(result.ok && result.value.theme.dark).toBe(true);
  });

  it("dark 非布尔失败", () => {
    const result = parseUserTheme("bad", JSON.stringify({ dark: "yes", syntax: { keyword: "#fff" } }));
    expect(result.ok).toBe(false);
  });

  it("顶层不是对象失败", () => {
    expect(parseUserTheme("bad", "[]").ok).toBe(false);
    expect(parseUserTheme("bad", "null").ok).toBe(false);
  });
});

describe("parseThemeEntries", () => {
  it("坏文件进 errors，好文件照常返回", () => {
    const { themes, errors } = parseThemeEntries([
      { name: "good", content: VALID },
      { name: "broken", content: "not json" },
    ]);
    expect(themes.map((t) => t.name)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("broken.json");
  });

  it("主题名重复时保留首个并报告", () => {
    const { themes, errors } = parseThemeEntries([
      { name: "dup", content: VALID },
      { name: "dup", content: VALID },
    ]);
    expect(themes).toHaveLength(1);
    expect(errors[0]).toContain("重复");
  });

  it("未知键作为提示返回", () => {
    const { themes, errors } = parseThemeEntries([
      { name: "typo", content: JSON.stringify({ syntax: { keywrd: "#fff", keyword: "#eee" } }) },
    ]);
    expect(themes).toHaveLength(1);
    expect(errors[0]).toContain("keywrd");
  });
});
