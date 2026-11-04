import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-ws-"));
  await writeFile(join(dir, "a.txt"), "alpha\n", "utf8");
  await mkdir(join(dir, "sub"));

  // 目录参数 = 打开为工作区（与「打开方式」/ 拖到 exe 上同一条入口）
  app = await launchApp([dir]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await removeDir(dir);
});

test("命令行传目录：作为工作区打开并列出文件", async () => {
  await expect(page.locator("#ws-name")).toHaveText(basename(dir));

  const tree = page.locator("#file-tree");
  await expect(tree).toContainText("a.txt");
  await expect(tree).toContainText("sub");

  // 点文件树里的文件 → 打开标签并可编辑
  await tree.getByText("a.txt", { exact: true }).click();
  await expect(page.locator(".tab.active")).toContainText("a.txt");
  await expect(page.locator(".cm-content")).toContainText("alpha");
});

test("文件树跟随外部增删刷新", async () => {
  const tree = page.locator("#file-tree");

  // 外部新建：目录监听触发增量刷新，不需要手动点刷新
  await writeFile(join(dir, "b.txt"), "beta\n", "utf8");
  await expect(tree).toContainText("b.txt", { timeout: 15_000 });

  // 外部删除同样要反映到树上，且不留下点不到的旧行
  await rm(join(dir, "b.txt"));
  await expect(tree).not.toContainText("b.txt", { timeout: 15_000 });
});
