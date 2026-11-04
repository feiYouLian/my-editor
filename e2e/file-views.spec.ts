import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT } from "./helpers/app";

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;

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
  const big = join(dir, "app.log");
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
  await rm(dir, { recursive: true, force: true });
});

test("超过 20MB 的文件进入只读虚拟视图", async () => {
  await page.locator(".tab", { hasText: "app.log" }).click();

  await expect(page.locator("#large-view")).toBeVisible();
  await expect(page.locator("#status-readonly")).toBeVisible();
  await expect(page.locator("#status-readonly")).toContainText("只读");
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
