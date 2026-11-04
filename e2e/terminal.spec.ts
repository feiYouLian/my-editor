import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { killApp, launchApp, PORT } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  app = await launchApp();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
});

test("内置终端：多会话并存、可切换与关闭", async () => {
  await page.locator("#btn-terminal").click();

  const panel = page.locator("#terminal-panel");
  const tabs = panel.locator(".terminal-tab");
  await expect(panel).toBeVisible();
  await expect(tabs).toHaveCount(1);
  // shell 名由后端返回（pwsh / powershell），不写死具体值
  await expect(panel.locator(".terminal-shell")).not.toBeEmpty();
  await expect(panel.locator(".xterm")).toHaveCount(1);

  await panel.locator('button[title="新建终端"]').click();
  await expect(tabs).toHaveCount(2);
  await expect(panel.locator(".xterm")).toHaveCount(2);

  // 切回第一个会话：只有一个标签是 active
  await tabs.first().click();
  await expect(tabs.first()).toHaveClass(/active/);
  await expect(tabs.nth(1)).not.toHaveClass(/active/);

  await panel.locator('button[title="关闭当前终端"]').click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveClass(/active/);
});
