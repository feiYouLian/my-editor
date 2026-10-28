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
import { addNotice } from "./noticeStore";
import { confirmAction } from "../ui/dialogs";
import { openStatusMenu } from "../ui/statusMenu";
import { pickDraftsToRecover, type DraftRow } from "../panels/draftRecovery";
import { formatSize, pad2 } from "../core/format";
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
  /** 当前标签与磁盘内容比较（外部修改提示用；不要求有未保存改动） */
  onDiffDisk: () => void;
  /** 某标签的书签行号（写进会话，重启后恢复） */
  getBookmarks: (tabId: string) => number[];
  /** 某标签的折叠区（[起始行, 结束行]，写进会话） */
  getFolds: (tabId: string) => number[][];
  /** 关闭标签（文件已不存在时给用户的出路） */
  onCloseTab?: (tabId: string) => void;
  /** 外部修改发生在"当前正看着的标签"上：立即询问是否重新载入（后台标签不打扰） */
  onExternalOnActive?: (tab: Tab) => void;
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
  /** 文件监听失败只提示一次：反反复复弹会变成噪音 */
  private watchWarned = false;

  private warnWatchFailed(e: unknown): void {
    console.warn("[watch] 失败", e);
    if (this.watchWarned) return;
    this.watchWarned = true;
    // 监听挂了等于「外部修改」永远不提示，属于功能静默降级，必须说一声
    this.deps.showMessage("文件监听启动失败：外部修改将不会自动提示");
  }

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

    // 外部修改：不在后台打扰。
    // 后台标签只在标签上加 ⟳；用户切到该标签时才弹确认（由 main.ts 的订阅触发），
    // 这样"没选中就不管、选中时才问"成为默认行为。
    void onFileChanged((path) => {
      const tab = tabStore.findByPath(path);
      if (!tab || tab.externallyChanged) return;
      tabStore.markExternal(tab.id, true);
      this.deps.refreshStatus();
      // 通知中心留一条：状态栏「外部修改」只在激活标签显示，后台标签只有一个 ⟳，
      // 错过之后没有任何地方能回看是哪几个文件被动过。
      addNotice(
        "external",
        `「${tab.name}」已被其它程序修改`,
        [
          {
            label: "处理",
            run: () => {
              if (tabStore.active()?.id === tab.id) {
                this.deps.onExternalOnActive?.(tab);
              } else {
                this.deps.showMessage(`请先切换到「${tab.name}」（标签上有 ⟳ 标记）`);
              }
            },
          },
        ],
        `ext:${tab.id}`,
      );
      if (tabStore.active()?.id === tab.id) this.deps.onExternalOnActive?.(tab);
    }).catch((e) => this.warnWatchFailed(e));

    this.externalBadgeEl.addEventListener("click", (e) => {
      const tab = this.deps.getActiveTab();
      if (!tab || !tab.path) return;
      if (!tab.externallyChanged) {
        this.deps.showMessage("当前文件没有外部修改");
        return;
      }
      // 三选：重新载入 / 对比后决定 / 忽略本次
      openStatusMenu<null>({
        anchor: { x: e.clientX, y: e.clientY },
        header: `「${tab.name}」已被外部修改`,
        options: [],
        actions: [
          { label: "重新载入磁盘内容", run: () => void this.reloadFromDisk(tab) },
          { label: "与磁盘内容比较", run: () => this.deps.onDiffDisk() },
          {
            label: "忽略本次修改",
            run: () => {
              tabStore.markExternal(tab.id, false);
              this.deps.refreshStatus();
              this.deps.showMessage("已忽略外部修改提示（编辑器内容未变）");
            },
          },
        ],
        current: null,
        tabId: tab.id,
        onMessage: this.deps.showMessage,
        onPick: () => {},
      });
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
      openFiles.push({
        path: tab.path,
        line: pos?.line ?? 1,
        col: pos?.col ?? 1,
        bookmarks: this.deps.getBookmarks(tab.id),
        folds: this.deps.getFolds(tab.id),
      });
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
        content: tabStore.snapshotOf(tab),
        encoding: tab.encoding,
        newline: tab.newline,
        hasBom: tab.has_bom,
      });
      this.draftKeys.set(tabId, key);
      this.refreshDraftBadge();
    } catch (e) {
      // 草稿是未保存内容的最后一道网：写失败必须让用户知道，不能只进 console
      console.warn("[draft] 写入失败", e);
      addNotice(
        "saveFail",
        `草稿写入失败：「${tab.name}」未保存的内容可能无法恢复`,
        [],
        `draft:${tabId}`,
      );
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

  /** 启动时处理草稿：统一列表勾选 → 批量恢复（原文件已变 → 另存为副本） */
  async offerDraftRecovery(): Promise<void> {
    let drafts: DraftInfo[];
    try {
      drafts = await listDrafts();
    } catch {
      return;
    }
    if (drafts.length === 0) return;

    // 先读内容：列表要展示体积，恢复时不再重复读
    const contents = new Map<string, string>();
    const rows: DraftRow[] = [];
    for (const draft of drafts) {
      const payload = await readDraft(draft.key).catch(() => null);
      if (!payload?.content) {
        // 读取失败 / 空草稿：直接清掉，避免下次启动重复出现
        await deleteDraft(draft.key).catch(() => {});
        continue;
      }
      contents.set(draft.key, payload.content);
      rows.push({
        key: draft.key,
        name: draft.name,
        savedAt: this.draftTime(draft.savedAt),
        sizeText: formatSize(new Blob([payload.content]).size),
        stale: draft.stale,
      });
    }
    if (rows.length === 0) return;

    const picked = await pickDraftsToRecover(rows);
    if (picked === null) return; // 稍后处理：草稿保留，下次启动再提示
    if (picked.length === 0) {
      for (const draft of drafts) await deleteDraft(draft.key).catch(() => {});
      // 数量取 rows：与对话框标题用户看到的条目数一致（读取失败的草稿已在上面清掉）
      this.deps.showMessage(`已丢弃 ${rows.length} 个草稿`);
      return;
    }

    const selected = new Set(picked);
    let restored = 0;
    for (const draft of drafts) {
      if (!selected.has(draft.key)) continue;
      const content = contents.get(draft.key) ?? "";
      if (!content) continue;
      if (draft.stale) {
        // 原文件已变：新建未命名文档承载草稿内容；命名加后缀避免与原文件混淆
        const tab = this.deps.onNewUntitled(`${draft.name}（副本）`);
        tabStore.applyDraft(tab.id, content);
        // 内容已接管：原草稿即将删除，立即以新 key 重落一份兜底
        void this.persistDraft(tab.id);
        restored++;
      } else {
        const tab = await this.ensureTabForDraft(draft);
        if (!tab) continue;
        tabStore.applyDraft(tab.id, content);
        restored++;
        // 内容已接管：以新 key 立即重落草稿，避免中途丢失
        void this.persistDraft(tab.id);
      }
      // 已消费的草稿删除，避免下次启动重复提示
      await deleteDraft(draft.key).catch(() => {});
    }
    // 反馈只说结果数量：未恢复的草稿未删除，下次启动仍会提示
    const failed = selected.size - restored;
    if (restored > 0) {
      if (this.deps.getActiveTab()) await this.deps.onReloadActiveTab();
      this.deps.showMessage(
        failed > 0
          ? `已恢复 ${restored} 个草稿，${failed} 个未能恢复，Ctrl+S 保存`
          : `已恢复 ${restored} 个草稿，Ctrl+S 保存`,
      );
    } else if (failed > 0) {
      this.deps.showMessage(`${failed} 个草稿未能恢复`);
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
    void watchFiles(paths).catch((e) => this.warnWatchFailed(e));
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
      void watchFiles(paths).catch((e) => this.warnWatchFailed(e));
    }, 600);
  }

  /**
   * 从磁盘重新载入标签。
   * force=true：调用方已在自己的对话框里问过"确认覆盖"，不再二次确认。
   */
  async reloadFromDisk(tab: Tab, opts: { force?: boolean } = {}): Promise<void> {
    if (tab.kind !== "text" || !tab.path) return;
    if (tab.dirty && !opts.force) {
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
      const raw = String(e);
      // 文件已被删除 / 移动：只报"重新载入失败"是死路，必须给出下一步
      if (/not found|no such file|不存在|os error 2|系统找不到/i.test(raw)) {
        const close = await confirmAction(
          `「${tab.name}」在磁盘上已不存在（可能被删除或移动）。\n关闭该标签可清理；取消则保留当前内容，可用「另存为」保存到别处。`,
          "关闭标签",
        );
        if (close) this.deps.onCloseTab?.(tab.id);
        return;
      }
      this.deps.showMessage(`重新载入失败：${raw.split("\n")[0]}`);
    }
  }
}
