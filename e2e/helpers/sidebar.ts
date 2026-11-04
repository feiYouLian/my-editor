import { expect, type Page } from "@playwright/test";

/**
 * 展开侧栏分区。
 *
 * 侧栏布局由配置恢复，恢复动作可能晚于用例的首次点击（会把刚展开的分区再收回去），
 * 所以不能用「点一次就当展开」；用 toPass 反复确认 aria-expanded，直到真正稳定展开。
 */
export async function openSidebarView(page: Page, view: "git" | "search"): Promise<void> {
  const head = page.locator(`#sidebar-sections [data-view="${view}"]`);
  await expect(async () => {
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 10_000 });
  await expect(page.locator(`#sidebar-${view}`)).toBeVisible();
}
