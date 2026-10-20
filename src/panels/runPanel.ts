import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Code Run 输出面板：流式展示运行中的进程输出（stdout / stderr 分色），
 * 提供停止与清空。事件与 Rust `commands/run.rs` 对应。
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

export class RunPanel {
  private titleEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private stopBtn!: HTMLButtonElement;
  private bodyEl!: HTMLElement;
  private readonly unlistens: UnlistenFn[] = [];
  private running = false;

  constructor(private host: HTMLElement, private onChange?: () => void) {}

  get isOpen(): boolean {
    return !this.host.classList.contains("hidden");
  }

  /** 是否有正在运行的任务（供快捷按钮切换「运行 / 停止」） */
  get isRunning(): boolean {
    return this.running;
  }

  /** 订阅输出与结束事件（应用启动时调用一次） */
  mount(): void {
    this.host.innerHTML = "";

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

    void listen<RunChunk>("run://chunk", (e) => this.append(e.payload)).then((un) =>
      this.unlistens.push(un),
    );
    void listen<RunExit>("run://exit", (e) => this.finish(e.payload)).then((un) =>
      this.unlistens.push(un),
    );
  }

  /** 打开面板（每次运行前调用，清空上次输出） */
  open(runner: string): void {
    this.host.classList.remove("hidden");
    this.bodyEl.innerHTML = "";
    this.titleEl.textContent = `运行输出 · ${runner}`;
    this.setStatus("启动中…", "running");
    this.setRunning(true);
  }

  close(): void {
    this.host.classList.add("hidden");
    if (this.running) this.stop();
  }

  private hide(): void {
    this.host.classList.add("hidden");
  }

  /** 启动运行；失败时把错误显示在输出区 */
  async start(path: string, runner: string): Promise<void> {
    this.open(runner);
    try {
      await invoke("run_code", { path, runner });
    } catch (e) {
      this.setRunning(false);
      this.setStatus("启动失败", "error");
      this.appendText("stderr", `${String(e)}\n`);
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

  /** 统一维护运行状态并通知外部（快捷按钮据此切换） */
  private setRunning(value: boolean): void {
    this.running = value;
    this.stopBtn.disabled = !value;
    this.onChange?.();
  }

  private append(chunk: RunChunk): void {
    this.appendText(chunk.stream, chunk.text);
  }

  /** 输出追加：stderr 用错误色，stdout 用正文色 */
  private appendText(stream: string, text: string): void {
    if (!text) return;
    const span = document.createElement("span");
    if (stream === "stderr") span.className = "run-stderr";
    span.textContent = text;
    const atBottom = this.bodyEl.scrollHeight - this.bodyEl.scrollTop - this.bodyEl.clientHeight < 24;
    this.bodyEl.append(span);
    // 仅在用户本就贴着底部时自动滚动，避免打断向上翻阅
    if (atBottom) this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  private finish(exit: RunExit): void {
    this.setRunning(false);
    const parts: string[] = [];
    if (exit.timedOut) parts.push("已超时终止（30s）");
    else if (exit.stopped) parts.push("已停止");
    else parts.push(`退出码 ${exit.code ?? "未知"}`);
    parts.push(`${exit.durationMs} ms`);
    if (exit.truncated) parts.push("输出超 1MB 已截断");
    this.setStatus(parts.join(" · "), exit.timedOut || (exit.code ?? 0) !== 0 ? "error" : "");
  }

  private setStatus(text: string, kind: "running" | "error" | ""): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("running", kind === "running");
    this.statusEl.classList.toggle("error", kind === "error");
  }
}
