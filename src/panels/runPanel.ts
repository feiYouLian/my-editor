import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  classifyRunLine,
  collapseCarriageReturns,
  formatCurlStdout,
  formatDuration,
  parseRunLocation,
  resolveRunPath,
  stripAnsi,
  type RunStream,
} from "../core/runOutput";

/**
 * Code Run 输出面板：流式展示运行中的进程输出（stdout / stderr 分色），
 * 提供停止与清空。事件与 Rust `commands/run.rs` 对应。
 *
 * 输出按运行器优化：去 ANSI、语言相关错误/堆栈着色、文件位置点击跳转、
 * cURL stdout 退出后 JSON 美化。
 */

export interface RunChunk {
  /** "stdout" | "stderr" */
  stream: string;
  text: string;
}

export interface RunExit {
  code: number | null;
  durationMs: number;
  truncated: boolean;
  stopped: boolean;
  timedOut: boolean;
}

const RUNNER_LABELS: Record<string, string> = {
  python: "Python",
  node: "Node.js",
  java: "Java",
  curl: "cURL",
};

export class RunPanel {
  /** 输出区最大节点数：超出后从头部开始丢弃（后端已有 1MB 总量截断） */
  private static readonly MAX_OUTPUT_NODES = 2000;

  private titleEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private stopBtn!: HTMLButtonElement;
  private bodyEl!: HTMLElement;
  private readonly unlistens: UnlistenFn[] = [];
  private running = false;

  /** 当前运行的 runner（决定输出分类规则） */
  private runner = "";
  /** 运行目录：堆栈相对路径按此解析 */
  private cwd = "";
  /** 脚本文本模式（cURL 粘贴执行） */
  private scriptMode = false;
  /** 按流保留未换行的尾部；按行处理可避免 ANSI 序列被分块截断 */
  private rawBuffers: Record<RunStream, string> = { stdout: "", stderr: "" };
  /** cURL stdout 缓冲到退出后整体 JSON 美化 */
  private curlStdout = "";

  constructor(
    private host: HTMLElement,
    private onChange?: () => void,
    private onOpenLocation?: (path: string, line: number) => void,
  ) {}

  get isOpen(): boolean {
    return !this.host.classList.contains("hidden");
  }

  /** 是否有正在运行的任务（供快捷按钮切换「运行 / 停止」） */
  get isRunning(): boolean {
    return this.running;
  }

  /** 面板中是否已有输出（重新显示时避免展示空白面板） */
  get hasContent(): boolean {
    return !!this.bodyEl && this.bodyEl.childElementCount > 0;
  }

