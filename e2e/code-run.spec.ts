import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

// 一直输出、不退出：用来验证「运行中」状态与停止按钮
const SCRIPT = `console.log("started");
setInterval(() => console.log("tick"), 500);
`;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-"));
  const file = join(dir, "loop.js");
  await writeFile(file, SCRIPT, "utf8");

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

test("Code Run：运行中可停止，进程树被终止", async () => {
  await expect(page.locator(".tab.active")).toContainText("loop.js");
  await expect(page.locator("#btn-run")).toBeEnabled();

  await page.locator("#btn-run").click();
  await expect(page.locator("#run-output")).toBeVisible();
  await expect(page.locator("#btn-run")).toContainText("停止");
  await expect(page.locator(".run-body")).toContainText("started", { timeout: 15_000 });

  await page.locator("#btn-run").click();
  await expect(page.locator(".run-status")).toContainText("已停止", { timeout: 15_000 });
  await expect(page.locator("#btn-run")).toContainText("运行");
});
