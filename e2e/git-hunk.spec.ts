import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";
import { readWhenWritten } from "./helpers/fs";
import { openSidebarView } from "./helpers/sidebar";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

/** 仓库内执行 git（不改全局配置） */
function git(args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  return r.stdout;
}

const ORIGINAL = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
const EDITED = "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n";

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-git-"));
  await writeFile(join(dir, "a.txt"), ORIGINAL, "utf8");

  git(["init"]);
  git(["config", "user.name", "e2e"]);
  git(["config", "user.email", "e2e@example.com"]);
  // 避免 Windows 全局 autocrlf 把整篇当成改写，干扰「只有一块差异」的前提
  git(["config", "core.autocrlf", "false"]);
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);

  // 只改一行：预期只有一个 hunk
  await writeFile(join(dir, "a.txt"), EDITED, "utf8");

  app = await launchApp([dir]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
  // 命令行目录是异步消费的：等工作区真正就位再操作 Git 面板
  await expect(page.locator("#ws-name")).toHaveText(basename(dir), { timeout: 20_000 });
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await removeDir(dir);
});

test("Git 差异：导出补丁，并只暂存当前差异块", async () => {
  await openSidebarView(page, "git");

  const row = page.locator(".git-row", { hasText: "a.txt" });
  await expect(row).toBeVisible({ timeout: 20_000 });

  // 单击看 diff（默认单击打开，见设置 → 文件与会话）
  await row.click();
  const dialog = page.locator(".diff-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("a.txt");

  // 导出补丁：写入 <文件>.patch，不弹保存对话框
  await dialog.getByRole("button", { name: "导出补丁" }).click();
  const patch = join(dir, "a.txt.patch");
  await expect
    .poll(() => readWhenWritten(patch), { timeout: 15_000 })
    .toContain("THREE");

  await dialog.getByRole("button", { name: "暂存此块" }).click();

  // 暂存区有该文件，工作区已无未暂存差异
  await expect
    .poll(() => git(["diff", "--cached", "--name-only"]), { timeout: 15_000 })
    .toContain("a.txt");
  await expect.poll(() => git(["diff", "--name-only"])).not.toContain("a.txt");
});
