import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv } from "./csv";

describe("detectDelimiter", () => {
  it("按每行出现次数稳定者优先", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
  });

  it("引号内的分隔符不算列分隔", () => {
    // 每行只有一个真分隔符（引号内的逗号不算）
    expect(detectDelimiter('"a,b,c";x\nd;y\n')).toBe(";");
  });

  it("没有分隔符时回退逗号", () => {
    expect(detectDelimiter("hello\nworld\n")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });
});

describe("parseCsv", () => {
  it("切行切列并保留空字段", () => {
    const table = parseCsv("a,b,c\n1,,3\n");
    expect(table.rows).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
    expect(table.totalRows).toBe(2);
    expect(table.columnCount).toBe(3);
    expect(table.truncated).toBe(false);
  });

  it("支持引号内的逗号 / 换行 / 双引号转义", () => {
    const table = parseCsv('id,note\n1,"a,b"\n2,"line1\nline2"\n3,"say ""hi"""\n');
    expect(table.rows[1]).toEqual(["1", "a,b"]);
    expect(table.rows[2]).toEqual(["2", "line1\nline2"]);
    expect(table.rows[3]).toEqual(["3", 'say "hi"']);
  });

  it("CRLF 不会多出空行", () => {
    const table = parseCsv("a,b\r\n1,2\r\n");
    expect(table.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("末行无换行也会被收进来", () => {
    expect(parseCsv("a,b\n1,2").rows).toHaveLength(2);
  });

  it("超过行数上限时截断并标记", () => {
    const table = parseCsv("a\nb\nc\nd\n", { maxRows: 2 });
    expect(table.rows).toHaveLength(2);
    expect(table.totalRows).toBe(4);
    expect(table.truncated).toBe(true);
  });

  it("超过列数上限时截断并标记", () => {
    const table = parseCsv("a,b,c,d\n", { maxCols: 2 });
    expect(table.rows[0]).toEqual(["a", "b"]);
    expect(table.truncated).toBe(true);
  });
});
