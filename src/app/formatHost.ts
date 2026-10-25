/**
 * 格式化编排：文档级 / 选中级 / 保存前自动格式化。
 *
 * 双通道（Prettier 前端 + CLI 后端）的实现在 editor/format.ts；
 * 本模块只管状态机（防重入、大文件确认）与提示，从 main.ts 迁出。
 */

import type { EditorView } from "@codemirror/view";
import { getConfig } from "../config/settings";
import { tabStore, type Tab } from "../store/tabs";
import { effectiveLanguage } from "../editor/languages";
import { formatDocument, formatSelection, supportsFormatting } from "../editor/format";
import { confirmAction } from "../ui/dialogs";

/** 超过此行数，格式化前弹确认（保存时自动格式化也用它做上限） */
export const FORMAT_CONFIRM_LINES = 10000;

export interface FormatHostDeps {
  getActiveTab: () => Tab | null;
  getView: () => EditorView;
  /** 当前编辑器承载的文档 id（保存前格式化只处理激活标签） */
  getDocId: () => string | null;
  blockIfReadonly: () => boolean;
  showMessage: (text: string, durationMs?: number) => void;
  refreshStatus: () => void;
}

export class FormatHost {
  /** 格式化进行中标志：防止连按快捷键启动两个格式化器互相覆盖 */
  private formatting = false;

  constructor(private deps: FormatHostDeps) {}

  /** 文档级格式化（菜单 / 快捷键 / 命令面板） */
  async formatCurrent(): Promise<void> {
    const tab = this.deps.getActiveTab();
    if (!tab) return;
    if (this.deps.blockIfReadonly()) return;
    if (this.formatting) {
      this.deps.showMessage("正在格式化，请稍候…");
      return;
    }
    const key = effectiveLanguage(tab);
    const view = this.deps.getView();
    if (view.state.doc.lines > FORMAT_CONFIRM_LINES) {
      const ok = await confirmAction(
        `文档超过 ${FORMAT_CONFIRM_LINES} 行，格式化可能耗时较久，继续？`,
      );
      if (!ok) return;
    }
    this.formatting = true;
    try {
      const result = await formatDocument(view, key, tab.path);
      // await 期间可能切换了标签：结果已由 format.ts 做文档指纹校验，
      // 这里仅跳过过期标签上的消息刷新
      if (tabStore.active()?.id !== tab.id) return;
      if (!result.ok) {
        // 不走 window.alert（依赖 dialog 权限且打断流程）：状态栏显示首行
        // （首行已含安装命令，见 format.ts 的 withInstallHint）+ 控制台完整输出；
        // 错误停留 8s，留出阅读与照做的时间
        this.deps.showMessage(result.message.split("\n")[0] || "格式化失败", 8000);
        console.error("[format]", result.message);
        return;
      }
      this.deps.showMessage(result.message);
      this.deps.refreshStatus();
    } finally {
      this.formatting = false;
    }
  }

  /** 选中内容格式化（未选中时提示，由 format.ts 返回） */
  async formatSelectionCurrent(): Promise<void> {
    const tab = this.deps.getActiveTab();
    if (!tab) return;
    if (this.deps.blockIfReadonly()) return;
    if (this.formatting) {
      this.deps.showMessage("正在格式化，请稍候…");
      return;
    }
    const key = effectiveLanguage(tab);
    this.formatting = true;
    try {
      const result = await formatSelection(this.deps.getView(), key, tab.path);
      if (tabStore.active()?.id !== tab.id) return;
      if (!result.ok) {
        this.deps.showMessage(result.message.split("\n")[0] || "格式化失败", 8000);
        console.error("[format]", result.message);
        return;
      }
      this.deps.showMessage(result.message);
      this.deps.refreshStatus();
    } finally {
      this.formatting = false;
    }
  }

  /**
   * 保存前自动格式化（FileService 的 formatBeforeSave 钩子）。
   * 单编辑器实例：只处理激活标签；失败只提示，不阻塞保存。
   */
  async beforeSave(tab: Tab): Promise<"applied" | "skipped" | "failed"> {
    if (!getConfig().formatOnSave) return "skipped";
    if (tab.id !== this.deps.getDocId()) return "skipped";
    const view = this.deps.getView();
    if (view.state.doc.lines > FORMAT_CONFIRM_LINES) {
      this.deps.showMessage(`文档超过 ${FORMAT_CONFIRM_LINES} 行，已跳过保存时格式化`);
      return "skipped";
    }
    const lang = effectiveLanguage(tab);
    if (!supportsFormatting(lang)) return "skipped";
    const result = await formatDocument(view, lang, tab.path);
    if (!result.ok) {
      this.deps.showMessage(
        `${result.message.split("\n")[0] || "保存时格式化失败"}（已按原内容保存）`,
        8000,
      );
      console.error("[format] on save:", result.message);
      return "failed";
    }
    return result.changed ? "applied" : "skipped";
  }
}
