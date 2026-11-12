import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

const ORIGINAL = "one\ntwo\nthree\n";
const EDITED = "one\nTWO\nthree\n";

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-compare-"));
  const file = join(dir, "a.txt");
  await writeFile(file, ORIGINAL, "utf8");
  app = await launchApp([file]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await removeDir(dir);
});

test("灵活比较：当前标签 ⇄ 手输内容，编辑停顿后自动重算", async () => {
  await expect(page.locator(".tab", { hasText: "a.txt" })).toBeVisible({ timeout: 20_000 });
  await page.locator("#editor .cm-content").click();

  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".palette-input");
  await input.fill("灵活比较");
  await page.locator(".palette-item").first().click();

  await expect(page.locator(".compare-dialog")).toBeVisible();
  const areas = page.locator(".compare-text");
  // 左侧自动带入当前标签（含未保存），右侧默认空文本
  await expect(areas.nth(0)).toHaveValue(ORIGINAL);
  await expect(areas.nth(1)).toHaveValue("");

  // 右侧直接输入：停顿约半秒后自动重算，无需手动点按钮
  await areas.nth(1).fill(EDITED);
  const changeRow = page.locator(".df-row.df-change").first();
  await expect(changeRow).toBeVisible({ timeout: 15_000 });
  await expect(changeRow).toContainText("TWO");
  await expect(page.locator(".diff-stats")).toContainText("+1");
  await expect(page.locator(".diff-stats")).toContainText("-1");
  await expect(page.locator(".df-nav-info")).toHaveText("第 1 / 1 处");

  await page.getByRole("button", { name: "关闭灵活比较" }).click();
  await expect(page.locator(".compare-dialog")).toHaveCount(0);
});

test("灵活比较：当前选区可作为一侧，只比较某个代码块", async () => {
  // 选中编辑器第一行（one），再打开工作台把左侧切到「当前选区」
  await page.locator("#editor .cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");

  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".palette-input");
  await input.fill("灵活比较");
  await page.locator(".palette-item").first().click();
  await expect(page.locator(".compare-dialog")).toBeVisible();

  await page.locator(".compare-source").first().selectOption("selection");
  await expect(page.locator(".compare-text").nth(0)).toHaveValue("one");

  await page.getByRole("button", { name: "关闭灵活比较" }).click();
});
