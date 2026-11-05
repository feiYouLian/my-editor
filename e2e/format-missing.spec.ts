import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-fmt-"));
  // 默认 python 格式化器是 black：本机未安装，正好覆盖「缺工具」失败路径
  const file = join(dir, "x.py");
  await writeFile(file, "x=1\n", "utf8");

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

test("格式化缺工具：报错点明工具与配置位置，并提供一键打开配置", async () => {
  await expect(page.locator(".tab.active")).toContainText("x.py");
  // 走菜单而不是快捷键：快捷键依赖焦点与键位匹配，菜单是稳定的用户入口
  await page.locator('#menubar button[data-menu="edit"]').click();
  await page.getByText("格式化文档", { exact: true }).click();

  // 错误对话框：说清缺哪个工具、去哪里配
  const dialog = page.locator(".dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText("未找到格式化工具");
  await expect(dialog).toContainText("formatters");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // 通知里的可行动入口：直接打开 config.json（formatters 表所在文件）
  await page.locator("#status-notice").click();
  const action = page.locator(".notice-action", { hasText: "打开格式化配置" });
  await expect(action).toBeVisible();
  await action.click();

  await expect(page.locator(".tab.active")).toContainText("config.json");
  // 编辑器只渲染可视行：断言首屏就能看到的配置键，证明打开的是真实配置文件
  await expect(page.locator(".cm-content")).toContainText("largeFileThreshold");
});
