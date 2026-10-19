import type { FileContent } from "../types/app";
import { confirmAction } from "../ui/dialogs";

/**
 * 多标签页状态。
 * 单 CM6 实例 + 按标签缓存内容：切换时交换文档，
 * 代价是各标签的撤销历史不保留。
 */

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  /** text：进入编辑器；image：进入图片查看器 */
  kind: "text" | "image";
  /** 图片 tab 的 data URL（kind=image 时有效） */
  dataUrl?: string;
  content: string;
  /** 最近一次打开/保存时的内容基线：用于判断是否真的与磁盘一致（撤销回原状即变干净） */
  savedContent: string;
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
}

let seq = 0;

class TabStore {
  private tabs: Tab[] = [];
  private activeId: string | null = null;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  list(): Tab[] {
    return this.tabs;
  }

  active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  /** 打开文本文件：已打开则激活，否则新开标签 */
  open(content: FileContent): Tab {
    const existing = this.tabs.find((t) => t.path === content.path);
    if (existing) {
      this.activeId = existing.id;
      this.emit();
      return existing;
    }
    const tab: Tab = {
      id: `tab-${++seq}`,
      path: content.path,
      name: content.name,
      kind: "text",
      content: content.content,
      savedContent: content.content,
      size: content.size,
      dirty: false,
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
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.emit();
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
        this.emit();
        return existing;
      }
      const idx = this.tabs.indexOf(existing);
      if (idx >= 0) this.tabs.splice(idx, 1);
    }
    const tab: Tab = {
      id: `tab-${++seq}`,
      path: info.path,
      name: info.name,
      kind: "text",
      content: "",
      savedContent: "",
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
    this.activeId = tab.id;
    this.emit();
    return tab;
  }

  /** 用已载入内容填充标签（占位标签载入 / 虚拟标签转编辑器共用） */
  private applyContent(tab: Tab, content: FileContent): void {
    tab.content = content.content;
    tab.savedContent = content.content;
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
    this.emit();
    return tab;
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
      savedContent: "",
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
    this.emit();
    return tab;
  }

  /** 占位标签内容载入完成 */
  fillPending(id: string, content: FileContent): Tab | null {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return null;
    this.applyContent(tab, content);
    this.emit();
    return tab;
  }

  /** 打开图片（只读查看器） */
  openImage(path: string, name: string, size: number, dataUrl: string): Tab {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      this.activeId = existing.id;
      this.emit();
      return existing;
    }
    const tab: Tab = {
      id: `tab-${++seq}`,
      path,
      name,
      kind: "image",
      dataUrl,
      content: "",
      savedContent: "",
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
    this.activeId = tab.id;
    this.emit();
    return tab;
  }

  activate(id: string): void {
    if (this.activeId !== id) {
      this.activeId = id;
      this.emit();
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
    this.emit();
    return closed;
  }

  /** 批量关闭（脏标签一次性确认，避免逐个弹窗） */
  private async closeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const dirtyCount = this.tabs.filter((t) => ids.includes(t.id) && t.dirty).length;
    if (dirtyCount > 0) {
      const ok = await confirmAction(`有 ${dirtyCount} 个未保存的标签将被关闭，确定？`);
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

  /** 更新标签内容（编辑器输入时调用） */
  setContent(id: string, content: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) {
      tab.content = content;
      this.refreshDirty(tab);
      this.emit();
    }
  }

  /** 依据内容基线与元数据基线重算脏标记（撤销回基线即变干净） */
  private refreshDirty(tab: Tab): void {
    tab.dirty =
      tab.content !== tab.savedContent ||
      tab.encoding !== tab.savedEncoding ||
      tab.newline !== tab.savedNewline;
  }

  markSaved(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) {
      tab.savedContent = tab.content;
      tab.savedEncoding = tab.encoding;
      tab.savedNewline = tab.newline;
      tab.dirty = false;
      this.emit();
    }
  }

  /** 更新换行符（状态栏切换用）：属内容修改，标脏后由用户手动保存 */
  setNewline(id: string, newline: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab && tab.newline !== newline) {
      tab.newline = newline;
      this.refreshDirty(tab);
      this.emit();
    }
  }

  /** 「重新打开为」：按新编码重载内容（不写盘）；编码变化时标脏，待用户手动保存转码 */
  reopenWith(id: string, content: FileContent): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.content = content.content;
    tab.savedContent = content.content; // 磁盘内容成为内容基线
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
    this.emit();
  }

  /** 保存成功后刷新路径（另存为） */
  setPath(id: string, path: string, name: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) {
      tab.path = path;
      tab.name = name;
      this.emit();
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
