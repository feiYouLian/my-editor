import { beforeEach, describe, expect, it } from "vitest";
import { addNotice, clearNotices, listNotices } from "./noticeStore";

describe("noticeStore 去重", () => {
  beforeEach(() => clearNotices());

  it("同一 dedupeKey 只保留最新一条", () => {
    addNotice("formatFail", "第一次失败", [], "fmt:tab-1");
    addNotice("formatFail", "第二次失败", [], "fmt:tab-1");

    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toBe("第二次失败");
    expect(notices[0].key).toBe("fmt:tab-1");
  });

  it("不同 dedupeKey 不互相合并", () => {
    addNotice("formatFail", "A 失败", [], "fmt:tab-1");
    addNotice("formatFail", "B 失败", [], "fmt:tab-2");

    expect(listNotices()).toHaveLength(2);
  });

  it("没有 dedupeKey 时同文案也各自保留", () => {
    addNotice("gitFail", "push 失败");
    addNotice("gitFail", "push 失败");

    expect(listNotices()).toHaveLength(2);
  });
});
