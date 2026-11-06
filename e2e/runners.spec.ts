import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-runners-"));
  // .md → 语言键 markdown（默认映射），内置运行器不认识它，正好走扩展路径。
  // 内容写成合法 JS：安全的运行器形态是 node __PLACEHOLDER__，输出即文件内容。
  const file = join(dir, "hello.md");
  await writeFile(file, 'console.log("runner-ok-123")\n', "utf8");

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

/**
 * promptText 对话框：按标题定位（连续弹窗时旧框还在淡出，`.dialog` 会命中多个），
 * 填入后**真实点击**「确定」——click 会做命中测试，对话框若被设置中心盖住就会失败。
 */
async function answerPrompt(heading: string, text: string): Promise<void> {
  const dialog = page.locator(".dialog", { hasText: heading });
  await expect(dialog).toBeVisible();
  await dialog.locator(".dialog-input").fill(text);
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function openRunnerSettings(): Promise<Locator> {
  await page.locator('#menubar button[data-menu="settings"]').click();
  await page.getByText("设置中心…", { exact: true }).click();
  const settings = page.locator(".settings-dialog");
  await expect(settings).toBeVisible();
  await settings.getByText("文件与会话", { exact: true }).click();
  await expect(settings).toContainText("Code Run 运行器");
  return settings;
}

test("设置页新增运行器后 Code Run 立即可用", async () => {
  await expect(page.locator(".tab.active")).toContainText("hello.md");

  const settings = await openRunnerSettings();
  await page.locator(".settings-action-btn", { hasText: "添加运行器" }).click();
  await answerPrompt("语言键", "markdown");
  await answerPrompt("可执行文件名", "node");
  await answerPrompt("参数", "__PLACEHOLDER__");

  // 列表即时刷新出新条目（配置热更新）
  await expect(settings).toContainText("markdown → node __PLACEHOLDER__");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(settings).toBeHidden();

  // F5 / 运行按钮走同一条 Code Run 链路：自定义运行器也能跑
  await page.locator("#btn-run").click();
  await expect(page.locator(".run-body")).toContainText("runner-ok-123", { timeout: 20_000 });
  await expect(page.locator("#btn-run")).toContainText("运行");
});

test("shell / 脚本宿主不得配置为运行器 program", async () => {
  const settings = await openRunnerSettings();
  await page.locator(".settings-action-btn", { hasText: "添加运行器" }).click();
  await answerPrompt("语言键", "shelltest");
  await answerPrompt("可执行文件名", "cmd");

  // 前端预检拦下并给出原因；配置不落盘
  const err = page.locator(".dialog.error-dialog", { hasText: "运行器配置有误" });
  await expect(err).toBeVisible();
  await expect(err).toContainText("shell");
  await err.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(err).toBeHidden();
  await expect(settings).not.toContainText("shelltest");
});
