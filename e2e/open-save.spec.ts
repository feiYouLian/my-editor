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
let file: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-"));
  file = join(dir, "示例.txt");
  await writeFile(file, "hello\n", "utf8");

  // 命令行传文件 = 文件关联 / 拖到 exe 上的真实入口
  app = await launchApp([file]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await rm(dir, { recursive: true, force: true });
});

test("打开文件后编辑并保存：内容真实落盘", async () => {
  await expect(page.locator(".tab.active")).toContainText("示例.txt");
  await expect(page.locator(".cm-content")).toContainText("hello");

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" tail");
  await page.keyboard.press("Control+S");

  await expect.poll(async () => readFile(file, "utf8"), { timeout: 10_000 }).toContain("tail");
});