  /** 订阅输出与结束事件（应用启动时调用一次） */
  mount(): void {
    this.host.innerHTML = "";
    // 监听失败（极端情况）不能静默：至少留一条错误，否则用户看不到任何输出
    void listen<RunChunk>("run://chunk", (e) => this.append(e.payload))
      .then((un) => this.unlistens.push(un))
      .catch((e) => {
        this.appendText("stderr", `订阅运行输出失败: ${String(e)}\n`);
      });
    void listen<RunExit>("run://exit", (e) => this.finish(e.payload))
      .then((un) => this.unlistens.push(un))
      .catch((e) => console.warn("[run] 订阅退出事件失败", e));

    const head = document.createElement("div");
    head.className = "run-head";

    this.titleEl = document.createElement("span");
    this.titleEl.className = "run-title";
    this.titleEl.textContent = "运行输出";

    this.statusEl = document.createElement("span");
    this.statusEl.className = "run-status";

    this.stopBtn = document.createElement("button");
    this.stopBtn.type = "button";
    this.stopBtn.className = "gs-head-btn";
    this.stopBtn.textContent = "■";
    this.stopBtn.title = "停止运行";
    this.stopBtn.addEventListener("click", () => this.stop());

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "gs-head-btn";
    clearBtn.textContent = "🗑";
    clearBtn.title = "清空输出";
    clearBtn.addEventListener("click", () => {
      this.bodyEl.innerHTML = "";
      this.setStatus("", "");
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "gs-head-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭面板";
    closeBtn.addEventListener("click", () => this.close());

    head.append(this.titleEl, this.statusEl, this.stopBtn, clearBtn, closeBtn);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "run-body";

    this.host.append(head, this.bodyEl);
    this.hide();
  }

  /** 注销全部事件监听（应用退出 / 面板销毁时调用） */
  dispose(): void {
    for (const un of this.unlistens) un();
    this.unlistens.length = 0;
  }

  /** 显示面板（不重置内容）：终端抢占底部区域后可用命令切回 */
  show(): void {
    this.host.classList.remove("hidden");
  }

  /** 隐藏面板（保留输出，不停止进程） */
  hide(): void {
    this.host.classList.add("hidden");
  }

  /** 打开面板（每次运行前调用，清空上次输出） */
  open(title: string): void {
    this.show();
    this.bodyEl.innerHTML = "";
    this.titleEl.textContent = `运行输出 · ${title}`;
    this.setStatus("启动中…", "running");
    this.setRunning(true);
  }

  close(): void {
    this.hide();
    if (this.running) this.stop();
  }

  /** 启动运行；失败时把错误显示在输出区 */
  async start(path: string, runner: string, cwd = ""): Promise<void> {
    this.prepare(runner, cwd, false);
    this.open(this.runnerLabel());
    try {
      await invoke("run_code", { path, runner });
    } catch (e) {
      this.fail(e);
    }
  }

  /** 执行一段脚本文本（cURL）：无需先保存为磁盘文件 */
  async startScript(runner: string, script: string, cwd = ""): Promise<void> {
    this.prepare(runner, cwd, true);
    this.open("cURL 脚本");
    try {
      await invoke("run_curl", { script });
    } catch (e) {
      this.fail(e);
    }
  }

  stop(): void {
    void invoke<boolean>("stop_run")
      .then((had) => {
        if (!had) this.setRunning(false);
        else this.setStatus("正在停止…", "running");
      })
      .catch(() => this.setRunning(false));
  }

  private prepare(runner: string, cwd: string, scriptMode: boolean): void {
    this.runner = runner;
    this.cwd = cwd;
    this.scriptMode = scriptMode;
    this.rawBuffers = { stdout: "", stderr: "" };
    this.curlStdout = "";
  }

  private runnerLabel(): string {
    if (this.scriptMode) return "cURL 脚本";
    return RUNNER_LABELS[this.runner] ?? this.runner;
  }

  private fail(e: unknown): void {
    this.setRunning(false);
    this.setStatus("启动失败", "error");
    this.appendText("stderr", `${String(e)}\n`);
  }

  /** 统一维护运行状态并通知外部（快捷按钮据此切换） */
  private setRunning(value: boolean): void {
    this.running = value;
    this.stopBtn.disabled = !value;
    this.onChange?.();
  }

  private append(chunk: RunChunk): void {
    const stream: RunStream = chunk.stream === "stderr" ? "stderr" : "stdout";
    // cURL 的响应体先攒着，退出后统一判断是否美化 JSON（流式会破坏 JSON 结构）
    if (this.runner === "curl" && stream === "stdout") {
      this.curlStdout += chunk.text;
      return;
    }
    this.processChunk(stream, chunk.text);
  }

  /** 按行处理：未换行的尾部留到下一批，保证 ANSI 序列不被分块截断 */
  private processChunk(stream: RunStream, text: string): void {
    const combined = this.rawBuffers[stream] + text;
    const lines = combined.split("\n");
    this.rawBuffers[stream] = lines.pop() ?? "";
    for (const line of lines) this.appendLine(stream, line);
  }

  /** 仅供事件订阅失败等内部消息使用 */
  private appendText(stream: RunStream, text: string): void {
    this.processChunk(stream, text);
  }

  /** 渲染一行：去 ANSI、折叠 \r，按 runner 分类并挂载位置点击 */
  private appendLine(stream: RunStream, raw: string): void {
    const text = collapseCarriageReturns(stripAnsi(raw));
    const line = document.createElement("div");
    line.className = `run-line run-line-${classifyRunLine(this.runner, text, stream)}`;
    line.textContent = text;

    const loc = parseRunLocation(this.runner, text);
    if (loc && this.onOpenLocation) {
      const path = resolveRunPath(this.cwd, loc.path);
      line.classList.add("run-line-loc");
      line.title = `打开 ${path}:${loc.line}`;
      line.addEventListener("click", () => this.onOpenLocation?.(path, loc.line));
    }
    this.appendNode(line);
  }

  private appendNode(node: HTMLElement): void {
    if (!this.bodyEl) return;
    const atBottom =
      this.bodyEl.scrollHeight - this.bodyEl.scrollTop - this.bodyEl.clientHeight < 24;
    this.bodyEl.append(node);
    while (this.bodyEl.childElementCount > RunPanel.MAX_OUTPUT_NODES) {
      this.bodyEl.firstElementChild?.remove();
    }
    // 仅在用户本就贴着底部时自动滚动，避免打断向上翻阅
    if (atBottom) this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  /** 把流缓冲中残留的未换行内容输出 */
  private flushBuffers(): void {
    (["stdout", "stderr"] as RunStream[]).forEach((stream) => {
      const tail = this.rawBuffers[stream];
      this.rawBuffers[stream] = "";
      if (tail) this.appendLine(stream, tail);
    });
  }

  /** 整体渲染一段文本（cURL stdout） */
  private renderBlock(stream: RunStream, text: string): void {
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) this.appendLine(stream, line);
  }

  private finish(exit: RunExit): void {
    if (this.runner === "curl") {
      this.flushBuffers();
      if (this.curlStdout) {
        const formatted = formatCurlStdout(this.curlStdout);
        if (formatted.json) {
          const note = document.createElement("div");
          note.className = "run-line run-line-meta";
          note.textContent = "JSON 响应（已格式化）";
          this.appendNode(note);
        }
        this.renderBlock("stdout", formatted.text);
        this.curlStdout = "";
      }
    } else {
      this.flushBuffers();
    }

    this.setRunning(false);
    const parts: string[] = [];
    if (exit.timedOut) parts.push("已超时终止（30s）");
    else if (exit.stopped) parts.push("已停止");
    else parts.push(`退出码 ${exit.code ?? "未知"}`);
    parts.push(formatDuration(exit.durationMs));
    if (exit.truncated) parts.push("输出超 1MB 已截断");
    this.setStatus(parts.join(" · "), exit.timedOut || (exit.code ?? 0) !== 0 ? "error" : "");
  }

  private setStatus(text: string, kind: "running" | "error" | ""): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("running", kind === "running");
    this.statusEl.classList.toggle("error", kind === "error");
  }
}
