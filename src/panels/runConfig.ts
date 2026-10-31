/**
 * Code Run 运行配置（G10）：超时、输出上限、环境变量、stdin。
 * 存 localStorage（全局生效）；后端会再做上限与合法性校验。
 */

const STORAGE_KEY = "my-editor.runConfig";
export const DEFAULT_TIMEOUT_SECS = 30;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RunConfig {
  timeoutSecs: number;
  maxOutputBytes: number;
  /** 每行一个 KEY=VALUE */
  env: string;
  /** 作为进程 stdin 的文本 */
  stdin: string;
}

export function loadRunConfig(): RunConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<RunConfig>;
    return {
      timeoutSecs:
        typeof raw.timeoutSecs === "number" && raw.timeoutSecs > 0
          ? raw.timeoutSecs
          : DEFAULT_TIMEOUT_SECS,
      maxOutputBytes:
        typeof raw.maxOutputBytes === "number" && raw.maxOutputBytes > 0
          ? raw.maxOutputBytes
          : DEFAULT_MAX_OUTPUT_BYTES,
      env: typeof raw.env === "string" ? raw.env : "",
      stdin: typeof raw.stdin === "string" ? raw.stdin : "",
    };
  } catch {
    return {
      timeoutSecs: DEFAULT_TIMEOUT_SECS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      env: "",
      stdin: "",
    };
  }
}

export function saveRunConfig(config: RunConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage 不可用时仅本次会话生效（由调用方保持对象）
  }
}

/** 解析 KEY=VALUE 文本；空行 / # 注释 / 无等号行忽略 */
export function parseEnv(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    pairs.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return pairs;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) ? 1 : 0)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export class RunConfigDialog {
  private backdrop: HTMLElement | null = null;

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
  }

  open(onSave: (config: RunConfig) => void): void {
    if (this.isOpen) return;
    const current = loadRunConfig();

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "dialog dialog-wide";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "运行配置");

    const title = document.createElement("h3");
    title.textContent = "运行配置";
    const hint = document.createElement("p");
    hint.className = "dialog-text";
    hint.textContent =
      "仅对「运行当前文件」生效；超时 1–600 秒，输出上限 64KB–10MB，stdin 最多 1MB。";
    dialog.append(title, hint);

    const grid = document.createElement("div");
    grid.className = "dialog-fields";
    const timeoutLabel = document.createElement("label");
    timeoutLabel.textContent = "超时（秒）";
    const timeout = document.createElement("input");
    timeout.type = "number";
    timeout.min = "1";
    timeout.max = "600";
    timeout.className = "dialog-input";
    timeout.value = String(current.timeoutSecs);
    const outputLabel = document.createElement("label");
    outputLabel.textContent = "输出上限（MB）";
    const output = document.createElement("input");
    output.type = "number";
    output.min = "0.0625";
    output.max = "10";
    output.step = "0.0625";
    output.className = "dialog-input";
    output.value = String(current.maxOutputBytes / (1024 * 1024));
    grid.append(timeoutLabel, timeout, outputLabel, output);
    dialog.append(grid);

    const envLabel = document.createElement("p");
    envLabel.className = "dialog-text";
    envLabel.textContent = "环境变量（每行 KEY=VALUE，# 开头为注释）";
    const env = document.createElement("textarea");
    env.className = "dialog-input regex-text";
    env.style.minHeight = "90px";
    env.placeholder = "HTTP_PROXY=http://127.0.0.1:7890\nMY_FLAG=1";
    env.value = current.env;

    const stdinLabel = document.createElement("p");
    stdinLabel.className = "dialog-text";
    stdinLabel.textContent = "stdin（仅本次运行；留空则不提供输入）";
    const stdin = document.createElement("textarea");
    stdin.className = "dialog-input regex-text";
    stdin.style.minHeight = "70px";
    stdin.placeholder = "程序的标准输入…";
    stdin.value = current.stdin;
    dialog.append(envLabel, env, stdinLabel, stdin);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => this.close());
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "保存";
    save.addEventListener("click", () => {
      const timeoutSecs = Math.min(600, Math.max(1, Math.round(Number(timeout.value) || 30)));
      const maxMB = Math.min(10, Math.max(0.0625, Number(output.value) || 1));
      const config: RunConfig = {
        timeoutSecs,
        maxOutputBytes: Math.round(maxMB * 1024 * 1024),
        env: env.value,
        stdin: stdin.value,
      };
      saveRunConfig(config);
      this.close();
      onSave(config);
    });
    actions.append(cancel, save);
    dialog.append(actions);

    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;
    timeout.focus();
  }
}
