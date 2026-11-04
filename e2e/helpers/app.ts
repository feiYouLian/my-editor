/**
 * E2E 启动器：拉起调试版应用，经 WebView2 的远程调试端口接入 Playwright。
 *
 * 不使用 tauri-driver + WebDriver：那套要额外装 tauri-driver 与版本匹配的
 * msedgedriver，而 WebView2 自带 CDP 端点，Playwright 可直接连上。
 * 前提：先构建 `npm run tauri build -- --debug --no-bundle`。
 *
 * 每次启动用独立的配置目录（调试构建的 MY_EDITOR_CONFIG_DIR）：会话 / 草稿 /
 * 日志都落在临时目录，既不把测试标签写进真实 session.json，也不会跨用例互相污染。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const PORT = Number(process.env.MY_EDITOR_E2E_PORT ?? 9223);

const EXE = join(process.cwd(), "src-tauri", "target", "debug", "my-editor.exe");

/** pid → 临时配置目录，退出时一并清理 */
const profiles = new Map<number, string>();

async function cdpReady(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 启动应用。args 与「用 my-editor 打开 / 把文件拖到 exe 上」同一条路径：
 * 文件路径经 cli.rs 入队，前端就绪后统一打开；原生文件对话框不在 WebView 内，
 * CDP 点不到，需要选文件时一律走这条入口。
 */
export async function launchApp(args: string[] = []): Promise<ChildProcess> {
  if (!existsSync(EXE)) {
    throw new Error(
      `未找到调试版应用：${EXE}\n先执行 npm run tauri build -- --debug --no-bundle`,
    );
  }
  // 单实例插件会把新进程转交给已有窗口：端口已占用时必须先清理，否则测的是上一次的实例
  if (await cdpReady()) {
    throw new Error(`调试端口 ${PORT} 已被占用：先结束残留的 my-editor 进程再跑 E2E`);
  }
  const configDir = mkdtempSync(join(tmpdir(), "my-editor-e2e-profile-"));
  const child = spawn(EXE, args, {
    env: {
      ...process.env,
      MY_EDITOR_CONFIG_DIR: configDir,
      // WebView2 读取该变量并打开 CDP 端口；只影响调试，不影响应用行为
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  if (child.pid !== undefined) profiles.set(child.pid, configDir);
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

/** 结束整个进程树并清理临时配置目录 */
export function killApp(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (child.exitCode === null) {
    // /T 带上 WebView2 子进程，/F 强制；否则残留进程会占着单实例锁
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  }
  const dir = profiles.get(pid);
  profiles.delete(pid);
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // WebView2 可能还短暂占着文件：留给系统临时目录清理，用例不受影响
  }
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
