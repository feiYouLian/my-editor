import { beforeEach, describe, expect, it } from "vitest";
import { clearMessages, listMessages, recordMessage } from "./messageLog";

describe("messageLog", () => {
  beforeEach(() => {
    clearMessages();
  });

  it("最新一条排在最前", () => {
    recordMessage("first");
    recordMessage("second");
    expect(listMessages().map((m) => m.text)).toEqual(["second", "first"]);
  });

  it("连续相同内容只占一条（避免刷屏把历史挤掉）", () => {
    recordMessage("正在格式化，请稍候…");
    recordMessage("正在格式化，请稍候…");
    recordMessage("正在格式化，请稍候…");
    expect(listMessages()).toHaveLength(1);
  });

  it("去掉首尾空白；全空白内容被忽略", () => {
    recordMessage("  saved  ");
    recordMessage("   ");
    expect(listMessages().map((m) => m.text)).toEqual(["saved"]);
  });

  it("超过 20 条时丢弃最旧", () => {
    for (let i = 0; i < 25; i += 1) recordMessage(`msg-${i}`);
    const items = listMessages();
    expect(items).toHaveLength(20);
    expect(items[0].text).toBe("msg-24");
    expect(items[19].text).toBe("msg-5");
  });

  it("清空后为空", () => {
    recordMessage("x");
    clearMessages();
    expect(listMessages()).toHaveLength(0);
  });
});
