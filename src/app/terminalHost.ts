/**
 * 终端编排：懒加载 xterm 面板，管理 Rust PTY 会话生命周期，
 * 提供「在终端运行当前文件 / cURL 脚本」入口。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Tab } from "../store/tabs";
import { dirnameOf } from "../core/paths";
import { getConfig, subscribeSettings } from "../config/settings";
import type { TerminalPanel } from "../panels/terminalPanel";

interface TerminalInfo {
  id: string;
  shell: string;
  cwd: string;
}

interface TerminalChunk {
  id: string;
  /** base64 输出字节 */
  data: string;
}

interface TerminalExit {
  id: string;
  code: number | null;
}

export interface TerminalHostDeps {
  getActiveTab: () => Tab | null;
  getWorkspaceRoot: () => string | null;
  showMessage: (text: string) => void;
  /** 终端显示前隐藏运行输出面板，避免底部区域被两个面板挤满 */
  onBeforeOpen?: () => void;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function firstLine(value: unknown): string {
  return String(value).split("\n")[0];
}

export class TerminalHost {
  private panel: TerminalPanel | null = null;
  private panelPromise: Promise<TerminalPanel> | null = null;
  private id = "";
  private exited = false;
  private shellLabel = "shell";
  private cwd = "";
  private starting: Promise<string | null> | null = null;
  private unlistens: UnlistenFn[] = [];
  private listenersReady: Promise<void>;
  /** 会话 id 尚未返回时的首批输出（ConPTY 的 \x1b[6n 光标查询不能丢） */
  private pendingChunks = new Map<string, Uint8Array[]>();
  private pendingBytes = 0;
  private pendingExit = new Map<string, number | null>();

  constructor(private deps: TerminalHostDeps) {
    this.listenersReady = this.setupListeners();
    subscribeSettings(() => this.panel?.applySettings());
  }

  private async setupListeners(): Promise<void> {
    try {
      const output = await listen<TerminalChunk>("terminal://output", (e) => {
        const bytes = decodeBase64(e.payload.data);
        if (!this.id) {
          this.bufferChunk(e.payload.id, bytes);
          return;
        }
        if (e.payload.id !== this.id) return;
        this.panel?.write(bytes);
      });
      this.unlistens.push(output);
      const exit = await listen<TerminalExit>("terminal://exit", (e) => {
        if (!this.id) {
          this.pendingExit.set(e.payload.id, e.payload.code);
          return;
        }
        if (e.payload.id !== this.id) return;
        this.exited = true;
        this.panel?.setExit(e.payload.code);
      });
      this.unlistens.push(exit);
    } catch (e) {
      this.deps.showMessage(`终端事件订阅失败: ${firstLine(e)}`);
    }
  }

  /** 启动窗口内按 id 缓存输出，避免丢掉 ConPTY 的首个光标查询 */
  private bufferChunk(id: string, bytes: Uint8Array): void {
    const list = this.pendingChunks.get(id) ?? [];
    list.push(bytes);
    this.pendingBytes += bytes.length;
    this.pendingChunks.set(id, list);
    while (this.pendingBytes > 256 * 1024) {
      const oldest = this.pendingChunks.keys().next().value as string | undefined;
      if (!oldest) break;
      const oldestList = this.pendingChunks.get(oldest);
      const dropped = oldestList?.shift();
      this.pendingBytes -= dropped?.length ?? 0;
      if (!oldestList || oldestList.length === 0) this.pendingChunks.delete(oldest);
    }
  }

  private flushPending(id: string): void {
    const list = this.pendingChunks.get(id);
    if (list) {
      for (const chunk of list) {
        this.pendingBytes -= chunk.length;
        this.panel?.write(chunk);
      }
      this.pendingChunks.delete(id);
    }
    const exit = this.pendingExit.get(id);
    if (exit !== undefined) {
      this.pendingExit.delete(id);
      this.exited = true;
      this.panel?.setExit(exit);
    }
    // 旧会话的尾部输出不再需要，顺手清理，避免缓存累积
    for (const key of [...this.pendingChunks.keys()]) {
      if (key === id) continue;
      const stale = this.pendingChunks.get(key) ?? [];
      this.pendingBytes -= stale.reduce((sum, chunk) => sum + chunk.length, 0);
      this.pendingChunks.delete(key);
    }
    for (const key of [...this.pendingExit.keys()]) {
      if (key !== id) this.pendingExit.delete(key);
    }
  }

  /** 懒加载终端面板（xterm 只在首次打开时进入 bundle） */
  private ensurePanel(): Promise<TerminalPanel> {
    if (!this.panelPromise) {
      this.panelPromise = import("../panels/terminalPanel")
        .then(({ TerminalPanel }) => {
          const host = document.getElementById("terminal-panel");
          if (!host) throw new Error("缺少 #terminal-panel 容器");
          const panel = new TerminalPanel(host, {
            onInput: (data) => this.write(data),
            onResize: (cols, rows) => this.resize(cols, rows),
            onRestart: () => void this.restart(),
            onClose: () => void this.close(),
            onToggle: () => void this.toggle(),
          });
          panel.mount();
          this.panel = panel;
          this.panel.applySettings();
          return panel;
        })
        .catch((e) => {
          this.panelPromise = null;
          this.deps.showMessage(`终端初始化失败: ${firstLine(e)}`);
          throw e;
        });
    }
    return this.panelPromise;
  }

  /** Ctrl+` / 工具栏按钮：显示或隐藏（隐藏不杀进程） */
  async toggle(): Promise<void> {
    try {
      const panel = await this.ensurePanel();
      if (panel.isOpen) {
        panel.hide();
        return;
      }
      await this.ensureOpen(this.defaultCwd());
    } catch {
      // ensurePanel 已提示
    }
  }

