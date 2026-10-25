import type { FileContent } from "../types/app";

/**
 * 多标签页状态。
 * 单 CM6 实例 + 按标签缓存内容：切换时交换文档，
 * 代价是各标签的撤销历史不保留。
 */

/**
 * 内容指纹：长度 + 两个独立 32 位哈希。
 * 用指纹替代整份基线字符串，每个标签省一份全文常驻；碰撞概率约 2^-64，可视为无误判。
 */
export interface ContentFingerprint {
  len: number;
  a: number;
  b: number;
}

/** 空内容的指纹（未落盘 / 占位 / 图片标签的基线） */
const EMPTY_FINGERPRINT: ContentFingerprint = { len: 0, a: 0x811c9dc5, b: 5381 };

/** FNV-1a + djb2 双哈希：一次遍历同时算两个独立散列 */
function fingerprint(text: string): ContentFingerprint {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return { len: text.length, a, b };
}

/** 编辑器当前内容的读取入口（由 main.ts 注入，避免 store 依赖编辑器实现） */
export interface ContentProvider {
  /** 编辑器当前承载的文档 id（与查询 id 不一致说明该标签已不在编辑器里） */
  docId: () => string | null;
  /** 全文：O(n)，仅在确实需要全文时调用 */
  full: () => string;
  /** 前 N 个字符：O(N)，供 cURL 特征检测等只读头部的场景 */
  head: (chars: number) => string;
}

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  /** text：进入编辑器；image：进入图片查看器 */
  kind: "text" | "image";
  /** 图片 tab 的 data URL（kind=image 时有效） */
  dataUrl?: string;
  content: string;
  /** 最近一次打开/保存时的内容指纹（代替整份基线字符串） */
  savedFingerprint: ContentFingerprint;
  /** 磁盘内容是否以换行结尾：diff 采用差异块补尾换行用 */
  savedTrailingNewline: boolean;
  /** content 可能落后于编辑器：按键只标脏，读取前经 snapshotOf 同步 */
  contentDirty?: boolean;
  size: number;
  dirty: boolean;
  encoding: string;
  /** 最近一次打开/保存时的编码基线 */
  savedEncoding: string;
  /** 编码置信度："bom" | "high" | "low" | "user" */
  encodingConfidence: string;
  /** 候选编码（状态栏「重新打开为」菜单） */
  encodingCandidates: string[];
  newline: string;
  /** 最近一次打开/保存时的换行符基线 */
  savedNewline: string;
  has_bom: boolean;
  /** 只读：大文件 / 日志文件命中只读守卫，编辑器禁用编辑入口 */
  readonly: boolean;
  /** 只读原因（非只读时为空串） */
  readonlyReason: string;
  /** 大文件虚拟视图标签：content 为空，行内容按窗口从后端拉取 */
  virtual?: boolean;
  /** 大文件会话 id（virtual 时有效） */
  largeId?: string;
  /** 会话恢复的占位标签：仅登记路径，内容待首次激活时才载入 */
  pending?: boolean;
  /** 磁盘文件被外部修改（状态栏提示，可点击重新载入） */
  externallyChanged?: boolean;
  /** 语言模式覆盖：undefined = 按扩展名自动，null = 纯文本，字符串 = 指定语言键 */
  languageOverride?: string | null;
  /** 乱码检测建议的编码（无建议 / 未检出时为空串或 undefined） */
  mojibakeSuggested?: string;
  /** 乱码检测说明（非空即表示疑似乱码，状态栏加 ⚠） */
  mojibakeReason?: string;
}

let seq = 0;

/**
 * 标签变更类型：
 * - structure：标签集 / 路径 / 激活项 / 元数据变化，订阅方需重渲染，
 *   立即同步通知（状态机依赖其同步性）；
 * - content：仅编辑器内容变化（每次按键），按帧合并——同一帧内的
 *   多次输入只通知一次，避免每按键全量重渲染标签栏/状态栏。
 */
export type TabChangeKind = "structure" | "content";

/** 停手精算脏标记的等待时长：按键路径只标脏，无新输入才取全文比较 */
const CONTENT_SETTLE_MS = 800;

class TabStore {
  private tabs: Tab[] = [];
  private activeId: string | null = null;
  /** 编辑器内容提供者（main.ts 注入）：惰性快照的唯一读取入口 */
  private provider: ContentProvider | null = null;
  private listeners = new Set<(kind: TabChangeKind) => void>();
  /** 批量关闭确认（由 main.ts 注入，避免 store → ui 依赖） */
  private confirmHandler: ((message: string) => Promise<boolean>) | null = null;

