/**
 * 会话与草稿宿主：session.json 持久化（打开文件 + 光标 + 分栏比例）、
 * 草稿自动保存与恢复、外部修改监听与重载。
 *
 * 服务层（services/session 的读写、services/fsWatch 的订阅）直接依赖；
 * 跨模块动作（重载当前标签、打开文件、新建未命名）经 deps 交回 main.ts，
 * 避免 app 模块互相耦合。
 */

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { getConfig, settings } from "../config/settings";
import { tabStore, type Tab } from "../store/tabs";
import {
  deleteDraft,
  listDrafts,
  readDraft,
  saveSession,
  writeDraft,
  type DraftInfo,
  type SessionFile,
  type SessionState,
} from "../services/session";
import { onFileChanged, watchFiles } from "../services/fsWatch";
import { confirmAction } from "../ui/dialogs";
import { pad2 } from "../core/format";
import type { FileContent } from "../types/app";

export interface SessionHostDeps {
  getActiveTab: () => Tab | null;
  getView: () => EditorView;
  showMessage: (text: string) => void;
  refreshStatus: () => void;
  /** 内容变化后重载当前标签（loadActiveTab） */
  onReloadActiveTab: () => Promise<void>;
  /** 打开文件（草稿恢复用；含大文件分流） */
  onOpenFile: (path: string) => Promise<void>;
  /** 新建未命名文档（草稿恢复用） */
  onNewUntitled: (name: string) => Tab;
  /** 占位标签载入（草稿恢复用） */
  onLoadPendingTab: (tab: Tab) => Promise<boolean>;
}