  hide(): void {
    this.panel?.hide();
  }

  /**
   * 在指定目录打开终端（文件树 / 面包屑右键「在终端中打开」）。
   * 已有会话且目录相同：只显示并聚焦；目录不同：先关旧会话再新开，
   * 保证终端 cwd 与用户所指目录一致（而不是在旧会话里静默 alter）。
   */
  async openAt(cwd: string): Promise<void> {
    try {
      if (this.id && !this.exited && this.cwd === cwd) {
        await this.ensureOpen(cwd);
        return;
      }
      if (this.id && !this.exited) await this.closeSession();
      await this.ensureOpen(cwd);
    } catch {
      // ensurePanel / ensureOpen 已提示
    }
  }

  /** 确保终端可见且有活动会话，返回会话 id */
  async ensureOpen(cwd: string): Promise<string | null> {
    if (this.id && !this.exited) {
      try {
        const panel = await this.ensurePanel();
        this.deps.onBeforeOpen?.();
        this.cwd = cwd || this.cwd;
        panel.show(this.shellLabel, this.cwd, "就绪");
        panel.focus();
        return this.id;
      } catch (e) {
        // 会话还在但面板唤起失败：这条路径不走 startSession 的提示，必须自己说一声
        console.warn("[terminal] 唤起面板失败", e);
        this.deps.showMessage("终端面板打开失败");
        return null;
      }
    }
    if (this.starting) return this.starting;
    this.deps.onBeforeOpen?.();
    this.starting = this.startSession(cwd);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startSession(cwd: string): Promise<string | null> {
    try {
      await this.listenersReady;
      const panel = await this.ensurePanel();
      panel.reset();
      panel.show("启动中…", cwd || "", "启动中…");
      panel.setStatus("启动中…", "running");
      // 先完成一次布局，才能拿到准确行列
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      panel.fit();
      const { cols, rows } = panel.dimensions();
      this.pendingChunks.clear();
      this.pendingBytes = 0;
      this.pendingExit.clear();
      this.id = "";
      this.exited = false;
      const info = await invoke<TerminalInfo>("terminal_open", {
        shell: getConfig().terminal.shell,
        cwd: cwd || "",
        cols,
        rows,
      });
      this.id = info.id;
      this.exited = false;
      this.cwd = info.cwd;
      this.shellLabel = info.shell;
      panel.show(info.shell, info.cwd, "就绪");
      this.flushPending(info.id);
      panel.focus();
      return info.id;
    } catch (e) {
      this.id = "";
      this.pendingChunks.clear();
      this.pendingBytes = 0;
      this.pendingExit.clear();
      this.panel?.setStatus("启动失败", "error");
      this.panel?.write(new TextEncoder().encode(`\r\n${firstLine(e)}\r\n`));
      this.deps.showMessage(`终端启动失败: ${firstLine(e)}`);
      return null;
    }
  }

  /** 重启当前 shell（cwd 保持） */
  async restart(): Promise<void> {
    await this.closeSession();
    await this.ensureOpen(this.cwd || this.defaultCwd());
  }

  /** 关闭按钮 / 应用退出：结束进程并隐藏 */
  async close(): Promise<void> {
    await this.closeSession();
    this.panel?.hide();
  }

  private async closeSession(): Promise<void> {
    const id = this.id;
    this.id = "";
    this.exited = false;
    this.pendingChunks.clear();
    this.pendingBytes = 0;
    this.pendingExit.clear();
    if (!id) return;
    try {
      await invoke("terminal_close", { id });
    } catch {
      // 进程可能已自行退出
    }
  }

  /** 在终端运行当前文件：要求已保存且无未保存改动（与 F5 一致） */
  async runFile(path: string, runner: string): Promise<void> {
    const dir = dirnameOf(path);
    const cwd = dir && dir !== path ? dir : this.defaultCwd();
    const id = await this.ensureOpen(cwd);
    if (!id) return;
    try {
      await invoke("terminal_run_code", { id, path, runner });
      this.panel?.focus();
    } catch (e) {
      this.deps.showMessage(`终端运行失败: ${firstLine(e)}`);
    }
  }

  /** 在终端执行 cURL 脚本文本（选区由调用方裁决） */
  async runCurlScript(script: string): Promise<void> {
    const id = await this.ensureOpen(this.defaultCwd());
    if (!id) return;
    try {
      await invoke("terminal_run_curl", { id, script });
      this.panel?.focus();
    } catch (e) {
      this.deps.showMessage(`终端运行失败: ${firstLine(e)}`);
    }
  }

  applySettings(): void {
    this.panel?.applySettings();
  }

  /** 应用退出：结束进程并释放 xterm */
  async dispose(): Promise<void> {
    await this.closeSession();
    for (const un of this.unlistens) un();
    this.unlistens.length = 0;
    this.pendingChunks.clear();
    this.pendingExit.clear();
    this.pendingBytes = 0;
    this.panel?.dispose();
    this.panel = null;
    this.panelPromise = null;
  }

  private write(data: string): void {
    if (!this.id || this.exited) return;
    void invoke("terminal_write", { id: this.id, data }).catch(() => {
      // 会话可能已退出；exit 事件会更新状态，不在每次按键时打扰用户
    });
  }

  private resize(cols: number, rows: number): void {
    if (!this.id || this.exited) return;
    void invoke("terminal_resize", { id: this.id, cols, rows }).catch(() => {});
  }

  private defaultCwd(): string {
    const tab = this.deps.getActiveTab();
    if (tab?.path) {
      const dir = dirnameOf(tab.path);
      if (dir && dir !== tab.path) return dir;
    }
    return this.deps.getWorkspaceRoot() ?? "";
  }
}
