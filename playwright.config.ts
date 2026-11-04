import { defineConfig } from "@playwright/test";

// E2E 直接连接真实 Tauri 应用（WebView2 的 CDP 端点），不启动 Playwright 自带浏览器，
// 因此无需 `npx playwright install`。跑之前先构建调试版应用：
//   npm run tauri build -- --debug --no-bundle
// 单实例插件要求同一时间只跑一个应用实例，所以固定 workers = 1。
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
});
