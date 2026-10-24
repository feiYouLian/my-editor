/**
 * 标签切换状态机：激活标签变化时，把编辑器 / 预览 / 文件树 /
 * 大文件视图 / 结果面板同步到目标标签。
 *
 * 本模块是「全局单例 view + await 后无校验」这一高危模式的收口处，
 * 两条不变式在这里强制执行：
 * 1. 代际令牌 loadToken：每个 await 之后校验，过期加载立即中止，
 *    杜绝把光标/文件树高亮/大文件视图打到已经不是当前标签的目标上；
 * 2. beginSwitch/endSwitch 抑制窗口包裹全程，且仅最新一代负责解除，
 *    防止上一个文档的内容/光标在异步窗口内写入新标签。
 */

import { invoke } from "@tauri-apps/api/core";
import { getConfig } from "../config/settings";
import { tabStore, type Tab } from "../store/tabs";
import type { EditorHandle } from "../editor/setup";
import type { LargeFileHost } from "./largeFileHost";
import type { LargeFileInfo } from "../panels/largeView";

export interface TabSwitcherDeps {
  getActiveTab: () => Tab | null;
  getEditor: () => EditorHandle;
  largeHost: LargeFileHost;
  preview: { refresh(): void };
  fileTree: { revealPath(path: string): void };
  sessionHost: { applyRestoredCursor(tab: Tab | null): void };
  /** 结果面板按需创建，可能为 null */
  getResultsPanel: () => { refresh(): void } | null;
}

export class TabSwitcher {
  /** 当前已载入的标签 id（供订阅判断激活项是否真的变化） */
  private currentLoadedTabId: string | null = null;
  /** 标签切换代际令牌 */
  private loadToken = 0;

  constructor(private deps: TabSwitcherDeps) {
    document.getElementById("nav-prev")?.addEventListener("click", () => this.switchTab(-1));
    document.getElementById("nav-next")?.addEventListener("click", () => this.switchTab(1));
  }

  get currentId(): string | null {
    return this.currentLoadedTabId;
  }

  async load(): Promise<void> {
    const token = ++this.loadToken;
    const tab = this.deps.getActiveTab();
    this.currentLoadedTabId = tab?.id ?? null;
    // 切换窗口开始：抑制编辑器回调，防止上一个文档的内容/光标写入新标签
    this.deps.getEditor().beginSwitch();
    try {
      // 虚拟视图不可用时回退编辑器路径：用有限次重试代替递归自调用
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!tab) {
          // 无标签：清空编辑器、预览与结果面板，回到默认空态
          await this.deps.getEditor().loadDocument("", "");
          if (token !== this.loadToken) return;
          this.deps.largeHost.setEditorVirtual(false);
          this.deps.largeHost.close();
          this.deps.preview.refresh();
          this.deps.getResultsPanel()?.refresh();
          return;
        }
        if (tab.pending && tab.path) {
          // 会话恢复的占位标签：首次激活时才载入内容
          if (!(await this.deps.largeHost.loadPendingTab(tab))) return;
          if (token !== this.loadToken) return;
        }
        if (tab.virtual && tab.largeId) {
          // 大文件只读虚拟视图：隐藏编辑器与预览，行内容按窗口拉取
          this.deps.largeHost.setEditorVirtual(true);
          try {
            const info = await invoke<LargeFileInfo>("large_file_info", { id: tab.largeId });
            await this.deps.largeHost.open(info, getConfig().largeFile.viewportPaddingLines);
            return;
          } catch {
            // 会话已释放（例如应用重建）：退回编辑器路径（仅重试一次）
            tab.virtual = false;
            tab.largeId = undefined;
            this.deps.largeHost.setEditorVirtual(false);
            continue;
          }
        }
        this.deps.largeHost.setEditorVirtual(false);
        this.deps.largeHost.close();
        await this.deps.getEditor().loadDocument(
          tab.path ?? "",
          tabStore.snapshotOf(tab),
          tab.readonly,
          tab.languageOverride,
          tab.id,
        );
        if (token !== this.loadToken) return;
        this.deps.sessionHost.applyRestoredCursor(tab);
        // 文件树联动：展开祖先目录并高亮当前文件
        if (tab.path) this.deps.fileTree.revealPath(tab.path);
        // 预览联动：按标签类型应用 编辑/预览/双栏 或图片查看器
        this.deps.preview.refresh();
        this.deps.getResultsPanel()?.refresh();
        return;
      }
    } finally {
      // 仅最新一代切换负责解除抑制，过期的 finally 不得提前释放
      if (token === this.loadToken) this.deps.getEditor().endSwitch();
    }
  }

  /** 标签页导航（上一个/下一个） */
  switchTab(delta: number): void {
    const tabs = tabStore.list();
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.id === tabStore.active()?.id);
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    if (next) tabStore.activate(next.id);
  }
}
