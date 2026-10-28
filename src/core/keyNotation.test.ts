import { describe, expect, it } from "vitest";
import {
  formatKey,
  normalizeNotation,
  parseNotation,
  splitNotation,
} from "./keyNotation";

describe("splitNotation", () => {
  it("无修饰键时整体是主键", () => {
    expect(splitNotation("F5")).toEqual({ mods: [], key: "F5" });
  });

  it("按最后一个 - 拆出修饰部与主键", () => {
    expect(splitNotation("Mod-Shift-P")).toEqual({ mods: ["Mod", "Shift"], key: "P" });
  });

  it("单独的减号是主键，不是分隔符", () => {
    expect(splitNotation("-")).toEqual({ mods: [], key: "-" });
  });

  it("Mod-- 表示 Ctrl + 减号", () => {
    expect(splitNotation("Mod--")).toEqual({ mods: ["Mod"], key: "-" });
  });
});

describe("parseNotation", () => {
  it("Mod / Ctrl / Cmd / Meta 等价", () => {
    for (const mod of ["Mod", "Ctrl", "Cmd", "Meta"]) {
      expect(parseNotation(`${mod}-S`)).toEqual({
        mod: true,
        alt: false,
        shift: false,
        key: "S",
      });
    }
  });

  it("Alt / Option 等价", () => {
    expect(parseNotation("Alt-Up")?.alt).toBe(true);
    expect(parseNotation("Option-Up")?.alt).toBe(true);
  });

  it("Shift 可单独出现", () => {
    expect(parseNotation("Shift-F2")).toEqual({
      mod: false,
      alt: false,
      shift: true,
      key: "F2",
    });
  });

  it("未知修饰符返回 null（而不是当作主键）", () => {
    expect(parseNotation("Hyper-K")).toBeNull();
  });

  it("以 - 结尾但主键为空时返回 null", () => {
    // "Mod-" 会被 splitNotation 视为 mods=["Mod"]、key=""，应判非法
    expect(parseNotation("Mod-")).toBeNull();
  });
});

describe("normalizeNotation", () => {
  it("字母主键统一大写（CM6 的 Alt-c → 内部 Alt-C）", () => {
    expect(normalizeNotation("Alt-c")).toBe("Alt-C");
  });

  it("符号与功能键主键保持不变", () => {
    expect(normalizeNotation("Mod-Shift-[")).toBe("Mod-Shift-[");
    expect(normalizeNotation("Mod-`")).toBe("Mod-`");
    expect(normalizeNotation("Mod-PageUp")).toBe("Mod-PageUp");
  });

  it("幂等", () => {
    const once = normalizeNotation("Mod-Alt-Up");
    expect(normalizeNotation(once)).toBe(once);
  });

  it("减号主键不被改写", () => {
    expect(normalizeNotation("Mod--")).toBe("Mod--");
    expect(normalizeNotation("-")).toBe("-");
  });
});

describe("formatKey", () => {
  it("空记法显示「未绑定」", () => {
    expect(formatKey("")).toBe("未绑定");
  });

  it("非 Mac 环境把 Mod 显示为 Ctrl，部件用 + 连接", () => {
    // 单测跑在 node（无 navigator），IS_MAC 恒为 false
    expect(formatKey("Mod-S")).toBe("Ctrl+S");
    expect(formatKey("Mod-Shift-P")).toBe("Ctrl+Shift+P");
  });

  it("字母主键按记法原样展示（不擅自大写化）", () => {
    expect(formatKey("Mod-d")).toBe("Ctrl+d");
  });
});
