/**
 * 状态栏三个弹出菜单的领域动作（换行符 / 语言 / 编码）与乱码检测。
 *
 * 从 main.ts 迁出：这些动作依赖标签、编辑器语言切换、磁盘重读与消息通道，
 * 但都不属于"装配"。跨模块能力（重载标签、另存编码、读盘）经 Deps 注入，
 * 避免 app 模块之间互相 import。
 */

import { invoke } from "@tauri-apps/api/core";
import { tabStore, type Tab } from "../store/tabs";
import { openStatusMenu } from "../ui/statusMenu";
import { confirmAction } from "../ui/dialogs";
import {
  languageDisplayNames,
  languageKeyFromPath,
  languageLabel,
} from "../editor/languages";
import type { FileContent } from "../types/app";

const NEWLINE_OPTIONS: { value: string; label: string }[] = [
  { value: "LF", label: "LF（Unix / macOS）" },
  { value: "CRLF", label: "CRLF（Windows）" },
  { value: "CR", label: "CR（老式 Mac）" },
];

/** 自动乱码检测的文件体积上限（更大文件跳过，避免重复读盘） */
const MOJIBAKE_MAX_BYTES = 5 * 1024 * 1024;

interface MojibakeReport {
  suspicious: boolean;
  suggested: string;
  severity: number;
  reason: string;
}

export interface StatusActionsDeps {
  getActiveTab: () => Tab | null;
  showMessage: (text: string, durationMs?: number) => void;
  refreshStatus: () => void;
  /** 重载当前标签（标签切换状态机） */
  reloadActiveTab: () => Promise<void>;
  /** 应用高亮语言（仅当前激活标签；调用方负责判断） */
  setEditorLanguage: (override: string | null | undefined) => Promise<void>;
  /** 「另存为编码」对话框 */
  saveAsWithEncoding: () => void;
  /** 按指定编码重读磁盘（不写盘） */
  readDiskAs: (path: string, encoding: string) => Promise<FileContent>;
  /** 状态栏编码菜单的回退候选 */
  fallbackEncodings: string[];
  /** 记住本次手动选择的编码（下次打开同一文件优先采用） */
  rememberEncoding?: (path: string, encoding: string) => void;
}

export class StatusActions {
  constructor(private deps: StatusActionsDeps) {}

