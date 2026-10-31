import { describe, expect, it } from "vitest";
import { dirnameOf, isSameOrInsidePath, joinVirtualPath, topmostPaths } from "./paths";

describe("joinVirtualPath", () => {
  it("Windows 路径统一用正斜杠（Tauri IPC 接受）", () => {
    expect(joinVirtualPath("C:\\docs\\a.assets", "img.png")).toBe(
      "C:/docs/a.assets/img.png",
    );
  });

  it("POSIX 路径保持正斜杠，不产生反斜杠文件名", () => {
    expect(joinVirtualPath("/home/me/docs", "img.png")).toBe("/home/me/docs/img.png");
  });

  it("处理首尾重复分隔符", () => {
    expect(joinVirtualPath("/home/me/docs/", "/img.png")).toBe("/home/me/docs/img.png");
  });
});

describe("dirnameOf", () => {
  it("同时识别正反斜杠", () => {
    expect(dirnameOf("C:\\docs\\a.md")).toBe("C:\\docs");
    expect(dirnameOf("/home/me/a.md")).toBe("/home/me");
  });

  it("POSIX 根目录文件返回 /", () => {
    expect(dirnameOf("/a.md")).toBe("/");
  });
});

describe("isSameOrInsidePath", () => {
  it("忽略大小写与分隔符差异", () => {
    expect(isSameOrInsidePath("D:/repo/src/a.ts", "d:\\repo")).toBe(true);
    expect(isSameOrInsidePath("D:/repo/a.ts", "D:/REPO")).toBe(true);
  });

  it("前缀相同的兄弟目录不算包含", () => {
    expect(isSameOrInsidePath("D:/repo-other/a.ts", "D:/repo")).toBe(false);
  });

  it("自身算包含；父目录不算子路径", () => {
    expect(isSameOrInsidePath("D:/repo", "D:/repo/")).toBe(true);
    expect(isSameOrInsidePath("D:/repo", "D:/repo/src")).toBe(false);
  });
});

describe("topmostPaths", () => {
  it("父目录覆盖其子项，避免重复操作同一子树", () => {
    expect(topmostPaths(["D:\\repo\\src\\a.ts", "D:\\repo\\src"])).toEqual(["D:\\repo\\src"]);
  });

  it("输入由浅到深时保留父项，重复项只留第一个", () => {
    expect(topmostPaths(["D:\\repo\\src", "D:\\repo\\src\\a.ts", "D:\\repo\\src"])).toEqual([
      "D:\\repo\\src",
    ]);
  });

  it("互不包含的兄弟保留原顺序", () => {
    expect(topmostPaths(["D:\\repo\\b.ts", "D:\\repo\\a.ts"])).toEqual([
      "D:\\repo\\b.ts",
      "D:\\repo\\a.ts",
    ]);
  });

  it("前缀相同的兄弟目录不会被误判为子项", () => {
    expect(topmostPaths(["D:\\repo", "D:\\repo-other"])).toEqual(["D:\\repo", "D:\\repo-other"]);
  });
});
