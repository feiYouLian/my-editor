import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killApp, launchApp, PORT, removeDir } from "./helpers/app";

/** GBK：「中文测试」+ 换行 */
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]);
/** UTF-8 的「中」：用来确认没有把内容转成 UTF-8 写回 */
const UTF8_ZHONG = Buffer.from([0xe4, 0xb8, 0xad]);

let app: ChildProcess;
let browser: Browser;
let page: Page;
let dir: string;
let file: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "my-editor-e2e-"));
  file = join(dir, "gbk.txt");
  await writeFile(file, GBK_BYTES);

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

async function pickEncoding(pattern: RegExp): Promise<void> {
  const before = (await page.locator("#status-message").textContent()) ?? "";
  await page.locator("#status-encoding").click();
  await page
    .locator(".context-menu .context-menu-item")
    .filter({ hasText: pattern })
    .first()
    .click();
  // 切换编码会让标签处于「编码与磁盘不一致」的脏状态，再切一次需确认丢弃当前解读
  await page.waitForTimeout(300);
  const confirm = page.locator(".dialog .dialog-actions button.danger");
  if ((await confirm.count()) > 0) await confirm.click();
  // 重读磁盘 + 重装编辑器是异步的：等新消息出现再继续，否则后续输入会被重载覆盖
  await expect(page.locator("#status-message")).not.toHaveText(before, { timeout: 10_000 });
}

test("GBK 文件：乱码可切回，保存后仍是原编码", async () => {
  // 自动检测或按记忆打开：中文应正常显示
  await expect(page.locator(".cm-content")).toContainText("中文测试");
  await expect(page.locator("#status-encoding")).toContainText(/GBK|GB18030/);

  // 按 UTF-8 解读 GBK 字节 → 乱码
  await pickEncoding(/^UTF-8/);
  await expect(page.locator("#status-encoding")).toContainText("UTF-8");
  await expect(page.locator(".cm-content")).not.toContainText("中文测试");

  // 切回 GBK → 内容恢复（不写盘，只换解读方式）
  await pickEncoding(/^GBK|^GB18030/);
  await expect(page.locator(".cm-content")).toContainText("中文测试");

  // 追加 ASCII 后保存：仍按 GBK 写盘，不能静默转成 UTF-8
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ok");
  // 确认输入落进编辑器再保存：重载后立刻打字可能被替换成新文档
  await expect(page.locator(".cm-content")).toContainText(" ok");
  await page.keyboard.press("Control+S");
  // 重载后偶发第一次 Ctrl+S 丢焦点：以「已保存」消息为准，没有就补点编辑器重试一次
  try {
    await expect(page.locator("#status-message")).toContainText("已保存", { timeout: 5_000 });
  } catch {
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+S");
    await expect(page.locator("#status-message")).toContainText("已保存", { timeout: 5_000 });
  }

  await expect.poll(async () => (await readFile(file)).toString("latin1")).toContain(" ok");
  const bytes = await readFile(file);
  expect(bytes.subarray(0, 8).equals(GBK_BYTES.subarray(0, 8))).toBe(true);
  expect(bytes.includes(UTF8_ZHONG)).toBe(false);
});
