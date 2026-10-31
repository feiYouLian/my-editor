import { describe, expect, it } from "vitest";
import { defaultConfig, defaultStatusBarFields } from "./settings";
import { ENCODINGS } from "../panels/largeView/constants";
import fixture from "./fixtures/defaults-contract.json";

describe("前后端默认值契约（与 Rust 共用同一夹具）", () => {
  it("状态栏字段 id 与顺序一致", () => {
    expect(defaultStatusBarFields().map((f) => f.id)).toEqual(fixture.statusBarFields);
  });

  it("格式化工具键一致（前端默认值补上 rust）", () => {
    expect(Object.keys(defaultConfig().formatters).sort()).toEqual(fixture.formatterKeys);
  });

  it("大文件视图编码与后端候选（去掉 UTF-16）一致", () => {
    expect(ENCODINGS).toEqual(fixture.largeViewEncodings);
  });
});
