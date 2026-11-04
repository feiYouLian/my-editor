import { describe, expect, it } from "vitest";
import { defaultConfig } from "./settings";
import { ENCODINGS } from "../panels/largeView/constants";
import fixture from "./fixtures/defaults-contract.json";

describe("前后端默认值契约（与 Rust 共用同一夹具）", () => {
  it("顶层配置键集合一致", () => {
    // 新增一个配置键只改前端或只改 Rust，这里会先失败（给出缺了哪个键）
    expect(Object.keys(defaultConfig()).sort()).toEqual(Object.keys(fixture.config).sort());
  });

  it("全部配置键的默认值一致", () => {
    expect(defaultConfig()).toEqual(fixture.config);
  });

  it("大文件视图编码与后端候选（去掉 UTF-16）一致", () => {
    expect(ENCODINGS).toEqual(fixture.largeViewEncodings);
  });

  it("文件关联默认关闭：安装与启动都不直接改写系统关联", () => {
    expect(defaultConfig().system.fileAssociation).toBe(false);
  });
});