export class SessionHost {
  /** 各标签最近光标位置（会话恢复用） */
  private cursorPos = new Map<string, { line: number; col: number }>();
  /** 会话恢复待应用的光标位置：文件路径 → 位置（标签首次载入后消费） */
  private restoredCursors = new Map<string, { line: number; col: number }>();
  /** 当前存在草稿的标签 id → 草稿 key */
  private draftKeys = new Map<string, string>();
  /** 每标签的草稿写入防抖定时器 */
  private draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 会话是否有未落盘的光标变化 */
  private sessionDirty = false;
  /** 结构变化的合并写盘定时器 */
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionStructureSig = "";
  /** 已登记监听的路径集合（用于跳过重复登记） */
  private watchedKey = "";
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private deps: SessionHostDeps,
    private draftBadgeEl: HTMLElement,
    private externalBadgeEl: HTMLElement,
  ) {
    // 光标位置只在空闲时兜底写盘，避免每次移动 / 输入都触发 IPC 与磁盘写入
    setInterval(() => {
      if (this.sessionDirty) this.saveNow();
    }, 15000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && (this.sessionDirty || this.sessionTimer)) this.saveNow();
    });
    window.addEventListener("beforeunload", () => {
      if (this.sessionDirty || this.sessionTimer) this.saveNow();
    });

    // 外部修改：Rust 侧监听，前端仅提示、不自动重载
    void onFileChanged((path) => {
      const tab = tabStore.findByPath(path);
      if (!tab || tab.externallyChanged) return;
      tabStore.markExternal(tab.id, true);
      this.deps.refreshStatus();
      this.deps.showMessage(
        `「${tab.name}」已被外部修改（点击状态栏「外部修改」可重新载入）`,
      );
    }).catch((e) => console.warn("[watch] 订阅失败", e));

    this.externalBadgeEl.addEventListener("click", () => {
      const tab = this.deps.getActiveTab();
      if (tab) void this.reloadFromDisk(tab);
    });
  }

  // ---- 会话 ----

  private currentSplitRatio(): number | null {
    try {
      const v = localStorage.getItem("my-editor.splitRatio");
      return v ? Number(v) : null;
    } catch {
      return null;
    }
  }

  private buildSessionState(): SessionState {
    const openFiles: SessionFile[] = [];
    for (const tab of tabStore.list()) {
      if (tab.kind !== "text" || !tab.path) continue;
      const pos = this.cursorPos.get(tab.id);
      openFiles.push({ path: tab.path, line: pos?.line ?? 1, col: pos?.col ?? 1 });
    }
    return {
      openFiles,
      activeFile: this.deps.getActiveTab()?.path ?? null,
      splitRatio: this.currentSplitRatio(),
    };
  }

  /** 立即写盘（页面隐藏 / 关闭 / 定时兜底） */
  saveNow(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.sessionDirty = false;
    void saveSession(this.buildSessionState()).catch(() => {});
  }

  /** 结构变化合并写盘：启动恢复多个标签时只落一次 */
  persistSession(): void {
    this.sessionDirty = false;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      this.sessionDirty = false;
      void saveSession(this.buildSessionState()).catch(() => {});
    }, 400);
  }

  /** 结构签名：标签集 / 路径 / 激活项变化才算需要写会话（输入与光标移动不写） */
  structureSignature(): string {
    const active = this.deps.getActiveTab();
    const list = tabStore
      .list()
      .map((t) => `${t.id}\u0001${t.path ?? ""}\u0001${t.kind}`)
      .join("\u0002");
    return `${active?.id ?? ""}\u0003${list}`;
  }

  /** 结构签名是否变化（变化时同步更新内部快照） */
  structureChanged(): boolean {
    const sig = this.structureSignature();
    if (sig === this.sessionStructureSig) return false;
    this.sessionStructureSig = sig;
    return true;
  }

  /** 记录光标（仅标记，不写盘：切标签 / 隐藏 / 定时兜底时再落会话） */
  setCursor(tabId: string, pos: { line: number; col: number }): void {
    this.cursorPos.set(tabId, pos);
    this.sessionDirty = true;
  }

  /** 会话恢复的光标位置（bootstrap 载入） */
  primeRestoredCursors(files: { path: string; line: number; col: number }[]): void {
    for (const f of files) this.restoredCursors.set(f.path, { line: f.line, col: f.col });
  }

  /** 标签载入后应用会话恢复的光标位置 */
  applyRestoredCursor(tab: Tab | null): void {
    if (!tab?.path) return;
    const pos = this.restoredCursors.get(tab.path);
    if (!pos) return;
    this.restoredCursors.delete(tab.path);
    this.cursorPos.set(tab.id, { line: pos.line, col: pos.col });
    const view = this.deps.getView();
    const line = view.state.doc.line(Math.min(Math.max(1, pos.line), view.state.doc.lines));
    const anchor = Math.min(line.from + Math.max(0, pos.col - 1), line.to);
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
  }

  // ---- 草稿 ----

  /** 草稿只针对可编辑的普通文本标签（大文件虚拟视图 / 只读 / 占位标签不写） */
  private draftable(tab: Tab): boolean {
    return tab.kind === "text" && !tab.virtual && !tab.pending && !tab.readonly;
  }

  /** 草稿标识：文件路径；未命名标签用其标签 id */
  private draftKeyFor(tab: Tab): string {
    return tab.path || `untitled:${tab.id}`;
  }

  /** 输入后防抖写草稿（配置关闭时不写） */
  scheduleDraftSave(tab: Tab): void {
    if (!getConfig().session.draftAutosave || !this.draftable(tab)) return;
    const pending = this.draftTimers.get(tab.id);
    if (pending) clearTimeout(pending);
    this.draftTimers.set(
      tab.id,
      setTimeout(() => {
        this.draftTimers.delete(tab.id);
        void this.persistDraft(tab.id);
      }, getConfig().session.draftDebounceMs),
    );
  }

  /** 写草稿：内容与磁盘一致时清除，否则写入并标记「草稿已存」 */
  async persistDraft(tabId: string): Promise<void> {
    const tab = tabStore.findById(tabId);
    if (!tab || !this.draftable(tab)) return;
    if (!tab.dirty) {
      await this.discardDraft(tabId);
      return;
    }
    const key = this.draftKeyFor(tab);
    try {
      await writeDraft({
        key,
        path: tab.path,
        name: tab.name,
        content: tab.content,
        encoding: tab.encoding,
        newline: tab.newline,
        hasBom: tab.has_bom,
      });
      this.draftKeys.set(tabId, key);
      this.refreshDraftBadge();
    } catch (e) {
      console.warn("[draft] 写入失败", e);
    }
  }

  /** 删除草稿（保存成功 / 用户丢弃 / 内容回到基线时） */
  async discardDraft(tabId: string): Promise<void> {
    const timer = this.draftTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.draftTimers.delete(tabId);
    }
    const tab = tabStore.findById(tabId);
    const key = this.draftKeys.get(tabId) ?? (tab ? this.draftKeyFor(tab) : null);
    this.draftKeys.delete(tabId);
    if (!key) return;
    try {
      await deleteDraft(key);
    } catch {
      // 草稿不存在或删除失败：忽略
    }
    this.refreshDraftBadge();
  }

  /** 标签关闭：清理定时器与草稿记录（草稿本体由关闭流程先行落盘/丢弃） */
  forgetDraft(tabId: string): void {
    const timer = this.draftTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.draftTimers.delete(tabId);
    this.draftKeys.delete(tabId);
    this.cursorPos.delete(tabId);
  }

  /** 退出前 flush：会话立即写盘 + 所有待写草稿落盘 */
  async flush(): Promise<void> {
    if (this.sessionDirty || this.sessionTimer) this.saveNow();
    const timers = [...this.draftTimers.entries()];
    for (const [id, timer] of timers) {
      clearTimeout(timer);
      this.draftTimers.delete(id);
      await this.persistDraft(id);
    }
  }

  /** 状态栏「草稿已存」标记：仅激活标签存在草稿时显示 */
  refreshDraftBadge(): void {
    const tab = this.deps.getActiveTab();
    this.draftBadgeEl.classList.toggle("hidden", !tab || !this.draftKeys.has(tab.id));
  }

  /** 草稿时间展示（YYYY-MM-DD HH:mm） */
  private draftTime(secs: number): string {
    const d = new Date(secs * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** 找到/新建草稿对应的标签：有路径则打开（占位标签先载入），未命名则新建 */
  private async ensureTabForDraft(draft: DraftInfo): Promise<Tab | null> {
    if (!draft.path) return this.deps.onNewUntitled(draft.name);
    let tab = tabStore.findByPath(draft.path);
    if (!tab) {
      await this.deps.onOpenFile(draft.path);
      tab = tabStore.findByPath(draft.path);
    }
    if (!tab) return null;
    // 大文件虚拟视图 / 占位标签尚未载入时草稿不适用
    if (tab.virtual) return null;
    if (tab.pending && !(await this.deps.onLoadPendingTab(tab))) return null;
    return tab;
  }

  /** 启动时处理草稿：原文件未变 →「恢复 / 丢弃」；原文件已变 →「另存为」 */
  async offerDraftRecovery(): Promise<void> {
    let drafts: DraftInfo[];
    try {
      drafts = await listDrafts();
    } catch {
      return;
    }
    let applied = false;
    for (const draft of drafts) {
      const payload = await readDraft(draft.key).catch(() => null);
      if (draft.stale) {
        const ok = await confirmAction(
          `「${draft.name}」的原文件已被修改，草稿（${this.draftTime(draft.savedAt)}）已过期。是否另存为新的未命名文档？`,
          "另存为",
        );
        if (!ok || !payload?.content) {
          await deleteDraft(draft.key).catch(() => {});
          continue;
        }
        const tab = this.deps.onNewUntitled(draft.name);
        tabStore.applyDraft(tab.id, payload.content);
        applied = true;
      } else {
        const ok = await confirmAction(
          `「${draft.name}」存在未保存的草稿（${this.draftTime(draft.savedAt)}），是否恢复？`,
          "恢复",
        );
        if (!ok || !payload?.content) {
          await deleteDraft(draft.key).catch(() => {});
          continue;
        }
        const tab = await this.ensureTabForDraft(draft);
        if (!tab) continue;
        tabStore.applyDraft(tab.id, payload.content);
        applied = true;
        // 内容已接管：以新 key 立即重落草稿，避免中途丢失
        void this.persistDraft(tab.id);
      }
      // 原草稿已消费，删除以免下次启动重复提示
      await deleteDraft(draft.key).catch(() => {});
    }
    if (applied) {
      if (this.deps.getActiveTab()) await this.deps.onReloadActiveTab();
      this.deps.showMessage("已恢复草稿内容（未保存，Ctrl+S 保存）");
    }
  }

  // ---- 外部修改监听 ----

  /** 需要监听的标签：可编辑的磁盘文本标签 */
  private watchedPaths(): string[] {
    return tabStore
      .list()
      .filter((t) => t.kind === "text" && !!t.path && !t.virtual)
      .map((t) => t.path as string);
  }

  /** 立即重新登记（打开 / 保存 / 重载后调用：刷新指纹并开启自身写入的静默窗口） */
  refreshWatched(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    const paths = this.watchedPaths();
    this.watchedKey = paths.join("|");
    void watchFiles(paths).catch((e) => console.warn("[watch] 登记失败", e));
  }

  /** 标签集变化时的防抖登记（路径集合未变则跳过） */
  syncWatchedDebounced(): void {
    const paths = this.watchedPaths();
    const key = paths.join("|");
    if (key === this.watchedKey) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.watchedKey = key;
      void watchFiles(paths).catch((e) => console.warn("[watch] 登记失败", e));
    }, 600);
  }

  /** 从磁盘重新载入标签（外部修改后由状态栏触发） */
  async reloadFromDisk(tab: Tab): Promise<void> {
    if (tab.kind !== "text" || !tab.path) return;
    if (tab.dirty) {
      const ok = await confirmAction(
        `「${tab.name}」有未保存的修改，重新载入将丢弃这些修改。继续？`,
        "丢弃并重载",
      );
      if (!ok) return;
    }
    try {
      const data = await invoke<FileContent>("open_text_file", {
        path: tab.path,
        largeFileThreshold: settings.largeFileThreshold,
        logExtensions: getConfig().largeFile.logExtensions,
      });
      tabStore.reopenWith(tab.id, data);
      tabStore.markExternal(tab.id, false);
      if (tabStore.active()?.id === tab.id) await this.deps.onReloadActiveTab();
      this.deps.refreshStatus();
      this.refreshWatched();
      this.deps.showMessage(`已重新载入：${tab.name}`);
    } catch (e) {
      this.deps.showMessage(`重新载入失败：${String(e).split("\n")[0]}`);
    }
  }
}
