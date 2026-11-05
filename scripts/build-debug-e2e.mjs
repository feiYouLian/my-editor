/**
 * E2E 专用调试构建：把 CDP 端口烧进窗口的 additionalBrowserArgs。
 *
 * 为什么不只靠 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量：
 * wry 会显式设置 CoreWebView2EnvironmentOptions 的 AdditionalBrowserArguments，
 * 环境变量是否被合并取决于 WebView2 运行时版本（本地合并、CI runner 上未必），
 * 表现就是「端口永远起不来」。写进窗口参数走的是同一条 wry 通道，确定生效。
 *
 * 用法：npm run build:e2e（构建后还原 tauri.conf.json，仓库不会留下改动）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONF = join(ROOT, "src-tauri", "tauri.conf.json");
// 与 e2e/helpers/app.ts 的 PORT 保持一致（可用 MY_EDITOR_E2E_PORT 覆盖）
const PORT = Number(process.env.MY_EDITOR_E2E_PORT ?? 9223);

const original = readFileSync(CONF, "utf8");
try {
  const conf = JSON.parse(original);
  for (const win of conf.app.windows ?? []) {
    const args = String(win.additionalBrowserArgs ?? "");
    if (!args.includes("--remote-debugging-port=")) {
      win.additionalBrowserArgs = `${args} --remote-debugging-port=${PORT}`.trim();
    }
  }
  writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`, "utf8");
  console.log(`[build:e2e] 已注入 --remote-debugging-port=${PORT}，开始构建调试版…`);

  // shell: true —— Windows 上 Node 的 CVE-2024-27980 修复后，spawn .cmd 不带 shell 会 EINVAL
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(`${npm} run tauri build -- --debug --no-bundle`, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
  });
  process.exitCode = res.status ?? 1;
} finally {
  writeFileSync(CONF, original, "utf8");
}
