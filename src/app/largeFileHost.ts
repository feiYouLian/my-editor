/**
 * 大文件只读虚拟视图宿主：分流判定、占位标签载入、会话释放、
 * 「逃生门」改用编辑器打开、虚拟文件打开。
 *
 * 渲染在 panels/largeView.ts；本模块管「标签 ↔ 虚拟视图 ↔ 编辑器」
 * 的编排。编辑器列的显隐（virtual class）也收在这里——
 * 它与虚拟视图状态严格绑定。
 */

import { invoke } from "@tauri-apps/api/core";
import { getConfig, settings } from "../config/settings";
import { tabStore, type Tab } from "../store/tabs";
import { LargeView, type LargeFileInfo } from "../panels/largeView";
import { confirmAction } from "../ui/dialogs";
import type { FileContent } from "../types/app";

export interface LargeFileHostDeps {
  showMessage: (text: string) => void;
  /** 打开文件后的乱码复检（main.ts 领域逻辑） */
  onCheckMojibake: (tabId: string) => void;
  /** 虚拟标签转换后重载当前标签（main.ts 的标签切换状态机） */
  onReloadActiveTab: () => Promise<void>;
}

export class LargeFileHost {
  /** 延迟构造：工作区恢复可能早于本模块初始化完成，避免取不到 DOM */
  private instance: LargeView | null = null;

  constructor(private deps: LargeFileHostDeps) {}

  private view(): LargeView {
    if (!this.instance) {
      this.instance = new LargeView(document.getElementById("large-view")!, {
        onMessage: this.deps.showMessage,
        onOpenInEditor: (info) => void this.openInEditor(info),
      });
    }
    return this.instance;
  }

  /** 编辑器列显隐（虚拟视图激活时隐藏编辑器） */
  setEditorVirtual(on: boolean): void {
    document.querySelector<HTMLElement>(".editor-column")?.classList.toggle("virtual", on);
  }

  close(): void {
    this.instance?.close();
  }

  async open(info: LargeFileInfo, paddingLines: number): Promise<void> {
    await this.view().open(info, paddingLines);
  }

  /** 是否走只读虚拟视图：体积超阈值，或扩展名命中日志列表 */
  needVirtualView(size: number, extension: string): boolean {
    if (size >= settings.largeFileThreshold) return true;
    return extension !== "" && getConfig().largeFile.logExtensions.includes(extension);
  }

  /**
   * 打开虚拟视图（探测已命中的调用方使用）。
   * 失败返回 null，由调用方回退编辑器路径（如 UTF-16 不支持）。
   */
  async openVirtualFile(path: string): Promise<LargeFileInfo | null> {
    try {
      const info = await invoke<LargeFileInfo>("open_large_file", {
        path,
        anchorBytes: getConfig().largeFile.sparseIndexAnchorBytes,
      });
      tabStore.openVirtual(info);
      return info;
    } catch (e) {
      // 虚拟视图不可用（如 UTF-16）时回退编辑器路径
      console.warn("[large] 回退编辑器打开:", e);
      return null;
    }
  }

  /** 占位标签首次激活：按分流规则载入内容；返回 false 表示已改走其它路径 */
  async loadPendingTab(tab: Tab): Promise<boolean> {
    const path = tab.path;
    if (!path) return false;
    try {
      const probe = await invoke<{ size: number; extension: string }>("probe_file", { path });
      if (this.needVirtualView(probe.size, probe.extension)) {
        const info = await invoke<LargeFileInfo>("open_large_file", {
          path,
          anchorBytes: getConfig().largeFile.sparseIndexAnchorBytes,
        });
        tabStore.close(tab.id);
        tabStore.openVirtual(info);
        return false;
      }
      const data = await invoke<FileContent>("open_text_file", {
        path,
        largeFileThreshold: settings.largeFileThreshold,
        logExtensions: getConfig().largeFile.logExtensions,
      });
      tabStore.fillPending(tab.id, data);
      this.deps.onCheckMojibake(tab.id);
      return true;
    } catch (e) {
      tabStore.close(tab.id);
      this.deps.showMessage(`载入失败：${String(e).split("\n")[0]}`);
      return false;
    }
  }

  /** 释放大文件会话（标签关闭时调用） */
  async release(tab: Tab): Promise<void> {
    if (!tab.largeId) return;
    await this.instance?.cancel();
    try {
      await invoke("close_large_file", { id: tab.largeId });
    } catch {
      // 会话已释放
    }
  }

  /** 逃生门：改用编辑器打开（超阈值时二次确认） */
  async openInEditor(info: LargeFileInfo): Promise<void> {
    const tab = tabStore.findByPath(info.path);
    if (!tab) return;
    if (info.size >= settings.largeFileThreshold) {
      const mb = Math.round(info.size / 1024 / 1024);
      const ok = await confirmAction(
        `文件约 ${mb} MB，以编辑器打开会全量载入内存，可能影响性能。确定继续吗？`,
      );
      if (!ok) return;
    }
    try {
      await invoke("close_large_file", { id: info.id });
      const data = await invoke<FileContent>("open_text_file", {
        path: info.path,
        largeFileThreshold: settings.largeFileThreshold,
        logExtensions: getConfig().largeFile.logExtensions,
      });
      tabStore.convertVirtual(tab.id, data);
      await this.deps.onReloadActiveTab();
      this.deps.showMessage(
        data.readonly ? `${data.readonly_reason}，已以只读方式打开` : "已在编辑器中打开",
      );
    } catch (e) {
      this.deps.showMessage(`打开失败：${String(e).split("\n")[0]}`);
    }
  }
}