  /** 注入确认对话框（main.ts 启动时调用一次） */
  setConfirmHandler(fn: (message: string) => Promise<boolean>): void {
    this.confirmHandler = fn;
  }

  /** 标签被移除（关闭 / 被虚拟视图取代）时通知，供宿主做统一清理 */
  private closeListeners = new Set<(tab: Tab) => void>();
  /** 内容变更的按帧合并：rAF 句柄与待通知标记 */
  private contentRaf: number | null = null;
  private contentPending = false;
  /** 各标签的停手精算定时器（关闭 / 被替代时清理，避免为已消失的标签取内容） */
  private settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe(fn: (kind: TabChangeKind) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 注入编辑器内容提供者（编辑器创建后调用） */
  setContentProvider(provider: ContentProvider | null): void {
    this.provider = provider;
  }

  /** 订阅标签移除事件：编辑器状态缓存 / 光标 / 草稿 / 大文件会话等
   *  清理都必须走这里，保证单条关闭与批量关闭行为一致 */
  onTabClosed(fn: (tab: Tab) => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  private notifyClosed(tab: Tab): void {
    this.clearSettle(tab.id);
    this.closeListeners.forEach((fn) => fn(tab));
  }

  /** 结构变更：立即通知。已排程的内容通知被其覆盖（订阅方读的是最新状态） */
  private emitStructure(): void {
    this.contentPending = false;
    if (this.contentRaf !== null) {
      cancelAnimationFrame(this.contentRaf);
      this.contentRaf = null;
    }
    this.listeners.forEach((fn) => fn("structure"));
  }

  /** 内容变更（编辑器输入）：按帧合并，同一帧内只通知一次 */
  private emitContent(): void {
    this.contentPending = true;
    if (this.contentRaf !== null) return; // 本帧已排程
    this.contentRaf = requestAnimationFrame(() => {
      this.contentRaf = null;
      if (!this.contentPending) return;
      this.contentPending = false;
      this.listeners.forEach((fn) => fn("content"));
    });
  }

  list(): Tab[] {
    return this.tabs;
  }

  /**
   * 移动标签到指定索引（拖拽排序）。
   * toIndex 是“移除后数组”的目标索引（调用方已根据原位置换算）。
   * 顺序变更属于结构帧：订阅方会重新渲染标签栏并持久化会话。
   */
  move(id: string, toIndex: number): void {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const target = Math.max(0, Math.min(this.tabs.length - 1, toIndex));
    if (from === target) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(target, 0, tab);
    this.emitStructure();
  }

  active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  /**
   * 打开文本文件：已打开则激活，否则新开标签（未命名文档 path 为空，每次新建独立标签）。
   * opts.unsaved：内容未落盘（格式转换/代码生成结果），基线指纹置空使其标记为脏；
   * opts.languageOverride：直接指定高亮语言，避免首次渲染后再次切换。
   */
  open(
    content: FileContent,
    opts: { unsaved?: boolean; languageOverride?: string | null } = {},
  ): Tab {
    const existing = content.path
      ? this.tabs.find((t) => t.path === content.path)
      : undefined;
    if (existing) {
      this.syncContent(this.activeId);
      this.activeId = existing.id;
      this.emitStructure();
      return existing;
    }
    const tab: Tab = {
      id: `tab-${++seq}`,
      path: content.path,
      name: content.name,
      kind: "text",
      content: content.content,
      savedFingerprint: opts.unsaved ? EMPTY_FINGERPRINT : fingerprint(content.content),
      savedTrailingNewline: opts.unsaved ? false : content.content.endsWith("\n"),
      size: content.size,
      dirty: opts.unsaved === true && content.content !== "",
      encoding: content.encoding,
      savedEncoding: content.encoding,
      newline: content.newline,
      savedNewline: content.newline,
      has_bom: content.has_bom,
      encodingConfidence: content.encoding_confidence,
      encodingCandidates: content.encoding_candidates,
      readonly: content.readonly,
      readonlyReason: content.readonly_reason,
    };
    if (opts.languageOverride !== undefined) tab.languageOverride = opts.languageOverride;
    this.tabs.push(tab);
    // 切换激活项前先落回旧标签内容，否则之后保存/草稿会读到旧值
    this.syncContent(this.activeId);
    this.activeId = tab.id;
    this.emitStructure();
    return tab;
  }

  /** 打开大文件只读虚拟视图标签（同一路径若已有普通标签则以虚拟视图取代） */
  openVirtual(info: {
    id: string;
    path: string;
    name: string;
    size: number;
    encoding: string;
    newline: string;
  }): Tab {
    const existing = this.tabs.find((t) => t.path === info.path);
    if (existing) {
      if (existing.virtual) {
        this.activeId = existing.id;
        this.emitStructure();
        return existing;
      }
      const idx = this.tabs.indexOf(existing);
      if (idx >= 0) {
        this.tabs.splice(idx, 1);
        // 被取代的标签也要走清理：否则其 EditorState 缓存会滞留
        this.notifyClosed(existing);
      }
    }
    const tab: Tab = {
      id: `tab-${++seq}`,
      path: info.path,
      name: info.name,
      kind: "text",
      content: "",
      savedFingerprint: EMPTY_FINGERPRINT,
      savedTrailingNewline: false,
      size: info.size,
      dirty: false,
      encoding: info.encoding,
      savedEncoding: info.encoding,
      newline: info.newline,
      savedNewline: info.newline,
      has_bom: false,
      encodingConfidence: "high",
      encodingCandidates: [],
      readonly: true,
      readonlyReason: "大文件只读视图",
      virtual: true,
      largeId: info.id,
    };
    this.tabs.push(tab);
    // 切换激活项前先落回旧标签内容，否则之后保存/草稿会读到旧值
    this.syncContent(this.activeId);
    this.activeId = tab.id;
    this.emitStructure();
    return tab;
  }

  /** 用已载入内容填充标签（占位标签载入 / 虚拟标签转编辑器共用） */
  private applyContent(tab: Tab, content: FileContent): void {
    tab.content = content.content;
    tab.contentDirty = false;
    tab.savedFingerprint = fingerprint(content.content);
    tab.savedTrailingNewline = content.content.endsWith("\n");
    tab.size = content.size;
    tab.encoding = content.encoding;
    tab.savedEncoding = content.encoding;
    tab.newline = content.newline;
    tab.savedNewline = content.newline;
    tab.has_bom = content.has_bom;
    tab.encodingConfidence = content.encoding_confidence;
    tab.encodingCandidates = content.encoding_candidates;
    tab.readonly = content.readonly;
    tab.readonlyReason = content.readonly_reason;
    tab.dirty = false;
    tab.pending = false;
  }

  /** 把虚拟视图标签就地转为普通文本标签（逃生门：改用编辑器打开） */
  convertVirtual(id: string, content: FileContent): Tab | null {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return null;
    tab.virtual = false;
    tab.largeId = undefined;
    this.applyContent(tab, content);
    this.emitStructure();
    return tab;
  }

  /** 标记 / 清除「外部修改」状态 */
  markExternal(id: string, changed: boolean): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab && tab.externallyChanged !== changed) {
      tab.externallyChanged = changed;
      this.emitStructure();
    }
  }

