/**
 * 格式化编排：文档级 / 选中级 / 保存前自动格式化。
 *
 * 双通道（Prettier 前端 + CLI 后端）的实现在 editor/format.ts；
 * 本模块只管状态机（防重入、大文件确认）与提示。
 */

import type { EditorView } from "@codemirror/view";
import { getConfig } from "../config/settings";
import { tabStore, type Tab } from "../store/tabs";
import { effectiveLanguage } from "../editor/languages";
import { formatDocument, formatSelection, supportsFormatting, type FormatResult } from "../editor/format";
import { confirmAction, showErrorDialog } from "../ui/dialogs";
import { addNotice } from "../store/noticeStore";
import { firstLine } from "../core/errors";

/** 超过此行数，格式化前弹确认（保存时自动格式化也用它做上限） */
export const FORMAT_CONFIRM_LINES = 10000;

/**
 * 格式化失败：状态栏说明 + 可复制详情的对话框 + 通知中心留底。
 * 缺工具 / 未配置时，在通知动作里给直达格式化配置的入口。
 */
function reportFormatFailure(
  tab: Tab,
  result: FormatResult,
  deps: { showMessage: (text: string, durationMs?: number) => void; openFormattersConfig: () => void },
): void {
  // 失败详情常是"首行安装提示 + 后几行真实报错"，状态栏装不下也复制不了：
  // 一律进可复制的错误对话框（与 Git 失败同一套行为）
  // 状态栏消息没有点击回调：这里只说明结果，详情由紧接的错误对话框与通知中心承接，
  // 不要写「点击查看详情」这种做不到的承诺。
  deps.showMessage("格式化失败，详情见弹窗");
  showErrorDialog("格式化失败", result.message);
  const actions = [
    { label: "查看详情", run: () => showErrorDialog("格式化失败", result.message) },
  ];
  const failure = result.failure;
  if (failure && (failure.code === "missing_tool" || failure.code === "not_configured")) {
    actions.unshift({ label: "打开格式化配置", run: () => deps.openFormattersConfig() });
  }
  addNotice("formatFail", `格式化失败：「${tab.name}」`, actions, `fmt:${tab.id}`);
}

export interface FormatHostDeps {
  getActiveTab: () => Tab | null;
  getView: () => EditorView;
  /** 当前编辑器承载的文档 id（保存前格式化只处理激活标签） */
  getDocId: () => string | null;
  blockIfReadonly: () => boolean;
  showMessage: (text: string, durationMs?: number) => void;
  refreshStatus: () => void;
  /** 打开 config.json（formatters 表所在文件）：格式化器缺失时的可行动入口 */
  openFormattersConfig: () => void;
}

export class FormatHost {
  /** 格式化进行中标志：防止连按快捷键启动两个格式化器互相覆盖 */
  private formatting = false;

  constructor(private deps: FormatHostDeps) {}

  /** 文档级格式化（菜单 / 快捷键 / 命令面板） */
  async formatCurrent(): Promise<void> {
    await this.run("document");
  }

  /** 选中内容格式化（未选中时提示，由 format.ts 返回） */
  async formatSelectionCurrent(): Promise<void> {
    await this.run("selection");
  }

  /**
   * 两种格式化的公共流程：前置守卫 →（文档级）大文件确认 → 执行 → 结果反馈。
   * view 在确认框之前取：确认期间切标签也不会把结果写到新标签的视图上。
   * `formatting` 在确认之后置位，确认框挂起期间不拦截第二次快捷键。
   */
  private async run(mode: "document" | "selection"): Promise<void> {
    const tab = this.deps.getActiveTab();
    if (!tab) return;
    if (this.deps.blockIfReadonly()) return;
    if (this.formatting) {
      this.deps.showMessage("正在格式化，请稍候…");
      return;
    }
    const key = effectiveLanguage(tab);
    const view = this.deps.getView();
    if (mode === "document" && view.state.doc.lines > FORMAT_CONFIRM_LINES) {
      const ok = await confirmAction(
        `文档超过 ${FORMAT_CONFIRM_LINES} 行，格式化可能耗时较久，继续？`,
      );
      if (!ok) return;
    }
    this.formatting = true;
    try {
      const result =
        mode === "document"
          ? await formatDocument(view, key, tab.path)
          : await formatSelection(view, key, tab.path);
      // await 期间可能切换了标签：结果已由 format.ts 做文档指纹校验，
      // 这里仅跳过过期标签上的消息刷新
      if (tabStore.active()?.id !== tab.id) return;
      if (!result.ok) {
        reportFormatFailure(tab, result, this.deps);
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
        `${firstLine(result.message) || "保存时格式化失败"}（已按原内容保存）`,
        8000,
      );
      console.error("[format] on save:", result.message);
      return "failed";
    }
    return result.changed ? "applied" : "skipped";
  }
}
