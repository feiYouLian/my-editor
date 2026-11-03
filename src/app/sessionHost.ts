/**
 * 会话与草稿宿主：session.json 持久化（打开文件 + 光标 + 滚动位置 + 分栏比例）、
 * 草稿自动保存与恢复、外部修改监听与重载。
 *
 * 服务层（services/session 的读写、services/fsWatch 的订阅）直接依赖；
 * 跨模块动作（重载当前标签、打开文件、新建未命名）经 deps 交回 main.ts，
 * 避免 app 模块互相耦合。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { EditorView } from "@codemirror/view";
import { getConfig, settings } from "../config/settings";
import { tabStore, type Tab } from "../store/tabs";
import { runWhenIdle } from "../ui/idle";
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
import type { FileContent } from "../types/app";
import { firstLine } from "../core/errors";

export interface SessionHostDeps {
  getActiveTab: () => Tab | null;
  getView: () => EditorView;
  /** 编辑器当前承载的文档 id（判断实时滚动位置属于哪个标签） */
  getDocId?: () => string | null;
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

/** 草稿保存时间（秒）→ 菜单里的可读时间 */
function formatDraftTime(savedAt: number): string {
  const date = new Date(savedAt * 1000);
  if (Number.isNaN(date.getTime())) return "未知时间";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 会话里记录的标签位置：光标行列 + 滚动偏移 */
interface SavedPosition {
  line: number;
  col: number;
  /** 滚动位置（像素）；undefined = 旧会话没记录，恢复时退回「让光标可见」 */
  scrollTop?: number;
}

export class SessionHost {
  /** 各标签最近光标位置（会话恢复用） */
  private cursorPos = new Map<string, { line: number; col: number }>();
  /**
   * 各标签的滚动位置（像素）：切走时记录、载入后恢复。
   * 不监听 scroll 事件——切换标签时 `loadDocument` 会把滚动清零，
   * 监听器会把 0 当成用户位置写回去。
   */
  private scrollMemory = new Map<string, number>();
  /** 会话恢复待应用的光标位置：文件路径 → 位置（标签首次载入后消费） */
  private restoredCursors = new Map<string, SavedPosition>();
  /** 会话光标的备份：草稿恢复重载编辑器（选区归零）后用它重放一次 */
  private sessionCursors = new Map<string, SavedPosition>();
  /** 当前存在草稿的标签 id → 草稿 key */
  private draftKeys = new Map<string, string>();
  /** 每标签的草稿写入防抖定时器 */
  private draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 防抖结束后等待空闲的草稿写入：取消句柄（标签 id → cancel） */
  private draftIdle = new Map<string, () => void>();
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
  /** 窗口在后台时收到外部修改：标题加 ● 并请求任务栏提示（前台已有状态栏 / 标签标记） */
  private attentionMarked = false;

  private markBackgroundAttention(): void {
    if (this.attentionMarked) return;
    if (!document.hidden && document.hasFocus()) return;
    this.attentionMarked = true;
    const win = getCurrentWindow();
    void win.setTitle(`● ${document.title}`).catch(() => {});
    void win.requestUserAttention(UserAttentionType.Critical).catch(() => {});
  }

  /** 窗口回到前台：撤销标题圆点与任务栏闪烁（外部修改本身仍有状态栏 / 标签提示） */
  private clearBackgroundAttention(): void {
    if (!this.attentionMarked) return;
    this.attentionMarked = false;
    const win = getCurrentWindow();
    void win.setTitle(document.title).catch(() => {});
    void win.requestUserAttention(null).catch(() => {});
  }

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

    // 草稿徽标可点：给「草稿已存」一个应用内的恢复入口，而不是只能等下次启动
    this.draftBadgeEl.setAttribute("role", "button");
    this.draftBadgeEl.tabIndex = 0;
    this.draftBadgeEl.title = "查看 / 恢复草稿";
    this.draftBadgeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.showDraftMenu(e);
    });
    this.draftBadgeEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const rect = this.draftBadgeEl.getBoundingClientRect();
      void this.showDraftMenu({ clientX: rect.left, clientY: rect.top });
    });
    window.addEventListener("beforeunload", () => {
      if (this.sessionDirty || this.sessionTimer) this.saveNow();
    });
    window.addEventListener("focus", () => this.clearBackgroundAttention());

    // 外部修改：不在后台打扰。
    // 后台标签只在标签上加 ⟳；用户切到该标签时才弹确认（由 main.ts 的订阅触发），
    // 这样"没选中就不管、选中时才问"成为默认行为。
    void onFileChanged((path) => {
      const tab = tabStore.findByPath(path);
      if (!tab || tab.externallyChanged) return;
      tabStore.markExternal(tab.id, true);
      this.markBackgroundAttention();
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

  private buildSessionState(): SessionState {
    const active = this.deps.getActiveTab();
    const activeId = active?.id;
    const docId = this.deps.getDocId?.() ?? null;
    const openFiles: SessionFile[] = [];
    for (const tab of tabStore.list()) {
      if (tab.kind !== "text" || !tab.path) continue;
      const pos = this.cursorPos.get(tab.id);
      // 尚未载入过的标签只有会话原始记录：不兜底的话，任何一次中间写盘
      // （启动恢复后 400ms 的结构帧、15s 定时器）都会把它的位置覆盖成默认值
      const restore = this.restoredCursors.get(tab.path);
      // 激活标签的滚动位置实时读：纯滚动（光标没动）不会更新 scrollMemory，
      // 只有写盘这一刻才拿得到真实值。编辑器承载的必须是该标签，否则读数属于别人。
      const liveScroll =
        tab.id === activeId && docId === tab.id && !tab.virtual && !tab.pending
          ? this.deps.getView().scrollDOM.scrollTop
          : undefined;
      openFiles.push({
        path: tab.path,
        line: pos?.line ?? restore?.line ?? 1,
        col: pos?.col ?? restore?.col ?? 1,
        scrollTop: liveScroll ?? this.scrollMemory.get(tab.id) ?? restore?.scrollTop,
        bookmarks: this.deps.getBookmarks(tab.id),
        folds: this.deps.getFolds(tab.id),
        // 记录「选中的是哪一个」：重启后按它复原激活标签（Sublime 的会话行为）
        active: tab.id === activeId,
      });
    }
    return {
      openFiles,
      activeFile: active?.path ?? null,
      // 未命名标签不进 openFiles（没有路径）：单独记名字，草稿恢复后据此选中
      activeUntitledName: active && !active.path ? active.name : null,
      // 分栏比例已收敛到 config.json：会话不再保存/覆盖，旧字段保持 null 兼容旧 session
      splitRatio: null,
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

  /**
   * 切走标签前记录旧文档的滚动位置（调用方保证编辑器当前承载的正是 tabId）。
   * 编辑器只有一个滚动容器，切换后旧标签的位置就读不到了。
   */
  captureScroll(tabId: string | null): void {
    if (!tabId) return;
    this.scrollMemory.set(tabId, this.deps.getView().scrollDOM.scrollTop);
  }

  /** 标签载入后恢复它上次的滚动位置（没有记录就保持载入后的默认值） */
  restoreScroll(tab: Tab | null): void {
    if (!tab) return;
    const top = this.scrollMemory.get(tab.id);
    if (top === undefined) return;
    const view = this.deps.getView();
    // 等布局测量完成后再写，否则内容高度还没算出来，值会被夹紧
    view.requestMeasure({
      read: () => null,
      write: () => {
        view.scrollDOM.scrollTop = top;
      },
    });
  }

  /** 会话恢复的光标位置（bootstrap 载入）：同时留一份备份供重放 */
  primeRestoredCursors(
    files: { path: string; line: number; col: number; scrollTop?: number }[],
  ): void {
    for (const f of files) {
      const pos: SavedPosition = { line: f.line, col: f.col, scrollTop: f.scrollTop };
      this.restoredCursors.set(f.path, pos);
      this.sessionCursors.set(f.path, pos);
    }
  }

  /** 标签载入后应用会话恢复的光标位置（每个路径只消费一次） */
  applyRestoredCursor(tab: Tab | null): void {
    if (!tab?.path) return;
    const pos = this.restoredCursors.get(tab.path);
    if (!pos) return;
    this.restoredCursors.delete(tab.path);
    if (typeof pos.scrollTop === "number") this.scrollMemory.set(tab.id, pos.scrollTop);
    this.applyCursor(tab, pos);
  }

  /**
   * 重放会话光标：草稿恢复会重载编辑器、选区归零，
   * 启动流程最后用备份把关闭时的位置放回去。
   */
  replayRestoredCursor(tab: Tab | null): void {
    if (!tab?.path) return;
    const pos = this.sessionCursors.get(tab.path);
    if (!pos) return;
    if (typeof pos.scrollTop === "number") this.scrollMemory.set(tab.id, pos.scrollTop);
    this.applyCursor(tab, pos);
  }

  private applyCursor(tab: Tab, pos: SavedPosition): void {
    this.cursorPos.set(tab.id, { line: pos.line, col: pos.col });
    const view = this.deps.getView();
    const line = view.state.doc.line(Math.min(Math.max(1, pos.line), view.state.doc.lines));
    const anchor = Math.min(line.from + Math.max(0, pos.col - 1), line.to);
    if (pos.scrollTop === undefined) {
      // 旧会话没记录滚动位置：至少保证光标可见
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      return;
    }
    // 有精确滚动偏移就以它为准：光标可能不在视口内，那正是关闭时看到的视图。
    // 只靠 scrollIntoView 是「让光标刚好可见」，滚到文件底部时会有几行偏差。
    view.dispatch({ selection: { anchor } });
    this.restoreScroll(tab);
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

  /** 输入后防抖写草稿：未保存内容永远是本地兜底，不提供关闭入口 */
  scheduleDraftSave(tab: Tab): void {
    if (!this.draftable(tab)) return;
    const pending = this.draftTimers.get(tab.id);
    if (pending) clearTimeout(pending);
    this.draftIdle.get(tab.id)?.();
    this.draftIdle.delete(tab.id);
    this.draftTimers.set(
      tab.id,
      setTimeout(() => {
        this.draftTimers.delete(tab.id);
        // 草稿要序列化全文并写盘：推迟到空闲时段，避免和输入 / 滚动抢同一帧
        const cancel = runWhenIdle(() => {
          this.draftIdle.delete(tab.id);
          void this.persistDraft(tab.id);
        }, 1500);
        this.draftIdle.set(tab.id, cancel);
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
        // 未命名标签必须写 null（不能是空串），否则会被当成「原文件已不存在」判过期
        path: tab.path || null,
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
    // 已进入空闲队列的写入也要作废，否则删掉的草稿会被重新写回来
    this.draftIdle.get(tabId)?.();
    this.draftIdle.delete(tabId);
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
    this.draftIdle.get(tabId)?.();
    this.draftIdle.delete(tabId);
    this.draftKeys.delete(tabId);
    this.cursorPos.delete(tabId);
    // 标签已关闭：滚动位置不再有用（id 不复用，留着只会让 Map 无界增长）
    this.scrollMemory.delete(tabId);
  }

  /** 退出 / 重载界面之前 flush：会话立即写盘 + 所有待写草稿落盘 */
  async flush(): Promise<void> {
    // 这里必须 await：重载界面（location.reload）会中断未完成的 IPC，
    // 用 saveNow 的 fire-and-forget 写入可能还没落盘页面就换了
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.sessionDirty = false;
    await saveSession(this.buildSessionState()).catch(() => {});
    // 待写草稿可能停在"防抖定时器"或"空闲队列"两处：统一取消后立即落盘
    const ids = new Set([...this.draftTimers.keys(), ...this.draftIdle.keys()]);
    for (const [id, timer] of this.draftTimers) {
      clearTimeout(timer);
      this.draftTimers.delete(id);
    }
    for (const [id, cancel] of this.draftIdle) {
      cancel();
      this.draftIdle.delete(id);
    }
    for (const id of ids) await this.persistDraft(id);
  }

  /** 状态栏「草稿已存」标记：仅激活标签存在草稿时显示 */
  refreshDraftBadge(): void {
    const tab = this.deps.getActiveTab();
    this.draftBadgeEl.classList.toggle("hidden", !tab || !this.draftKeys.has(tab.id));
  }

  /**
   * 草稿徽标点击：列出磁盘上的草稿（最近 10 个），选择后恢复为标签。
   * 恢复沿用启动自动恢复的同一套规则：原文件已变化则新建「副本」，否则打开原文件。
   */
  private async showDraftMenu(anchor: { clientX: number; clientY: number }): Promise<void> {
    const tab = tabStore.active();
    if (!tab) return;
    let drafts: DraftInfo[];
    try {
      drafts = await listDrafts();
    } catch (e) {
      this.deps.showMessage(`读取草稿列表失败：${firstLine(e)}`);
      return;
    }
    if (drafts.length === 0) {
      this.deps.showMessage("当前没有可恢复的草稿");
      return;
    }
    const recent = drafts
      .slice()
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, 10);
    const actions = recent.map((draft) => ({
      label: `${draft.name} · ${formatDraftTime(draft.savedAt)}${draft.stale ? "（原文件已变化）" : ""}`,
      run: () => this.openDraftActions(draft, anchor),
    }));
    openStatusMenu<null>({
      anchor: { x: anchor.clientX, y: anchor.clientY },
      header:
        drafts.length > recent.length
          ? `草稿（共 ${drafts.length} 个，显示最近 ${recent.length} 个）`
          : `草稿（${drafts.length} 个）— 点击选择恢复 / 丢弃`,
      options: [],
      actions,
      current: null,
      tabId: tab.id,
      onMessage: this.deps.showMessage,
      onPick: () => {},
    });
  }

  /** 二级菜单：单个草稿的「恢复 / 丢弃」 */
  private openDraftActions(
    draft: DraftInfo,
    anchor: { clientX: number; clientY: number },
  ): void {
    const tab = tabStore.active();
    if (!tab) return;
    openStatusMenu<null>({
      anchor: { x: anchor.clientX, y: anchor.clientY },
      header: `草稿「${draft.name}」· ${formatDraftTime(draft.savedAt)}`,
      options: [],
      actions: [
        { label: "恢复草稿内容", run: () => void this.restoreDraft(draft) },
        { label: "丢弃这个草稿", run: () => void this.dropDraft(draft) },
      ],
      current: null,
      tabId: tab.id,
      onMessage: this.deps.showMessage,
      onPick: () => {},
    });
  }

  /** 删除磁盘上的草稿（不影响标签里已有的内容） */
  private async dropDraft(draft: DraftInfo): Promise<void> {
    const ok = await confirmAction(
      `删除草稿「${draft.name}」？删除后这份未保存内容将无法恢复。`,
      "删除草稿",
    );
    if (!ok) return;
    try {
      await deleteDraft(draft.key);
    } catch (e) {
      this.deps.showMessage(`删除草稿失败：${firstLine(e)}`);
      return;
    }
    for (const [tabId, key] of [...this.draftKeys]) {
      if (key === draft.key) this.draftKeys.delete(tabId);
    }
    this.refreshDraftBadge();
    this.deps.showMessage(`已删除草稿「${draft.name}」`);
  }

  /** 从草稿恢复一个标签；已有未保存修改时先确认覆盖 */
  private async restoreDraft(draft: DraftInfo): Promise<void> {
    const payload = await readDraft(draft.key).catch(() => null);
    if (!payload?.content) {
      this.deps.showMessage(`草稿「${draft.name}」为空或读取失败`);
      return;
    }
    const existing = draft.path ? tabStore.findByPath(draft.path) : null;
    if (existing?.dirty) {
      const ok = await confirmAction(
        `「${existing.name}」有未保存修改，恢复草稿会覆盖当前内容。继续吗？`,
        "覆盖并恢复",
      );
      if (!ok) return;
    }
    const target = draft.stale
      ? this.deps.onNewUntitled(`${draft.name}（副本）`)
      : await this.ensureTabForDraft(draft);
    if (!target) {
      this.deps.showMessage(`无法为草稿「${draft.name}」打开标签`);
      return;
    }
    tabStore.applyDraft(target.id, payload.content);
    // 先删旧草稿再按当前标签的 key 落盘（与启动恢复同一顺序，避免同 key 自删）
    await deleteDraft(draft.key).catch(() => {});
    if (tabStore.active()?.id === target.id) await this.deps.onReloadActiveTab();
    else tabStore.activate(target.id);
    void this.persistDraft(target.id);
    this.deps.showMessage(`已恢复草稿「${draft.name}」，Ctrl+S 保存`);
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

  /**
   * 启动时自动恢复全部草稿：不再询问（去掉了「稍后处理 / 全部丢弃」的选择）。
   * 原文件已变化的草稿另存为副本；恢复过程只留一条状态栏结果消息。
   */
  async autoRestoreDrafts(activeName?: string | null): Promise<{
    restored: number;
    /** 会话里选中的未命名标签在恢复后对应的 tab id（没有则为 null） */
    activeTabId: string | null;
  }> {
    let drafts: DraftInfo[];
    try {
      drafts = await listDrafts();
    } catch {
      return { restored: 0, activeTabId: null };
    }
    if (drafts.length === 0) return { restored: 0, activeTabId: null };

    let restored = 0;
    let failed = 0;
    let activeTabId: string | null = null;
    for (const draft of drafts) {
      const payload = await readDraft(draft.key).catch(() => null);
      if (!payload?.content) {
        // 读取失败 / 空草稿：直接清掉，避免每次启动重复处理
        await deleteDraft(draft.key).catch(() => {});
        continue;
      }
      let tab: Tab | null;
      if (draft.stale) {
        // 原文件已变：新建未命名文档承载草稿内容；命名加后缀避免与原文件混淆
        tab = this.deps.onNewUntitled(`${draft.name}（副本）`);
      } else {
        tab = await this.ensureTabForDraft(draft);
      }
      if (!tab) {
        failed++;
        continue;
      }
      tabStore.applyDraft(tab.id, payload.content);
      if (activeName && draft.name === activeName) activeTabId = tab.id;
      restored++;
      // 先删旧草稿、再以当前标签的 key 重新落盘：
      // 重启后标签 id 从 tab-1 重新开始，新草稿 key 可能与旧 key 相同，
      // 先写后删会把刚写好的草稿一起删掉。
      await deleteDraft(draft.key).catch(() => {});
      void this.persistDraft(tab.id);
    }
    if (restored > 0) {
      if (this.deps.getActiveTab()) await this.deps.onReloadActiveTab();
      this.deps.showMessage(
        failed > 0
          ? `已自动恢复 ${restored} 个草稿，${failed} 个未能恢复，Ctrl+S 保存`
          : `已自动恢复 ${restored} 个草稿，Ctrl+S 保存`,
      );
    } else if (failed > 0) {
      this.deps.showMessage(`${failed} 个草稿未能恢复`);
    }
    return { restored, activeTabId };
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
      this.deps.showMessage(`重新载入失败：${firstLine(raw)}`);
    }
  }
}
