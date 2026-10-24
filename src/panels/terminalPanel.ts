/**
 * 内置终端面板（xterm.js）：只负责渲染、输入与尺寸同步；
 * 会话生命周期（terminal_open / write / resize / close）由 app/terminalHost.ts 编排。
 *
 * 本模块仅在被首次打开时动态 import，xterm 与 CSS 不进主 bundle。
 */

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { settings } from "../config/settings";

export interface TerminalPanelCallbacks {
  /** 键盘输入（含粘贴） */
  onInput: (data: string) => void;
  /** 终端行列变化 */
  onResize: (cols: number, rows: number) => void;
  /** 头部「重启」 */
  onRestart: () => void;
  /** 头部「关闭」：结束进程并隐藏 */
  onClose: () => void;
  /** 面板内 Ctrl+` 切换（全局分发器会跳过 xterm 的 textarea） */
  onToggle: () => void;
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 给 #rrggbb 追加透明度；非 hex 原样返回 */
function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const a = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, "0");
    return `${color}${a}`;
  }
  return color;
}

export class TerminalPanel {
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private lastCols = 0;
  private lastRows = 0;

  private termHost!: HTMLElement;
  private shellEl!: HTMLElement;
  private cwdEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(
    private host: HTMLElement,
    private cb: TerminalPanelCallbacks,
  ) {}

  get isOpen(): boolean {
    return !this.host.classList.contains("hidden");
  }

  /** 创建 xterm 与面板 DOM（幂等） */
  mount(): void {
    if (this.term) return;
    this.buildDom();

    const term = new Terminal({
      fontFamily: cssVar("--font-mono", '"Cascadia Code", Consolas, monospace'),
      fontSize: settings.editorFontSize,
      cursorBlink: true,
      scrollback: 2000,
      theme: this.readTheme(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // xterm 在 display:none 容器里量不到字符尺寸：临时可见完成 open，再恢复隐藏
    const wasHidden = this.host.classList.contains("hidden");
    this.host.classList.remove("hidden");
    term.open(this.termHost);
    if (wasHidden) this.host.classList.add("hidden");
    term.onData((data) => this.cb.onInput(data));
    term.attachCustomKeyEventHandler((e) => this.handleKey(e));

    this.term = term;
    this.fitAddon = fitAddon;
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.termHost);

    // 面板内 Ctrl+`：xterm 的 textarea 会让全局分发器跳过，必须在面板内捕获
    this.keyHandler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        this.cb.onToggle();
      }
    };
    this.host.addEventListener("keydown", this.keyHandler, true);

    this.scheduleFit();
  }

  private buildDom(): void {
    this.host.innerHTML = "";
    const head = document.createElement("div");
    head.className = "terminal-head";

    const title = document.createElement("span");
    title.className = "terminal-title";
    title.append("终端 · ");
    this.shellEl = document.createElement("span");
    this.shellEl.className = "terminal-shell";
    this.shellEl.textContent = "shell";
    title.append(this.shellEl);

    this.cwdEl = document.createElement("span");
    this.cwdEl.className = "terminal-cwd";

    this.statusEl = document.createElement("span");
    this.statusEl.className = "terminal-status";

    const clearBtn = this.headButton("🗑", "清空终端", () => this.clear());
    const restartBtn = this.headButton("⟳", "重启终端", () => this.cb.onRestart());
    const closeBtn = this.headButton("✕", "关闭终端", () => this.cb.onClose());
    head.append(title, this.cwdEl, this.statusEl, clearBtn, restartBtn, closeBtn);

    this.termHost = document.createElement("div");
    this.termHost.className = "terminal-body";

    this.host.append(head, this.termHost);
  }

  private headButton(text: string, title: string, run: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gs-head-btn";
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener("click", run);
    return btn;
  }

  /** 显示并更新 shell / cwd（会话创建前用「启动中…」占位） */
  show(shell: string, cwd: string, status = "就绪"): void {
    this.host.classList.remove("hidden");
    this.shellEl.textContent = shell;
    this.cwdEl.textContent = cwd;
    this.cwdEl.title = cwd;
    this.setStatus(status, "");
    requestAnimationFrame(() => {
      this.fitNow();
      this.term?.focus();
    });
  }

  hide(): void {
    this.host.classList.add("hidden");
  }

  setStatus(text: string, kind: "running" | "error" | ""): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("running", kind === "running");
    this.statusEl.classList.toggle("error", kind === "error");
  }

  write(data: Uint8Array): void {
    this.term?.write(data);
  }

  focus(): void {
    this.term?.focus();
  }

  clear(): void {
    this.term?.clear();
  }

  /** 新会话前彻底清空（含滚动缓冲） */
  reset(): void {
    this.term?.reset();
  }

  /** 退出提示：写一条灰色标记并更新头部状态 */
  setExit(code: number | null): void {
    const label = code === null ? "未知" : String(code);
    this.term?.write(`\r\n\x1b[90m[进程已退出（退出码 ${label}），点击「⟳」重启终端]\x1b[0m\r\n`);
    this.setStatus(`已退出（${label}）`, code === 0 ? "" : "error");
  }

  /** 当前行列（terminal_open 使用） */
  dimensions(): { cols: number; rows: number } {
    return { cols: this.term?.cols ?? 80, rows: this.term?.rows ?? 24 };
  }

  /** 配置变更（主题 / 字号）后刷新 */
  applySettings(): void {
    if (!this.term) return;
    this.term.options.theme = this.readTheme();
    this.term.options.fontFamily = cssVar("--font-mono", '"Cascadia Code", Consolas, monospace');
    this.term.options.fontSize = settings.editorFontSize;
    this.scheduleFit();
  }

  fit(): void {
    this.fitNow();
  }

  dispose(): void {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    if (this.keyHandler) this.host.removeEventListener("keydown", this.keyHandler, true);
    this.keyHandler = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.term?.dispose();
    this.term = null;
    this.fitAddon = null;
    this.host.innerHTML = "";
  }

  private scheduleFit(): void {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      this.fitNow();
    }, 60);
  }

  private fitNow(): void {
    if (!this.term || this.host.classList.contains("hidden")) return;
    try {
      this.fitAddon?.fit();
    } catch {
      // 容器尺寸为 0 时 fit 会抛错，忽略即可
    }
    const { cols, rows } = this.dimensions();
    if (cols !== this.lastCols || rows !== this.lastRows) {
      this.lastCols = cols;
      this.lastRows = rows;
      this.cb.onResize(cols, rows);
    }
  }

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.code === "KeyC") {
      const selection = this.term?.getSelection() ?? "";
      if (selection) void navigator.clipboard.writeText(selection).catch(() => {});
      return false;
    }
    if (mod && e.shiftKey && e.code === "KeyV") {
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) this.term?.paste(text);
        })
        .catch(() => {});
      return false;
    }
    return true;
  }

  private readTheme(): ITheme {
    const background = cssVar("--bg-app", "#1e1e1e");
    const foreground = cssVar("--text-primary", "#d4d4d4");
    const accent = cssVar("--accent", "#4ea1ff");
    const danger = cssVar("--danger", "#ff6b6b");
    return {
      background,
      foreground,
      cursor: accent,
      cursorAccent: background,
      selectionBackground: withAlpha(accent, 0.3),
      red: danger,
    };
  }
}
