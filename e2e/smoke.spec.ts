import { chromium, expect, test, type Browser } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { isAlive, killApp, launchApp, PORT } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;

test.beforeAll(async () => {
  app = await launchApp();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
});

test.afterAll(async () => {
  await browser?.close();
  if (!app) return;
  const pid = app.pid!;
  killApp(app);
  // 退出后不得残留进程（WebView2 子进程也要一起走）
  await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
});

test("应用可启动并渲染主界面", async () => {
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));

  // 不依赖欢迎页：会话恢复后首屏可能是已打开的标签，只断言常驻骨架
  await expect(page.locator(".logo")).toHaveText("my-editor");
  await expect(page.locator("#menubar")).toBeVisible();
  await expect(page.locator("#status-path")).toBeVisible();
  await expect(page.locator("#status-encoding")).toHaveText("UTF-8");
});
