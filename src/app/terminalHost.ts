/**
 * 终端编排：懒加载 xterm 面板，管理多个 Rust PTY 会话（标签切换），
 * 提供「在终端运行当前文件 / cURL 脚本」入口。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Tab } from "../store/tabs";
import { dirnameOf } from "../core/paths";
import { getConfig, subscribeSettings } from "../config/settings";
import type { TerminalPanel } from "../panels/terminalPanel";
import { firstLine } from "../core/errors";

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

interface SessionMeta {
  shell: string;
  cwd: string;
  exited: boolean;
}

export interface TerminalHostDeps {
  getActiveTab: () => Tab | null;
  getWorkspaceRoot: () => string | null;
  showMessage: (text: string) => void;
  /** 终端显示前隐藏运行输出面板，避免底部区域被两个面板挤满 */
  onBeforeOpen?: () => void;
}

const MAX_SESSIONS = 8;

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export class TerminalHost {
  private panel: TerminalPanel | null = null;
  private panelPromise: Promise<TerminalPanel> | null = null;
  private sessions = new Map<string, SessionMeta>();
  private activeId = "";
  private starting: Promise<string | null> | null = null;
  private unlistens: UnlistenFn[] = [];
  private listenersReady: Promise<void>;
  /** 会话 id 尚未返回时的首批输出（ConPTY 的 \x1b[6n 光标查询不能丢） */
  private pendingChunks = new Map<string, Uint8Array[]>();
  private pendingBytes = 0;
  private pendingExit = new Map<string, number | null>();

  /** 终端面板当前是否可见（菜单勾选态 / 标题栏按钮高亮用） */
  get isOpen(): boolean {
    return this.panel?.isOpen ?? false;
  }

  constructor(private deps: TerminalHostDeps) {
    this.listenersReady = this.setupListeners();
    subscribeSettings(() => this.panel?.applySettings());
  }

  private async setupListeners(): Promise<void> {
    try {
      const output = await listen<TerminalChunk>("terminal://output", (e) => {
        const bytes = decodeBase64(e.payload.data);
        if (!this.sessions.has(e.payload.id)) {
          this.bufferChunk(e.payload.id, bytes);
          return;
        }
        this.panel?.write(e.payload.id, bytes);
      });
      this.unlistens.push(output);
      const exit = await listen<TerminalExit>("terminal://exit", (e) => {
        const meta = this.sessions.get(e.payload.id);
        if (!meta) {
          this.pendingExit.set(e.payload.id, e.payload.code);
          return;
        }
        meta.exited = true;
        this.panel?.setExit(e.payload.id, e.payload.code);
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
        this.panel?.write(id, chunk);
      }
      this.pendingChunks.delete(id);
    }
    const exit = this.pendingExit.get(id);
    if (exit !== undefined) {
      this.pendingExit.delete(id);
      const meta = this.sessions.get(id);
      if (meta) meta.exited = true;
      this.panel?.setExit(id, exit);
    }
    // 旧/未知会话的尾部输出不再需要，顺手清理，避免缓存累积
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
            onInput: (id, data) => this.write(id, data),
            onResize: (id, cols, rows) => this.resize(id, cols, rows),
            onRestart: (id) => void this.restart(id),
            onClose: (id) => void this.closeSession(id),
            onNew: () =>
              void this.newSession(
                this.sessions.get(this.activeId)?.cwd ?? this.defaultCwd(),
              ),
            onActive: (id) => {
              this.activeId = id;
            },
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
   * 在指定目录打开终端：优先复用该目录的会话，否则新建一个（不关闭其它会话）。
   */
  async openAt(cwd: string): Promise<void> {
    try {
      if (this.sessions.size >= MAX_SESSIONS && !this.findSessionAt(cwd)) {
        this.deps.showMessage(`终端会话最多 ${MAX_SESSIONS} 个，请先关闭一个`);
        return;
      }
      const id = await this.ensureSessionAt(cwd);
      if (id) this.panel?.show();
    } catch {
      // ensurePanel / startSession 已提示
    }
  }

  /** 确保有一个可用会话（优先激活当前会话） */
  async ensureOpen(cwd: string): Promise<string | null> {
    if (this.activeId && this.sessions.get(this.activeId)?.exited === false) {
      try {
        const panel = await this.ensurePanel();
        this.deps.onBeforeOpen?.();
        panel.show();
        panel.activate(this.activeId);
        panel.focus();
        return this.activeId;
      } catch (e) {
        console.warn("[terminal] 唤起面板失败", e);
        this.deps.showMessage("终端面板打开失败");
        return null;
      }
    }
    const anyAlive = [...this.sessions.entries()].find(([, meta]) => !meta.exited);
    if (anyAlive) {
      const panel = await this.ensurePanel();
      this.deps.onBeforeOpen?.();
      this.activeId = anyAlive[0];
      panel.show();
      panel.activate(anyAlive[0]);
      panel.focus();
      return anyAlive[0];
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

  /** 新建一个终端会话（标签 +），即使同 cwd 也新开 */
  async newSession(cwd?: string): Promise<void> {
    if (this.starting) return;
    this.deps.onBeforeOpen?.();
    this.starting = this.startSession(cwd ?? this.defaultCwd());
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    this.panel?.show();
  }

  /** 找到 cwd 匹配的存活会话（大小写/分隔符不敏感） */
  private findSessionAt(cwd: string): string | null {
    const target = normPath(cwd);
    for (const [id, meta] of this.sessions) {
      if (!meta.exited && normPath(meta.cwd) === target) return id;
    }
    return null;
  }

  private async ensureSessionAt(cwd: string): Promise<string | null> {
    const found = this.findSessionAt(cwd);
    if (found) {
      const panel = await this.ensurePanel();
      this.deps.onBeforeOpen?.();
      this.activeId = found;
      panel.show();
      panel.activate(found);
      panel.focus();
      return found;
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
    if (this.sessions.size >= MAX_SESSIONS) {
      this.deps.showMessage(`终端会话最多 ${MAX_SESSIONS} 个，请先关闭一个`);
      return null;
    }
    try {
      await this.listenersReady;
      const panel = await this.ensurePanel();
      // xterm 需要可见容器才能量尺寸；创建后再用真实行列 resize 一次
      panel.show();
      const info = await invoke<TerminalInfo>("terminal_open", {
        shell: getConfig().terminal.shell,
        cwd: cwd || "",
        cols: 80,
        rows: 24,
      });
      this.sessions.set(info.id, { shell: info.shell, cwd: info.cwd, exited: false });
      this.activeId = info.id;
      try {
        panel.createSession(info);
      } catch (e) {
        this.sessions.delete(info.id);
        this.activeId = "";
        void invoke("terminal_close", { id: info.id }).catch(() => {});
        throw e;
      }
      this.flushPending(info.id);
      panel.show();
      panel.focus();
      const dims = panel.dimensions(info.id);
      void invoke("terminal_resize", { id: info.id, cols: dims.cols, rows: dims.rows }).catch(
        () => {},
      );
      return info.id;
    } catch (e) {
      this.deps.showMessage(`终端启动失败: ${firstLine(e)}`);
      if (this.sessions.size === 0) this.panel?.hide();
      return null;
    }
  }

  /** 重启指定会话（cwd 保持） */
  async restart(id: string): Promise<void> {
    const meta = this.sessions.get(id);
    if (!meta) return;
    const cwd = meta.cwd;
    await this.closeSession(id);
    await this.openAt(cwd || this.defaultCwd());
  }

  /** 关闭指定会话；没有剩余会话时隐藏面板 */
  async closeSession(id: string): Promise<void> {
    this.sessions.delete(id);
    if (this.activeId === id) this.activeId = "";
    this.pendingChunks.delete(id);
    this.pendingExit.delete(id);
    this.panel?.removeSession(id);
    if (this.sessions.size === 0) this.panel?.hide();
    try {
      await invoke("terminal_close", { id });
    } catch {
      // 进程可能已自行退出
    }
  }

  /** 在终端运行当前文件：优先复用文件所在目录的会话 */
  async runFile(path: string, runner: string): Promise<void> {
    const dir = dirnameOf(path);
    const cwd = dir && dir !== path ? dir : this.defaultCwd();
    if (!this.findSessionAt(cwd) && this.sessions.size >= MAX_SESSIONS) {
      this.deps.showMessage(`终端会话最多 ${MAX_SESSIONS} 个，请先关闭一个`);
      return;
    }
    const id = await this.ensureSessionAt(cwd);
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

  /** 应用退出：结束全部会话并释放 xterm */
  async dispose(): Promise<void> {
    const ids = [...this.sessions.keys()];
    this.sessions.clear();
    this.activeId = "";
    for (const id of ids) {
      try {
        await invoke("terminal_close", { id });
      } catch {
        // 忽略
      }
    }
    for (const un of this.unlistens) un();
    this.unlistens.length = 0;
    this.pendingChunks.clear();
    this.pendingExit.clear();
    this.pendingBytes = 0;
    this.panel?.dispose();
    this.panel = null;
    this.panelPromise = null;
  }

  private write(id: string, data: string): void {
    const meta = this.sessions.get(id);
    if (!meta || meta.exited) return;
    void invoke("terminal_write", { id, data }).catch(() => {
      // 会话可能已退出；exit 事件会更新状态，不在每次按键时打扰用户
    });
  }

  private resize(id: string, cols: number, rows: number): void {
    const meta = this.sessions.get(id);
    if (!meta || meta.exited) return;
    void invoke("terminal_resize", { id, cols, rows }).catch(() => {});
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
