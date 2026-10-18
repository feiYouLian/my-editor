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
  size: number;
  dirty: boolean;
  encoding: string;
  newline: string;
  has_bom: boolean;
  /** 只读：大文件 / 日志文件命中只读守卫，编辑器禁用编辑入口 */
  readonly: boolean;
  /** 只读原因（非只读时为空串） */
  readonlyReason: string;
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
      size: content.size,
      dirty: false,
      encoding: content.encoding,
      newline: content.newline,
      has_bom: content.has_bom,
      readonly: content.readonly,
      readonlyReason: content.readonly_reason,
    };
    this.tabs.push(tab);
    this.activeId = tab.id;
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
      size,
      dirty: false,
      encoding: "binary",
      newline: "NONE",
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
      tab.dirty = true;
      this.emit();
    }
  }

  markSaved(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) {
      tab.dirty = false;
      this.emit();
    }
  }

  /** 更新换行符（状态栏切换用） */
  setNewline(id: string, newline: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) {
      tab.newline = newline;
      this.emit();
    }
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
