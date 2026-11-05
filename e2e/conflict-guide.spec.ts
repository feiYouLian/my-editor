import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";
import { openSidebarView } from "./helpers/sidebar";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

/** 仓库内执行 git；allowFail 用于预期非零的 merge */
function git(args: string[], allowFail = false): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  return r.stdout;
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-conflict-"));
  const file = join(dir, "f.txt");
  await writeFile(file, "base\n", "utf8");

  git(["init", "-b", "main"]);
  git(["config", "user.name", "e2e"]);
  git(["config", "user.email", "e2e@example.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);

  git(["checkout", "-b", "other"]);
  await writeFile(file, "other side\n", "utf8");
  git(["commit", "-am", "other"]);

  git(["checkout", "main"]);
  await writeFile(file, "main side\n", "utf8");
  git(["commit", "-am", "main"]);

  git(["merge", "other"], true); // 预期冲突：非零退出

  app = await launchApp([dir]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await expect(page.locator("#ws-name")).toHaveText(join(dir).split(/[\\/]/).pop()!, {
    timeout: 20_000,
  });
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await removeDir(dir);
});

test("冲突引导：打开文件、跳到标记、一键标记已解决", async () => {
  await openSidebarView(page, "git");

  const banner = page.locator(".git-conflict-banner");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await banner.getByRole("button", { name: "处理冲突" }).click();

  const dialog = page.locator('[aria-label="Git 冲突处理"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("f.txt");

  // 动作一：打开冲突文件
  await dialog.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".tab.active")).toContainText("f.txt");
  await expect(page.locator(".cm-content")).toContainText("<<<<<<<");

  // 动作二：跳到下一个标记；只有一个标记，第二次点击应给出「没有了」的提示
  const jump = dialog.getByRole("button", { name: "跳到下一个冲突标记" });
  await jump.click();
  await jump.click();
  await expect(dialog.locator(".git-conflict-hint")).toContainText("没有更多");

  // 动作三：标记已解决 = git add；暂存区应出现该文件
  await dialog.getByRole("button", { name: "标记已解决" }).click();
  await expect(dialog.locator(".git-conflict-row.resolved")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => git(["diff", "--cached", "--name-only"]), { timeout: 15_000 })
    .toContain("f.txt");
});
