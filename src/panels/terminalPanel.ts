/**
 * 内置终端面板（xterm.js）：多会话标签 + 渲染 / 输入 / 尺寸同步。
 * 会话生命周期（terminal_open / write / resize / close）由 app/terminalHost.ts 编排。
 *
 * 每个会话一个 Terminal 实例与 body；切换标签只显示/隐藏 body，不重置滚动缓冲。
 * 本模块仅在被首次打开时动态 import，xterm 与 CSS 不进主 bundle。
 */

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { settings } from "../config/settings";

export interface TerminalSessionInfo {
  id: string;
  shell: string;
  cwd: string;
}

export interface TerminalPanelCallbacks {
  /** 键盘输入（含粘贴） */
  onInput: (id: string, data: string) => void;
  /** 终端行列变化 */
  onResize: (id: string, cols: number, rows: number) => void;
  /** 头部「重启」 */
  onRestart: (id: string) => void;
  /** 关闭指定会话 */
  onClose: (id: string) => void;
  /** 新建会话（标签栏 +） */
  onNew: () => void;
  /** 激活会话变化 */
  onActive: (id: string) => void;
  /** 面板内 Ctrl+` 切换（全局分发器会跳过 xterm 的 textarea） */
  onToggle: () => void;
}

interface SessionView {
  id: string;
  shell: string;
  cwd: string;
  term: Terminal;
  fitAddon: FitAddon;
  body: HTMLElement;
  tab: HTMLButtonElement;
  statusText: string;
  statusKind: "running" | "error" | "";
  exited: boolean;
  lastCols: number;
  lastRows: number;
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
  private sessions = new Map<string, SessionView>();
  private activeId = "";
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** 右键：有选中则复制，否则粘贴（Windows 终端惯例） */
  private contextHandler: ((e: MouseEvent) => void) | null = null;

  private tabsEl!: HTMLElement;
  private bodiesEl!: HTMLElement;
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

