import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";
import { openSidebarView } from "./helpers/sidebar";

/**
 * 可发现性改造（v0.8.0）：命令面板按用途搜索、命令索引深链、
 * Git 历史可见入口与范围说明、导出补丁同名不静默覆盖。
 */

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  return r.stdout;
}

const ORIGINAL = "one\ntwo\nthree\n";
const EDITED = "one\ntwo\nTHREE\n";

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-disc-"));
  await writeFile(join(dir, "a.txt"), ORIGINAL, "utf8");

  git(["init"]);
  git(["config", "user.name", "e2e"]);
  git(["config", "user.email", "e2e@example.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  await writeFile(join(dir, "a.txt"), EDITED, "utf8");

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

test("命令面板：按用途搜索命中，列表项带一句话说明", async () => {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".palette-input");
  await expect(input).toBeVisible();

  await input.fill("查看改动记录");
  const first = page.locator(".palette-item").first();
  await expect(first.locator(".palette-item-title")).toContainText("查看提交历史");
  await expect(first.locator(".palette-item-desc")).not.toBeEmpty();

  // 详情区给出结果去向（会不会写盘 / 产物在哪）
  await expect(page.locator(".palette-detail-text")).toContainText("提交");

  // 用途词必须收敛到唯一命令：四条 diff 命令都能导出补丁，
  // 搜「发给别人 / git apply」时不能还有另一条「比较：」并列（并列最高分就是没收敛）
  for (const query of ["发给别人", "git apply"]) {
    await input.fill(query);
    await expect(page.locator(".palette-item-title").first()).toContainText("与 Git HEAD");
    const titles = await page.locator(".palette-item-title").allTextContents();
    expect(titles.slice(1).filter((t) => t.includes("比较："))).toHaveLength(0);
  }

  await page.keyboard.press("Escape");
  await expect(page.locator(".palette-overlay")).toHaveCount(0);
});

test("命令面板：Ctrl+Enter 打开命令索引并定位到该条", async () => {
  await page.keyboard.press("Control+Shift+P");
  await page.locator(".palette-input").fill("git.showHistory");
  await expect(page.locator(".palette-item").first()).toContainText("查看提交历史");

  await page.keyboard.press("Control+Enter");

  const help = page.locator(".help-dialog");
  await expect(help).toBeVisible();
  await expect(help.locator('[data-topic="commands"]')).toHaveClass(/active/);
  // 索引条目以 `### <id> · <标题>` 渲染，正文里必须能看到这条命令
  await expect(help.locator(".help-body")).toContainText("git.showHistory · Git：查看提交历史");

  await help.getByRole("button", { name: "关闭" }).click();
});

test("Git 侧栏有可见的「查看提交历史」，面板头部写明范围与操作", async () => {
  await openSidebarView(page, "git");

  const entry = page.getByRole("button", { name: "查看提交历史" });
  await expect(entry).toBeVisible();
  await entry.click();

  const panel = page.locator("#git-history-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".git-history-panel-scope")).toContainText("当前工作区");
  await expect(panel.locator(".git-history-panel-scope")).toContainText("↑↓");
  await expect(panel.locator(".git-history-panel-count")).toContainText("最近");
  await expect(panel.locator(".git-history-panel-item").first()).toBeVisible();

  // 详情区说明「改了 N 个文件」并给出两个动作
  await expect(panel.locator(".git-history-detail-meta")).toContainText("改了 1 个文件");
  await expect(panel.getByRole("button", { name: "复制 diff" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "导出为 .patch" })).toBeVisible();

  await panel.getByRole("button", { name: "关闭历史面板" }).click();
  await expect(panel).toBeHidden();
});

test("导出补丁同名时先问覆盖，换名字不丢旧文件", async () => {
  await openSidebarView(page, "git");
  const row = page.locator(".git-row", { hasText: "a.txt" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  const dialog = page.locator(".diff-dialog");
  await expect(dialog).toBeVisible();
  const exportBtn = dialog.getByRole("button", { name: "导出补丁" });

  // 第一次：直接写入 a.txt.patch
  await expect(exportBtn).toContainText("工作区 vs HEAD");
  await exportBtn.click();
  await expect(page.locator(".result-card-title")).toContainText("已导出统一 diff 补丁");
  await expect.poll(async () => readFile(join(dir, "a.txt.patch"), "utf8")).toContain("THREE");
  const firstPatch = await readFile(join(dir, "a.txt.patch"), "utf8");

  // 第二次：同名已存在，先不落盘，给「覆盖 / 换个名字」
  await exportBtn.click();
  const card = page.locator(".result-card").last();
  await expect(card.locator(".result-card-title")).toContainText("补丁已存在");
  // 悬停暂停自动收起，避免点到一半卡片消失
  await card.hover();
  await expect(card.locator(".result-card-action", { hasText: "覆盖" })).toBeVisible();
  const rename = card.locator(".result-card-action", { hasText: "换个名字" });
  await expect(rename).toBeVisible();
  await rename.click();

  // 换名字 → a.txt.1.patch，旧文件内容不变
  await expect.poll(async () => readFile(join(dir, "a.txt.1.patch"), "utf8")).toContain("THREE");
  expect(await readFile(join(dir, "a.txt.patch"), "utf8")).toBe(firstPatch);

  await dialog.getByRole("button", { name: "关闭差异面板" }).click();
  await expect(dialog).toBeHidden();
});
