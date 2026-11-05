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

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-runners-"));
  // .md → 语言键 markdown（默认映射），内置运行器不认识它，正好走扩展路径
  const file = join(dir, "hello.md");
  await writeFile(file, "runner-ok-123\n", "utf8");

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
 * 填入后 Enter 确认，等本框真正消失再返回。
 */
async function answerPrompt(heading: string, text: string): Promise<void> {
  const dialog = page.locator(".dialog", { hasText: heading });
  await expect(dialog).toBeVisible();
  await dialog.locator(".dialog-input").fill(text);
  await dialog.locator(".dialog-input").press("Enter");
  await expect(dialog).toBeHidden();
}

test("设置页新增运行器后 Code Run 立即可用", async () => {
  await expect(page.locator(".tab.active")).toContainText("hello.md");

  // 设置 → 文件与会话 → Code Run 运行器 → 添加
  await page.locator('#menubar button[data-menu="settings"]').click();
  await page.getByText("设置中心…", { exact: true }).click();
  const settings = page.locator(".settings-dialog");
  await expect(settings).toBeVisible();
  await settings.getByText("文件与会话", { exact: true }).click();
  await expect(settings).toContainText("Code Run 运行器");

  await page.locator(".settings-action-btn", { hasText: "添加运行器" }).click();
  await answerPrompt("语言键", "markdown");
  await answerPrompt("可执行文件名", "cmd");
  await answerPrompt("参数", "/c type __PLACEHOLDER__");

  // 列表即时刷新出新条目（配置热更新）
  await expect(settings).toContainText("markdown → cmd /c type __PLACEHOLDER__");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(settings).toBeHidden();

  // F5 / 运行按钮走同一条 Code Run 链路：自定义运行器也能跑
  await page.locator("#btn-run").click();
  await expect(page.locator(".run-body")).toContainText("runner-ok-123", { timeout: 20_000 });
  await expect(page.locator("#btn-run")).toContainText("运行");
});