  get activeSessionId(): string {
    return this.activeId;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 创建面板骨架（幂等；不创建 xterm） */
  mount(): void {
    if (this.tabsEl) return;
    this.buildDom();

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.bodiesEl);

    // 面板内 Ctrl+`：xterm 的 textarea 会让全局分发器跳过，必须在面板内捕获
    this.keyHandler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        this.cb.onToggle();
      }
    };
    this.host.addEventListener("keydown", this.keyHandler, true);

    this.contextHandler = (e: MouseEvent) => {
      e.preventDefault();
      const session = this.sessions.get(this.activeId);
      const selection = session?.term.getSelection() ?? "";
      if (selection) {
        void navigator.clipboard.writeText(selection).catch(() => {});
        session?.term.clearSelection();
        return;
      }
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) session?.term.paste(text);
        })
        .catch(() => {});
    };
    this.host.addEventListener("contextmenu", this.contextHandler);
  }

  private buildDom(): void {
    this.host.innerHTML = "";
    const head = document.createElement("div");
    head.className = "terminal-head";

    const title = document.createElement("span");
    title.className = "terminal-title";
    title.textContent = "终端";

    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "terminal-tabs";

    this.shellEl = document.createElement("span");
    this.shellEl.className = "terminal-shell";
    this.shellEl.textContent = "";

    this.cwdEl = document.createElement("span");
    this.cwdEl.className = "terminal-cwd";

    this.statusEl = document.createElement("span");
    this.statusEl.className = "terminal-status";

    const newBtn = this.headButton("+", "新建终端", () => this.cb.onNew());
    const clearBtn = this.headButton("🗑", "清空当前终端", () => this.clear());
    const restartBtn = this.headButton("⟳", "重启当前终端", () => {
      if (this.activeId) this.cb.onRestart(this.activeId);
    });
    const closeBtn = this.headButton("✕", "关闭当前终端", () => {
      if (this.activeId) this.cb.onClose(this.activeId);
    });
    head.append(title, this.tabsEl, newBtn, this.shellEl, this.cwdEl, this.statusEl, clearBtn, restartBtn, closeBtn);

    this.bodiesEl = document.createElement("div");
    this.bodiesEl.className = "terminal-bodies";

    this.host.append(head, this.bodiesEl);
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

  /** 新建一个会话的 xterm 与标签；返回后自动激活 */
  createSession(info: TerminalSessionInfo): void {
    if (this.sessions.has(info.id)) return;
    if (!this.tabsEl) this.mount();

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "terminal-tab";
    tab.textContent = info.shell;
    tab.title = `${info.shell} · ${info.cwd}`;
    tab.addEventListener("click", () => this.activate(info.id));

    const body = document.createElement("div");
    body.className = "terminal-body";
    this.bodiesEl.append(body);
    this.tabsEl.append(tab);

    const term = new Terminal({
      fontFamily: cssVar("--font-mono", '"Cascadia Code", Consolas, monospace'),
      fontSize: settings.editorFontSize,
      cursorBlink: true,
      scrollback: 2000,
      theme: this.readTheme(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // xterm 在 display:none 容器里量不到字符尺寸：临时可见完成 open，再交给 activate 收尾
    const wasHidden = this.host.classList.contains("hidden");
    this.host.classList.remove("hidden");
    body.style.display = "block";
    term.open(body);
    if (wasHidden) this.host.classList.add("hidden");

    term.onData((data) => this.cb.onInput(info.id, data));
    term.attachCustomKeyEventHandler((e) => this.handleKey(e));

    this.sessions.set(info.id, {
      id: info.id,
      shell: info.shell,
      cwd: info.cwd,
      term,
      fitAddon,
      body,
      tab,
      statusText: "就绪",
      statusKind: "",
      exited: false,
      lastCols: 0,
      lastRows: 0,
    });
    this.activate(info.id);
  }

  /** 切换活动会话：只切换显示，不销毁其它 xterm */
  activate(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.activeId = id;
    for (const other of this.sessions.values()) {
      const active = other.id === id;
      other.body.style.display = active ? "block" : "none";
      other.tab.classList.toggle("active", active);
    }
    this.shellEl.textContent = session.shell;
    this.cwdEl.textContent = session.cwd;
    this.cwdEl.title = session.cwd;
    this.applyStatus(session);
    this.cb.onActive(id);
    requestAnimationFrame(() => {
      this.fitNow();
      session.term.focus();
    });
  }

  /** 移除会话标签与 xterm（进程由宿主负责结束） */
  removeSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.term.dispose();
    session.body.remove();
    session.tab.remove();
    this.sessions.delete(id);
    if (this.activeId !== id) return;
    this.activeId = "";
    const next = [...this.sessions.keys()][0];
    if (next) {
      this.activate(next);
    } else {
      this.shellEl.textContent = "";
      this.cwdEl.textContent = "";
      this.statusEl.textContent = "";
      this.hide();
    }
  }

  updateInfo(id: string, shell: string, cwd: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.shell = shell;
    session.cwd = cwd;
    session.tab.textContent = shell;
    session.tab.title = `${shell} · ${cwd}`;
    if (id === this.activeId) {
      this.shellEl.textContent = shell;
      this.cwdEl.textContent = cwd;
      this.cwdEl.title = cwd;
    }
  }

  show(): void {
    this.host.classList.remove("hidden");
    if (!this.activeId && this.sessions.size > 0) {
      const first = [...this.sessions.keys()][0];
      if (first) this.activate(first);
    }
    requestAnimationFrame(() => {
      this.fitNow();
      this.sessions.get(this.activeId)?.term.focus();
    });
  }

  hide(): void {
    this.host.classList.add("hidden");
  }

  setStatus(id: string, text: string, kind: "running" | "error" | ""): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.statusText = text;
    session.statusKind = kind;
    if (id === this.activeId) this.applyStatus(session);
  }

  private applyStatus(session: SessionView): void {
    this.statusEl.textContent = session.statusText;
    this.statusEl.classList.toggle("running", session.statusKind === "running");
    this.statusEl.classList.toggle("error", session.statusKind === "error");
  }

  write(id: string, data: Uint8Array): void {
    this.sessions.get(id)?.term.write(data);
  }

  focus(): void {
    this.sessions.get(this.activeId)?.term.focus();
  }

  clear(): void {
    this.sessions.get(this.activeId)?.term.clear();
  }

  /** 退出提示：写一条灰色标记并更新该会话状态 */
  setExit(id: string, code: number | null): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.exited = true;
    const label = code === null ? "未知" : String(code);
    session.term.write(`\r\n\x1b[90m[进程已退出（退出码 ${label}），点击「⟳」重启终端]\x1b[0m\r\n`);
    this.setStatus(id, `已退出（${label}）`, code === 0 ? "" : "error");
  }

  dimensions(id = this.activeId): { cols: number; rows: number } {
    const session = this.sessions.get(id);
    return { cols: session?.term.cols ?? 80, rows: session?.term.rows ?? 24 };
  }

  /** 配置变更（主题 / 字号）后刷新全部会话 */
  applySettings(): void {
    for (const session of this.sessions.values()) {
      session.term.options.theme = this.readTheme();
      session.term.options.fontFamily = cssVar("--font-mono", '"Cascadia Code", Consolas, monospace');
      session.term.options.fontSize = settings.editorFontSize;
    }
    this.scheduleFit();
  }

  fit(): void {
    this.fitNow();
  }

  dispose(): void {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    if (this.keyHandler) this.host.removeEventListener("keydown", this.keyHandler, true);
    this.keyHandler = null;
    if (this.contextHandler) this.host.removeEventListener("contextmenu", this.contextHandler);
    this.contextHandler = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const session of this.sessions.values()) session.term.dispose();
    this.sessions.clear();
    this.activeId = "";
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
    const session = this.sessions.get(this.activeId);
    if (!session || this.host.classList.contains("hidden")) return;
    try {
      session.fitAddon.fit();
    } catch {
      // 容器尺寸为 0 时 fit 会抛错，忽略即可
    }
    const { cols, rows } = this.dimensions(session.id);
    if (cols !== session.lastCols || rows !== session.lastRows) {
      session.lastCols = cols;
      session.lastRows = rows;
      this.cb.onResize(session.id, cols, rows);
    }
  }

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.code === "KeyC") {
      const selection = this.sessions.get(this.activeId)?.term.getSelection() ?? "";
      if (selection) void navigator.clipboard.writeText(selection).catch(() => {});
      return false;
    }
    if (mod && e.shiftKey && e.code === "KeyV") {
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) this.sessions.get(this.activeId)?.term.paste(text);
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