  /**
   * 设置语言模式覆盖（纯改状态、不重渲染，避免重载文档）：
   * 由调用方同步编辑器高亮与状态栏。
   */
  setLanguageOverride(id: string, override: string | null | undefined): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) tab.languageOverride = override;
  }

  /** 「另存为指定编码」落盘后同步标签编码（编码与基线一并更新，避免残留脏标记） */
  applySavedEncoding(id: string, encoding: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.encoding = encoding;
    tab.savedEncoding = encoding;
    tab.encodingConfidence = "user";
  }

  /** 记录乱码检测结论（suggested 与 reason 均为空串表示无问题） */
  setMojibake(id: string, suggested: string, reason: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.mojibakeSuggested = suggested;
    tab.mojibakeReason = reason;
    this.emitStructure();
  }

  /** 会话恢复的占位标签：仅登记路径，首次激活时才载入内容 */
  openPending(path: string, name: string): Tab {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) return existing;
    const tab: Tab = {
      id: `tab-${++seq}`,
      path,
      name,
      kind: "text",
      content: "",
      savedFingerprint: EMPTY_FINGERPRINT,
      savedTrailingNewline: false,
      size: 0,
      dirty: false,
      encoding: "",
      savedEncoding: "",
      encodingConfidence: "",
      encodingCandidates: [],
      newline: "",
      savedNewline: "",
      has_bom: false,
      readonly: false,
      readonlyReason: "",
      pending: true,
    };
    this.tabs.push(tab);
    this.emitStructure();
    return tab;
  }

  /** 占位标签内容载入完成 */
  fillPending(id: string, content: FileContent): Tab | null {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return null;
    this.applyContent(tab, content);
    this.emitStructure();
    return tab;
  }

  /** 应用草稿内容：作为未保存修改（基线仍取磁盘内容，故标脏） */
  applyDraft(id: string, content: string): Tab | null {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return null;
    tab.content = content;
    tab.contentDirty = false;
    tab.pending = false;
    // 基线仍是磁盘内容：草稿一律视为未保存修改
    tab.dirty = true;
    this.emitStructure();
    return tab;
  }

  /** 打开图片（只读查看器） */
  openImage(path: string, name: string, size: number, dataUrl: string): Tab {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      this.syncContent(this.activeId);
      this.activeId = existing.id;
      this.emitStructure();
      return existing;
    }
    const tab: Tab = {
      id: `tab-${++seq}`,
      path,
      name,
      kind: "image",
      dataUrl,
      content: "",
      savedFingerprint: EMPTY_FINGERPRINT,
      savedTrailingNewline: false,
      size,
      dirty: false,
      encoding: "binary",
      savedEncoding: "binary",
      encodingConfidence: "",
      encodingCandidates: [],
      newline: "NONE",
      savedNewline: "NONE",
      has_bom: false,
      readonly: true,
      readonlyReason: "图片查看器",
    };
    this.tabs.push(tab);
    // 切换激活项前先落回旧标签内容，否则之后保存/草稿会读到旧值
    this.syncContent(this.activeId);
    this.activeId = tab.id;
    this.emitStructure();
    return tab;
  }

  activate(id: string): void {
    if (this.activeId !== id) {
      this.syncContent(this.activeId);
      this.activeId = id;
      this.emitStructure();
    }
  }

  close(id: string): Tab | null {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const [closed] = this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)] ?? null;
      this.activeId = next?.id ?? null;
    }
    // 先清理（缓存/光标/草稿/大文件会话），再触发订阅者加载新标签
    this.notifyClosed(closed);
    this.emitStructure();
    return closed;
  }

  /** 批量关闭（脏标签一次性确认，避免逐个弹窗） */
  private async closeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const dirtyCount = this.tabs.filter((t) => ids.includes(t.id) && t.dirty).length;
    if (dirtyCount > 0) {
      // 未注入确认回调时直接关闭（启动早期不会触发批量关闭）
      const ok = this.confirmHandler
        ? await this.confirmHandler(`有 ${dirtyCount} 个未保存的标签将被关闭，确定？`)
        : true;
      if (!ok) return;
    }
    for (const id of ids) this.close(id);
  }

  /** 关闭左侧全部（保留自己） */
  closeLeft(id: string): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx <= 0) return Promise.resolve();
    return this.closeMany(this.tabs.slice(0, idx).map((t) => t.id));
  }

  /** 关闭右侧全部（保留自己） */
  closeRight(id: string): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0 || idx === this.tabs.length - 1) return Promise.resolve();
    return this.closeMany(this.tabs.slice(idx + 1).map((t) => t.id));
  }

  /** 关闭其他（只保留自己） */
  closeOthers(id: string): Promise<void> {
    return this.closeMany(this.tabs.filter((t) => t.id !== id).map((t) => t.id));
  }

  /** 关闭全部 */
  closeAll(): Promise<void> {
    return this.closeMany(this.tabs.map((t) => t.id));
  }

  /**
   * 编辑器内容已变：只标记，不取全文（按键路径 O(1)）。
   * content 的同步移到读取时（snapshotOf）与停手后的精算（内部排程）。
   */
  markEdited(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.contentDirty = true;
    tab.dirty = true;
    this.emitContent();
    this.scheduleSettle(id);
  }

  /** 排程一次停手精算：窗口内无新输入才取全文比较 */
  private scheduleSettle(id: string): void {
    const prev = this.settleTimers.get(id);
    if (prev !== undefined) clearTimeout(prev);
    this.settleTimers.set(
      id,
      setTimeout(() => {
        this.settleTimers.delete(id);
        this.settleContent(id);
      }, CONTENT_SETTLE_MS),
    );
  }

  /** 取消该标签的停手精算 */
  private clearSettle(id: string): void {
    const timer = this.settleTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.settleTimers.delete(id);
  }

  /** 外部替换内容（差异块采用 / 转换结果等）：写入并标记为未保存修改 */
  applyEdit(id: string, content: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.content = content;
    tab.contentDirty = false;
    tab.dirty = true;
    this.emitStructure();
  }

  /** 还原为磁盘内容：内容成为新基线，元数据差异（编码/换行）仍保留脏标记 */
  restoreContent(id: string, content: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.content = content;
    tab.contentDirty = false;
    tab.savedFingerprint = fingerprint(content);
    tab.savedTrailingNewline = content.endsWith("\n");
    this.refreshDirty(tab);
    this.emitStructure();
  }

  /** 读取标签最新内容：激活标签会先同步编辑器内容（惰性快照，O(n) 且会更新脏标记） */
  snapshotOf(tab: Tab): string {
    this.syncContent(tab.id);
    return tab.content;
  }

  /** 读取内容头部（不触发全文 toString）：供按前缀判断的场景 */
  contentHeadOf(tab: Tab, chars: number): string {
    const p = this.provider;
    if (tab.contentDirty && p && p.docId() === tab.id) return p.head(chars);
    return tab.content.length > chars ? tab.content.slice(0, chars) : tab.content;
  }

  /** 停手后的精确精算：撤销回原状时清掉脏点（由 scheduleSettle 排程） */
  private settleContent(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || !tab.contentDirty || !this.provider || this.provider.docId() !== id) return;
    const before = tab.dirty;
    this.syncContent(id);
    if (tab.dirty !== before) this.emitStructure();
  }

  /** 内部：把编辑器内容落回标签（仅对当前激活文档有效） */
  private syncContent(id: string | null): void {
    if (id === null) return;
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || !tab.contentDirty) return;
    const p = this.provider;
    // 非激活标签：内容已在切走时落回，不做全文快照
    if (!p || p.docId() !== id) return;
    tab.content = p.full();
    tab.contentDirty = false;
    this.refreshDirty(tab);
  }

  /** 依据内容指纹与元数据基线重算脏标记（撤销回基线即变干净） */
  private refreshDirty(tab: Tab): void {
    const sameContent =
      tab.content.length === tab.savedFingerprint.len &&
      this.matchesFingerprint(tab.content, tab.savedFingerprint);
    tab.dirty =
      !sameContent ||
      tab.encoding !== tab.savedEncoding ||
      tab.newline !== tab.savedNewline;
  }

  private matchesFingerprint(text: string, fp: ContentFingerprint): boolean {
    if (text.length !== fp.len) return false;
    const cur = fingerprint(text);
    return cur.a === fp.a && cur.b === fp.b;
  }

  /**
   * 保存成功：以「实际写进磁盘的文本」作为新基线。
   * 不能先 syncContent 再取基线——保存期间的输入尚未落盘，
   * 若一并记成基线，闭标签/退出时的脏检查会认为它们已保存（静默丢字）。
   * meta 为写盘时使用的编码 / 换行符（保存窗口内用户可能又改过内存态）。
   */
  markSaved(
    id: string,
    written: string,
    meta?: { encoding?: string; newline?: string },
  ): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.savedFingerprint = fingerprint(written);
    tab.savedTrailingNewline = written.endsWith("\n");
    tab.savedEncoding = meta?.encoding ?? tab.encoding;
    tab.savedNewline = meta?.newline ?? tab.newline;
    // 保存窗口内的新输入落回标签内容，再按基线重算脏标记
    this.syncContent(id);
    this.refreshDirty(tab);
    this.emitStructure();
  }

  /** 更新换行符（状态栏切换用）：属内容修改，标脏后由用户手动保存 */
  setNewline(id: string, newline: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab && tab.newline !== newline) {
      // 脏标记要基于最新内容，先落回编辑器内容
      this.syncContent(id);
      tab.newline = newline;
      this.refreshDirty(tab);
      this.emitStructure();
    }
  }

  /** 「重新打开为」：按新编码重载内容（不写盘）；编码变化时标脏，待用户手动保存转码 */
  reopenWith(id: string, content: FileContent): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.content = content.content;
    tab.contentDirty = false;
    tab.savedFingerprint = fingerprint(content.content); // 磁盘内容成为内容基线
    tab.savedTrailingNewline = content.content.endsWith("\n");
    tab.size = content.size;
    tab.encoding = content.encoding;
    tab.encodingConfidence = content.encoding_confidence;
    tab.encodingCandidates = content.encoding_candidates;
    tab.newline = content.newline;
    tab.savedNewline = content.newline;
    tab.has_bom = content.has_bom;
    tab.readonly = content.readonly;
    tab.readonlyReason = content.readonly_reason;
    // savedEncoding 保持不变：与磁盘编码是否一致由 refreshDirty 判定
    this.refreshDirty(tab);
    this.emitStructure();
  }

  /** 保存成功后刷新路径（另存为） */
  setPath(id: string, path: string, name: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) {
      tab.path = path;
      tab.name = name;
      this.emitStructure();
    }
  }

  findById(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id) ?? null;
  }

  findByPath(path: string): Tab | null {
    return this.tabs.find((t) => t.path === path) ?? null;
  }
}

export const tabStore = new TabStore();
