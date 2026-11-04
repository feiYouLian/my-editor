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

// 两份文档都带 `-->` 箭头：这正是「源码被消毒器丢掉」的触发条件
const OK_DOC = `# 正常图表

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`;

const BAD_DOC = `# 错误图表

\`\`\`mermaid
graph TD
  A -->
\`\`\`

正文仍然可读。
`;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-"));
  await writeFile(join(dir, "ok.md"), OK_DOC, "utf8");
  await writeFile(join(dir, "bad.md"), BAD_DOC, "utf8");

  app = await launchApp([join(dir, "ok.md"), join(dir, "bad.md")]);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
});

test.afterAll(async () => {
  await browser?.close();
  if (app) killApp(app);
  await rm(dir, { recursive: true, force: true });
});

test("Mermaid 正常渲染：占位块替换为 SVG，源码不留在页面上", async () => {
  await page.locator(".tab", { hasText: "ok.md" }).click();
  await page.locator('#preview-modes button[data-mode="split"]').click();

  const block = page.locator("#preview-pane .md-mermaid");
  await expect(block).toHaveClass(/rendered/, { timeout: 20_000 });
  await expect(block.locator("svg")).toBeVisible();
  await expect(block.locator(".md-mermaid-src")).toHaveCount(0);
});

test("Mermaid 语法错误时降级：给出原因与源码，正文不受影响", async () => {
  await page.locator(".tab", { hasText: "bad.md" }).click();
  await page.locator('#preview-modes button[data-mode="split"]').click();

  const error = page.locator("#preview-pane .md-mermaid-error");
  await expect(error).toBeVisible({ timeout: 20_000 });
  await expect(error).toContainText("Mermaid 渲染失败");

  // 源码保留，用户能从预览里直接看到写错的图定义
  await expect(page.locator("#preview-pane .md-mermaid pre")).toContainText("graph TD");

  // 同一个文档的其它块照常渲染（降级只作用于失败块）
  await expect(page.locator("#preview-pane .preview-content h1")).toHaveText("错误图表");
  await expect(page.locator("#preview-pane .preview-content")).toContainText("正文仍然可读");
});
