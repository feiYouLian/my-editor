import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;
let bigPath: string;

const MB = 1024 * 1024;

function markdownDoc(): string {
  const sections = Array.from(
    { length: 120 },
    (_, i) => `## 小节 ${i}\n\n正文 ${i}：用于验证双栏滚动联动。\n`,
  );
  return `# 标题\n\n${sections.join("\n")}`;
}

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-"));
  const md = join(dir, "notes.md");
  bigPath = join(dir, "app.log");
  const big = bigPath;
  await writeFile(md, markdownDoc(), "utf8");
  // 单行控制在 110 字符左右：避免命中「单行超长」提示，专测体积分流
  const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i} ${"x".repeat(96)}`);
  const payload = lines.join("\n");
  expect(payload.length).toBeGreaterThan(20 * MB);
  await writeFile(big, payload, "utf8");

  app = await launchApp([md, big]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await removeDir(dir);
});

test("超过 20MB 的文件进入只读虚拟视图", async () => {
  await page.locator(".tab", { hasText: "app.log" }).click();

  await expect(page.locator("#large-view")).toBeVisible();
  await expect(page.locator("#status-readonly")).toBeVisible();
  await expect(page.locator("#status-readonly")).toContainText("只读");
});

test("大文件视图：过滤命中，清除后可按行号跳转", async () => {
  await page.locator(".tab", { hasText: "app.log" }).click();
  await expect(page.locator("#large-view")).toBeVisible();

  const filter = page.getByPlaceholder("过滤行（留空显示全部）");
  await filter.fill("line 150000 ");
  await filter.press("Enter");
  await expect(page.locator(".lv-status")).toContainText("命中 1 行", { timeout: 20_000 });
  await expect(page.locator(".lv-rows")).toContainText("line 150000", { timeout: 20_000 });

  // 过滤结果出口：导出到 <文件>.filtered.txt（视图仍只读）
  await page.locator("#large-view .lv-btn", { hasText: "导出命中" }).click();
  await expect
    // 文件尚未写出时 readFile 会抛 ENOENT：返回空串让 poll 继续重试
    .poll(() => readFile(`${bigPath}.filtered.txt`, "utf8").catch(() => ""), { timeout: 20_000 })
    .toContain("line 150000");

  // 清除过滤 → 回到全量行；再按行号定位
  await page.locator("#large-view .lv-btn", { hasText: "清除" }).click();
  await expect(page.locator(".lv-status")).not.toContainText("命中");

  await page.locator(".lv-goto").fill("1234");
  await page.locator("#large-view .lv-btn", { hasText: "跳转" }).click();
  await expect(page.locator(".lv-no").filter({ hasText: /^1234$/ })).toBeVisible();
});

test("Markdown 双栏：预览渲染并跟随编辑区滚动", async () => {
  await page.locator(".tab", { hasText: "notes.md" }).click();
  await page.locator('#preview-modes button[data-mode="split"]').click();

  await expect(page.locator("#preview-pane .preview-content h1")).toHaveText("标题");

  const preview = page.locator("#preview-pane .preview-content");
  await page.locator(".cm-scroller").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(() => preview.evaluate((el) => el.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(0);
});
