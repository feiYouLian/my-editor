/**
 * Code Run 输出优化（纯函数，零依赖）：
 * - 去 ANSI、折叠 \r 进度行
 * - 按运行器（python / node / java / curl）识别错误、警告、堆栈与文件位置
 * - cURL stdout 的 JSON 美化
 *
 * 只做文本分类与解析，不触碰 DOM；RunPanel 负责渲染与点击。
 */

export type RunStream = "stdout" | "stderr";
export type RunLineKind = "normal" | "error" | "warn" | "meta";

export interface RunLocation {
  path: string;
  /** 1 基行号 */
  line: number;
  /** 1 基列号（Node 提供） */
  col?: number;
}

/** ANSI 转义序列（CSI / OSC / 单字符 ESC） */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-_])/g;

/** 去 ANSI 颜色 / 光标控制序列 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * 折叠 \r 进度行：curl/下载类工具用 \r 覆盖同一行，
 * 只保留最后一个非空片段，避免输出面板被进度条刷屏。
 */
export function collapseCarriageReturns(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r").filter((part) => part.length > 0);
      return parts.length > 0 ? parts[parts.length - 1] : "";
    })
    .join("\n");
}

function isPythonError(line: string): boolean {
  return (
    /^Traceback \(most recent call last\):/.test(line) ||
    /^\s+File ".+", line \d+/.test(line) ||
    /^[A-Za-z_][\w.]*(Error|Exception):/.test(line) ||
    /^SyntaxError\b/.test(line)
  );
}

function isNodeError(line: string): boolean {
  return (
    /^Uncaught\s/.test(line) ||
    /^UnhandledPromiseRejection/.test(line) ||
    /^[A-Za-z_$][\w.$]*(Error|Exception):/.test(line) ||
    /^Error:/.test(line)
  );
}

function isJavaError(line: string): boolean {
  return (
    /^Exception in thread\b/.test(line) ||
    /^Caused by:/.test(line) ||
    /^[A-Za-z_$][\w.$]*(Exception|Error)(:|\s|$)/.test(line) ||
    /^(error|错误):/.test(line)
  );
}

function isWarning(line: string): boolean {
  return (
    /^(?:\(node:\d+\)\s*)?(\[?Warning\]?|ExperimentalWarning):/.test(line) ||
    /^warning:/.test(line) ||
    /\b[A-Za-z]*Warning:/.test(line)
  );
}

/** 按运行器与输出流给单行分类（stderr 默认按错误展示） */
export function classifyRunLine(
  runner: string,
  line: string,
  stream: RunStream,
): RunLineKind {
  const text = line.trimEnd();
  if (!text.trim()) return "normal";
  if (isWarning(text)) return "warn";

  if (runner === "python") {
    if (isPythonError(text)) return "error";
    if (/^\s+[\^~]+$/.test(text)) return "meta";
  } else if (runner === "node") {
    if (isNodeError(text)) return "error";
    if (/^\s{2,}at\s/.test(text)) return "meta";
    if (/^\s+[\^~]+$/.test(text)) return "meta";
  } else if (runner === "java") {
    if (isJavaError(text)) return "error";
    if (/^\s+at\s/.test(text)) return "meta";
  } else if (runner === "curl") {
    if (/^curl: \(\d+\)/.test(text)) return "error";
  }
  return stream === "stderr" ? "error" : "normal";
}

/** file:///C:/x → C:/x；并做百分号解码 */
function normalizeFileUrl(raw: string): string {
  let path = raw;
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\//i, "");
    // file:///C:/x 去掉多余的前导斜杠（Windows 盘符）
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 从一行输出提取可点击的文件位置（Python / Node / Java） */
export function parseRunLocation(runner: string, line: string): RunLocation | null {
  if (runner === "python") {
    const m = /File "([^"]+)", line (\d+)/.exec(line);
    if (m && !m[1].startsWith("<")) return { path: normalizeFileUrl(m[1]), line: Number(m[2]) };
    return null;
  }
  if (runner === "node") {
    // at fn (path:line:col) / at path:line:col
    const inParen = /\((.+?):(\d+):(\d+)\)\s*$/.exec(line);
    const bare = /^\s+at\s+(.+?):(\d+):(\d+)\s*$/.exec(line);
    const m = inParen ?? bare;
    if (m) {
      const raw = m[1].replace(/^async\s+/, "");
      // Node 内部帧（node:internal/...）不是可打开的文件
      if (raw.startsWith("node:") || raw.startsWith("internal/")) return null;
      return {
        path: normalizeFileUrl(raw),
        line: Number(m[2]),
        col: Number(m[3]),
      };
    }
    return null;
  }
  if (runner === "java") {
    const stack = /\(([^()]+\.java):(\d+)\)/.exec(line);
    if (stack) return { path: stack[1], line: Number(stack[2]) };
    const compile = /^(.+\.java):(\d+):\s*(?:error|warning)/.exec(line);
    if (compile) return { path: compile[1], line: Number(compile[2]) };
    return null;
  }
  return null;
}

/** cURL stdout 若为 JSON 则美化；否则原样返回 */
export function formatCurlStdout(text: string): { text: string; json: boolean } {
  const trimmed = text.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return { text, json: false };
  }
  try {
    return { text: `${JSON.stringify(JSON.parse(trimmed), null, 2)}\n`, json: true };
  } catch {
    return { text, json: false };
  }
}

/** 相对路径按运行目录拼接（用于堆栈位置跳转） */
export function resolveRunPath(cwd: string, raw: string): string {
  if (!cwd) return raw;
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(raw)) return raw;
  return `${cwd.replace(/[\\/]+$/, "")}/${raw.replace(/^[\\/]+/, "")}`;
}

/** 运行耗时展示：1 秒以上改用秒 */
export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}