  /** 绑定状态栏三个字段的点击行为（标题 / 手型 / 弹出菜单） */
  bind(elements: {
    newline: HTMLElement;
    language: HTMLElement;
    encoding: HTMLElement;
  }): void {
    elements.newline.title = "点击切换换行符（LF / CRLF / CR）";
    elements.newline.style.cursor = "pointer";
    elements.newline.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showNewlineMenu(e.clientX, e.clientY);
    });

    elements.language.title = "点击切换高亮语言";
    elements.language.style.cursor = "pointer";
    elements.language.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showLanguageMenu(e.clientX, e.clientY);
    });

    elements.encoding.style.cursor = "pointer";
    elements.encoding.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showEncodingMenu(e.clientX, e.clientY);
    });
  }

  // ---- 换行符 ----

  private showNewlineMenu(x: number, y: number): void {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text" || !tab.path) {
      this.deps.showMessage("当前文件不支持切换换行符");
      return;
    }
    openStatusMenu({
      anchor: { x, y },
      header: `当前换行符：${tab.newline}`,
      options: NEWLINE_OPTIONS,
      current: tab.newline,
      tabId: tab.id,
      onMessage: this.deps.showMessage,
      onPick: (value) => this.applyNewline(tab.id, value),
    });
  }

  /** 应用换行符：仅改内存状态并标脏，由用户手动保存落盘 */
  private applyNewline(tabId: string, newline: string): void {
    tabStore.setNewline(tabId, newline);
    this.deps.refreshStatus();
    this.deps.showMessage(`换行符已切换为 ${newline}（未保存，Ctrl+S 保存）`);
  }

  // ---- 语言模式 ----

  private showLanguageMenu(x: number, y: number): void {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text") {
      this.deps.showMessage("当前文件不支持切换语言");
      return;
    }
    if (tab.virtual) {
      this.deps.showMessage("大文件只读视图不支持切换语言");
      return;
    }
    // 自动项 + 纯文本 + 全部已注册语言
    const auto = tab.path ? languageKeyFromPath(tab.path) : null;
    openStatusMenu({
      anchor: { x, y },
      header: `当前语言：${languageLabel(tab)}`,
      options: [
        {
          value: undefined,
          label: `自动（${auto ? (languageDisplayNames[auto] ?? auto) : "纯文本"}）`,
        },
        { value: null, label: "纯文本" },
        ...Object.keys(languageDisplayNames)
          .filter((key) => key !== "plaintext")
          .map((key) => ({ value: key as string | null, label: languageDisplayNames[key] })),
      ],
      current: tab.languageOverride,
      tabId: tab.id,
      onMessage: this.deps.showMessage,
      onPick: (value) => void this.applyLanguageOverride(tab.id, value),
    });
  }

  /** 应用语言模式：更新标签状态 + 编辑器高亮（不重载内容） */
  private async applyLanguageOverride(
    tabId: string,
    override: string | null | undefined,
  ): Promise<void> {
    tabStore.setLanguageOverride(tabId, override);
    const tab = tabStore.findById(tabId);
    if (!tab) return;
    if (tabStore.active()?.id === tabId) await this.deps.setEditorLanguage(override);
    this.deps.refreshStatus();
    this.deps.showMessage(`语言模式：${languageLabel(tab)}`);
  }

  // ---- 编码 ----

  private showEncodingMenu(x: number, y: number): void {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text" || !tab.path) {
      this.deps.showMessage("当前文件不支持切换编码");
      return;
    }
    const candidates = tab.encodingCandidates.length
      ? tab.encodingCandidates
      : this.deps.fallbackEncodings;
    const suggested = tab.mojibakeSuggested?.trim() ?? "";
    const options = candidates.map((enc) => ({ value: enc, label: enc }));
    // 乱码已诊断出建议编码时，把它顶到第一项：用户不必自己判断选哪个
    if (suggested && !candidates.includes(suggested)) {
      options.unshift({ value: suggested, label: `${suggested}（建议）` });
    } else if (suggested) {
      const idx = options.findIndex((o) => o.value === suggested);
      if (idx > 0) {
        const [hit] = options.splice(idx, 1);
        hit.label = `${hit.label}（建议）`;
        options.unshift(hit);
      }
    }
    openStatusMenu({
      anchor: { x, y },
      header: `当前编码：${tab.encoding}${suggested ? ` · 建议 ${suggested}` : ""}`,
      options,
      // 两类编码操作同框但语义不同：上面只改解读方式，下面是真正转码写新文件
      actions: [
        {
          label: "另存为编码…（转码写入新文件）",
          separatorBefore: true,
          run: () => this.deps.saveAsWithEncoding(),
        },
      ],
      current: tab.encoding,
      tabId: tab.id,
      onMessage: this.deps.showMessage,
      onPick: (enc) => void this.reopenWithEncoding(tab.id, enc),
    });
  }

  /** 重新打开为：按新编码重新解读磁盘字节（不写盘） */
  private async reopenWithEncoding(tabId: string, encoding: string): Promise<void> {
    const tab = tabStore.findById(tabId);
    if (!tab || !tab.path) return;
    if (
      tab.dirty &&
      !(await confirmAction(
        `「${tab.name}」有未保存修改，重新打开将丢弃这些修改。是否继续？`,
      ))
    ) {
      return;
    }
    try {
      const data = await this.deps.readDiskAs(tab.path, encoding);
      tabStore.reopenWith(tabId, data);
      // 手动选择比自动检测可靠：记下来，下次打开该文件优先用
      if (tab.path) this.deps.rememberEncoding?.(tab.path, data.encoding);
      // 编码已变更：旧结论失效，按新解读重新检测
      tabStore.setMojibake(tabId, "", "");
      if (tabStore.active()?.id === tabId) {
        await this.deps.reloadActiveTab();
        void this.checkMojibake(tabId);
      } else {
        this.deps.refreshStatus();
      }
      this.deps.showMessage(
        tabStore.findById(tabId)?.dirty
          ? `编码已切换为 ${data.encoding}（未保存，Ctrl+S 转码保存）`
          : `已重新打开为 ${data.encoding}`,
      );
    } catch (e) {
      this.deps.showMessage(`重新打开失败: ${String(e).split("\n")[0]}`);
    }
  }

  // ---- 乱码检测（打开文件后自动诊断；只提示，不改文件、不自动切编码）----

  /**
   * 对标签做一次乱码检测并记录结论；只读标签同样适用（检测不改内容）。
   * 返回 false 表示检**测本身失败**（IPC / 读文件失败），与「检测了但没乱码」是两回事，
   * 调用方必须区分：把手动检测失败显示成「未检测到乱码」是错误结论。
   */
  async checkMojibake(tabId: string): Promise<boolean> {
    const tab = tabStore.findById(tabId);
    if (!tab || tab.kind !== "text" || !tab.path || tab.pending || tab.virtual) return true;
    if (tab.size > MOJIBAKE_MAX_BYTES) return true;
    try {
      const report = await invoke<MojibakeReport>("detect_mojibake", {
        path: tab.path,
        text: tabStore.snapshotOf(tab),
        current: tab.encoding,
      });
      const current = tabStore.findById(tabId);
      if (!current) return true; // 标签已关闭：没有结论，但也不算检测失败
      tabStore.setMojibake(
        tabId,
        report.suspicious ? report.suggested : "",
        report.suspicious ? report.reason : "",
      );
      if (report.suspicious && tabStore.active()?.id === tabId) {
        this.deps.showMessage(report.reason);
      }
      return true;
    } catch (e) {
      console.warn("[mojibake] 检测失败", e);
      return false;
    }
  }

  /** 命令面板入口：对当前标签立即重检并给出可选建议 */
  detectMojibakeManually(): void {
    const tab = this.deps.getActiveTab();
    if (!tab || tab.kind !== "text" || !tab.path) {
      this.deps.showMessage("请先打开一个磁盘上的文本文件");
      return;
    }
    if (tab.virtual) {
      this.deps.showMessage("大文件只读视图不支持乱码检测");
      return;
    }
    void (async () => {
      const detected = await this.checkMojibake(tab.id);
      const fresh = tabStore.findById(tab.id);
      if (!fresh) return;
      if (!detected) {
        // 检测失败不能显示成「未检测到乱码」：那是把错误包装成了结论
        this.deps.showMessage("乱码检测失败：未能读取文件内容或编码信息");
        return;
      }
      if (!fresh.mojibakeReason) {
        this.deps.showMessage("未检测到乱码");
        return;
      }
      if (fresh.mojibakeSuggested) {
        const ok = await confirmAction(
          `${fresh.mojibakeReason}。是否立即重新打开为 ${fresh.mojibakeSuggested}？`,
          "重新打开",
        );
        if (ok) await this.reopenWithEncoding(fresh.id, fresh.mojibakeSuggested);
      } else {
        this.deps.showMessage(fresh.mojibakeReason);
      }
    })();
  }
}
