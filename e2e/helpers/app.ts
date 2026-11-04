/**
 * E2E 启动器：拉起调试版应用，经 WebView2 的远程调试端口接入 Playwright。
 *
 * 不使用 tauri-driver + WebDriver：那套要额外装 tauri-driver 与版本匹配的
 * msedgedriver，而 WebView2 自带 CDP 端点，Playwright 可直接连上。
 * 前提：先构建 `npm run tauri build -- --debug --no-bundle`。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const PORT = Number(process.env.MY_EDITOR_E2E_PORT ?? 9223);

const EXE = join(process.cwd(), "src-tauri", "target", "debug", "my-editor.exe");

async function cdpReady(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function launchApp(): Promise<ChildProcess> {
  if (!existsSync(EXE)) {
    throw new Error(
      `未找到调试版应用：${EXE}\n先执行 npm run tauri build -- --debug --no-bundle`,
    );
  }
  // 单实例插件会把新进程转交给已有窗口：端口已占用时必须先清理，否则测的是上一次的实例
  if (await cdpReady()) {
    throw new Error(`调试端口 ${PORT} 已被占用：先结束残留的 my-editor 进程再跑 E2E`);
  }
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      // WebView2 读取该变量并打开 CDP 端口；只影响调试，不影响应用行为
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  await waitForCdp();
  return child;
}

async function waitForCdp(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpReady()) return;
    await delay(250);
  }
  throw new Error(`WebView2 调试端口 ${PORT} 在 ${timeoutMs}ms 内未就绪`);
}

/** 结束整个进程树：WebView2 子进程不随主进程退出会占着单实例锁 */
export function killApp(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}

/** 进程是否还活着（用于断言「退出后无残留进程」） */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
