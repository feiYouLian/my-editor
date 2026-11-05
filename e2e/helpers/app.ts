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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
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
export async function launchApp(
  args: string[] = [],
  opts: { configDir?: string } = {},
): Promise<ChildProcess> {
  if (!existsSync(EXE)) {
    throw new Error(
      `未找到调试版应用：${EXE}\n先执行 npm run build:e2e（注入 CDP 端口并构建调试版）`,
    );
  }
  // 单实例插件会把新进程转交给已有窗口：端口已占用时必须先清理，否则测的是上一次的实例
  if (await cdpReady()) {
    throw new Error(`调试端口 ${PORT} 已被占用：先结束残留的 my-editor 进程再跑 E2E`);
  }
  const configDir = opts.configDir ?? mkdtempSync(join(tmpdir(), "my-editor-e2e-profile-"));
  const out: string[] = [];
  const err: string[] = [];
  const child = spawn(EXE, args, {
    env: {
      ...process.env,
      MY_EDITOR_CONFIG_DIR: configDir,
      // WebView2 的 localStorage / sessionStorage 也按用例隔离（默认是所有实例共用）
      WEBVIEW2_USER_DATA_FOLDER: join(configDir, "webview"),
      // 双保险：窗口参数里已烧入端口（scripts/build-debug-e2e.mjs），这里再走环境变量通道
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => pushTail(out, d));
  child.stderr?.on("data", (d: Buffer) => pushTail(err, d));
  if (child.pid !== undefined) profiles.set(child.pid, configDir);
  try {
    await waitForCdp();
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${await diagnose(child, configDir, out, err)}`);
  }
  return child;
}

/** 只保留末尾几 KB，避免诊断信息本身撑爆错误输出 */
function pushTail(buf: string[], chunk: Buffer): void {
  buf.push(chunk.toString("utf8"));
  while (buf.join("").length > 4096) buf.shift();
}

/** CDP 起不来时给出可行动的现场信息（进程状态 / WebView2 运行时 / 输出 / 应用日志） */
async function diagnose(
  child: ChildProcess,
  configDir: string,
  out: string[],
  err: string[],
): Promise<string> {
  const lines: string[] = ["—— 诊断信息 ——"];
  lines.push(
    child.exitCode === null
      ? "进程状态: 仍在运行（WebView 未开调试端口）"
      : `进程状态: 已退出 code=${child.exitCode} signal=${child.signalCode}`,
  );
  const wv2 = spawnSync(
    "reg",
    [
      "query",
      "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
      "/v",
      "pv",
    ],
    { encoding: "utf8" },
  );
  lines.push(
    wv2.status === 0
      ? `WebView2 运行时: ${wv2.stdout.trim().split(/\r?\n/).pop()}`
      : "WebView2 运行时: 注册表无记录（可能未安装）",
  );
  if (out.length) lines.push(`stdout:\n${out.join("")}`);
  if (err.length) lines.push(`stderr:\n${err.join("")}`);
  const log = join(configDir, "logs", "app.log");
  try {
    const text = readFileSync(log, "utf8");
    lines.push(`app.log 末尾:\n${text.split(/\r?\n/).slice(-15).join("\n")}`);
  } catch {
    lines.push(`app.log: 不存在（${log}）`);
  }
  return lines.join("\n");
}

/** 等上一次实例彻底退出、调试端口释放（重启恢复类用例用） */
export async function waitForPortFree(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await cdpReady())) return;
    await delay(200);
  }
  throw new Error(`调试端口 ${PORT} 在 ${timeoutMs}ms 内未释放`);
}

async function waitForCdp(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpReady()) return;
    await delay(250);
  }
  throw new Error(`WebView2 调试端口 ${PORT} 在 ${timeoutMs}ms 内未就绪`);
}

/** 结束整个进程树并清理临时配置目录（keepProfile=true 时保留，用于重启恢复类用例） */
export function killApp(child: ChildProcess, opts: { keepProfile?: boolean } = {}): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (child.exitCode === null) {
    // /T 带上 WebView2 子进程，/F 强制；否则残留进程会占着单实例锁
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  }
  const dir = profiles.get(pid);
  profiles.delete(pid);
  if (!dir || opts.keepProfile) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // WebView2 可能还短暂占着文件：留给系统临时目录清理，用例不受影响
  }
}

/**
 * 删除临时目录。应用刚退出时 Windows 可能还占着文件句柄（监听器 / Git 进程），
 * 直接 rm 会 EBUSY，带重试等它释放。
 */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
