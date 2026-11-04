import { chromium, expect, test } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT, removeDir, waitForPortFree } from "./helpers/app";
import type { Browser, Page } from "@playwright/test";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;
let profile: string;
let file: string;

async function connect(): Promise<{ browser: Browser; page: Page }> {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = b.contexts()[0];
  const p = context.pages()[0] ?? (await context.waitForEvent("page"));
  return { browser: b, page: p };
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-"));
  profile = await mkdtemp(join(tmpdir(), "my-editor-e2e-profile-"));
  file = join(dir, "示例.txt");
  await writeFile(file, "hello\n", "utf8");

  app = await launchApp([file], { configDir: profile });
  ({ browser, page } = await connect());
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await removeDir(dir);
  await removeDir(profile);
});

test("异常退出后重启：未保存内容从草稿恢复", async () => {
  await expect(page.locator(".tab.active")).toContainText("示例.txt");

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" tail");

  // 草稿写入是「输入防抖 1s + 空闲 1.5s」：看到徽标才说明已落盘
  await expect(page.locator("#status-draft")).toBeVisible({ timeout: 15_000 });

  // 非正常退出：不 flush、不删配置目录
  await browser.close();
  killApp(app, { keepProfile: true });
  await waitForPortFree();

  app = await launchApp([], { configDir: profile });
  ({ browser, page } = await connect());

  // 重启后草稿自动恢复：内容还在，且仍是未保存状态
  await expect(page.locator(".tab.active")).toContainText("示例.txt");
  await expect(page.locator(".cm-content")).toContainText("tail");
  await expect(page.locator("#status-message")).toContainText("已自动恢复");
  await expect(page.locator("#status-dirty")).toBeVisible();

  // 磁盘内容没被这次编辑写脏
  expect((await readFile(file, "utf8")).trim()).toBe("hello");
});
