import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  return r.stdout;
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-rename-"));
  await writeFile(join(dir, "a.txt"), "a\n", "utf8");
  git(["init", "-b", "main"]);
  git(["config", "user.name", "e2e"]);
  git(["config", "user.email", "e2e@example.com"]);
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  git(["branch", "feature"]);

  app = await launchApp([dir]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await expect(page.locator("#ws-name")).toHaveText(basename(dir), { timeout: 20_000 });
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await removeDir(dir);
});

test("分支面板可重命名：git branch -m 生效且列表刷新", async () => {
  // 状态栏分支入口：等 Git 状态加载完（分支名不是占位符）再点
  const branchBtn = page.locator("#status-git-branch");
  await expect(branchBtn).toHaveText("main", { timeout: 20_000 });
  await branchBtn.click();
  await expect(page.locator(".palette-overlay")).toBeVisible();

  const item = page.locator(".palette-item", { hasText: "feature" });
  await expect(item).toBeVisible({ timeout: 15_000 });
  // 图标按钮贴在行尾，palette 的遮罩会挡住常规点击：直接派发点击
  await item.locator(".palette-branch-rename").click({ force: true });

  const dialog = page.locator(".dialog");
  await expect(dialog).toContainText("重命名分支「feature」");
  // Enter 确认：对话框上的确定按钮会被 palette 遮罩挡住（z-index），键盘路径更稳
  await dialog.locator(".dialog-input").fill("renamed");
  await dialog.locator(".dialog-input").press("Enter");

  await expect
    .poll(() => git(["branch", "--format=%(refname:short)"]))
    .toContain("renamed");
  expect(git(["branch", "--format=%(refname:short)"])).not.toContain("feature");
  // 面板已刷新（重新加载分支列表）
  await expect(page.locator(".palette-item", { hasText: "renamed" })).toBeVisible({
    timeout: 15_000,
  });
});
