import { describe, expect, it } from "vitest";
import { buildCommandTable, type CommandTableCtx } from "./commandTable";
import { normalizeNotation, parseNotation } from "../core/keyNotation";

/** 一级菜单 id（core/commands.ts 的 MENU_LABELS，未导出故在此固定） */
const MENU_IDS = new Set(["file", "edit", "select", "go", "view", "compare", "tools", "settings"]);

/**
 * 桩上下文：`buildCommandTable` 只在定义期读属性、不执行 `run`，
 * 所以任何属性读取返回空对象即可（`statusBar.showMessage` 解构为 undefined 也无妨）。
 */
function stubCtx(): CommandTableCtx {
  return new Proxy({} as CommandTableCtx, {
    get: () => ({}),
  });
}

const table = buildCommandTable(stubCtx());

describe("命令表数据完整性", () => {
  it("数量在预期量级（防止整段被误删）", () => {
    expect(table.length).toBeGreaterThan(100);
  });

  it("id 唯一（同 id 会在注册表里互相覆盖）", () => {
    const ids = table.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条命令都有 id / title / section / run", () => {
    for (const cmd of table) {
      expect(cmd.id, JSON.stringify(cmd)).toBeTruthy();
      expect(cmd.title, cmd.id).toBeTruthy();
      expect(cmd.section, cmd.id).toBeTruthy();
      expect(typeof cmd.run, cmd.id).toBe("function");
    }
  });

  it("defaultKey 都是可解析的记法", () => {
    for (const cmd of table) {
      const key = cmd.defaultKey;
      if (key === undefined || key === "") continue;
      expect(parseNotation(key), `${cmd.id} → ${key}`).not.toBeNull();
    }
  });

  it("defaultKey 已归一化（字母主键为大写）", () => {
    for (const cmd of table) {
      const key = cmd.defaultKey;
      if (!key) continue;
      expect(normalizeNotation(key), cmd.id).toBe(key);
    }
  });

  it("没有两个命令抢同一个键位", () => {
    const owner = new Map<string, string>();
    for (const cmd of table) {
      const keys = [cmd.defaultKey, ...(cmd.altKeys ?? [])].filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      );
      for (const key of keys) {
        const prev = owner.get(key);
        expect(prev, `键位 ${key} 同时被 ${prev} 与 ${cmd.id} 占用`).toBeUndefined();
        owner.set(key, cmd.id);
      }
    }
  });

  it("fixed（编辑器内置、不可重绑）必须有 defaultKey", () => {
    for (const cmd of table) {
      if (cmd.fixed) expect(cmd.defaultKey, cmd.id).toBeTruthy();
    }
  });

  it("menu 只落在已知的一级菜单上", () => {
    for (const cmd of table) {
      if (cmd.menu === undefined) continue;
      expect(MENU_IDS.has(cmd.menu), `${cmd.id} → menu=${cmd.menu}`).toBe(true);
    }
  });

  it("菜单项有排序值时是有限数字", () => {
    for (const cmd of table) {
      if (cmd.menuOrder === undefined) continue;
      expect(Number.isFinite(cmd.menuOrder), cmd.id).toBe(true);
    }
  });
});
