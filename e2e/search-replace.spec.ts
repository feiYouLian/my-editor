import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;
let one: string;
let two: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-ws-"));
  one = join(dir, "one.txt");
  two = join(dir, "two.txt");
  await writeFile(one, "needle one\nneedle two\n", "utf8");
  await writeFile(two, "needle three\n", "utf8");

  app = await launchApp([dir]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await rm(dir, { recursive: true, force: true });
});

test("全局搜索 → 批量替换 → 撤销上次替换", async () => {
  await page.locator('#sidebar-sections [data-view="search"]').click();
  const view = page.locator("#sidebar-search");
  await expect(view).toBeVisible();

  // 包含/排除规则会写进 localStorage：显式清空，避免上次会话的过滤条件把结果清成 0
  await view.getByPlaceholder(/包含/).fill("");
  await view.getByPlaceholder(/排除/).fill("");

  // 按 placeholder 定位：包含/排除 glob 也是 .sv-input，不能取「第一个」
  const query = view.getByPlaceholder(/搜索工作区/);
  await query.fill("needle");
  await query.press("Enter");
  await expect(view.locator(".sv-list")).toContainText("one.txt", { timeout: 20_000 });
  await expect(view.locator(".sv-list")).toContainText("two.txt");

  // 展开替换行，改成 hay 后批量替换（新结果默认全选文件）
  await view.locator('.sv-toggle[title="展开 / 收起替换行"]').click();
  await view.getByPlaceholder(/替换为/).fill("hay");
  await view.locator(".sv-replace-btn").filter({ hasText: "全部替换" }).click();
  await page.locator(".dialog button.danger").click();

  await expect.poll(async () => readFile(one, "utf8"), { timeout: 15_000 }).toContain("hay one");
  await expect.poll(async () => readFile(two, "utf8")).toContain("hay three");

  // 撤销：整批还原到替换前
  await view.getByRole("button", { name: "撤销上次替换" }).click();
  await page.locator(".dialog button.danger").click();

  await expect.poll(async () => readFile(one, "utf8"), { timeout: 15_000 }).toContain("needle one");
  await expect.poll(async () => readFile(two, "utf8")).toContain("needle three");
});
