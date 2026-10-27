/**
 * 输入手感：自动闭合括号/引号、输入时自动缩进、文档内单词补全。
 *
 * 三者都来自 @codemirror/autocomplete / @codemirror/language 的现成能力，
 * 不引入词库、索引或后台连接（保持轻量）。
 *
 * 补全键位：不用 autocompletion 的 defaultKeymap —— 它用 Prec.highest 抢占
 * Enter / Escape / 方向键，会和搜索面板、命令面板、输入法候选框打架。
 */

import {
  autocompletion,
  closeBrackets,
  closeCompletion,
  completeAnyWord,
  moveCompletionSelection,
  startCompletion,
  acceptCompletion,
  closeBracketsKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { indentOnInput } from "@codemirror/language";
import { keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { settings } from "../config/settings";

/** 文档内单词补全的规模上限：超过就不挂（扫全文的代价与收益不匹配） */
export const WORD_COMPLETION_MAX_BYTES = 2 * 1024 * 1024;

/** 大文档直接放弃补全：completeAnyWord 每次触发都要扫全文 */
const guardedWordSource: CompletionSource = (ctx) =>
  ctx.state.doc.length > WORD_COMPLETION_MAX_BYTES ? null : completeAnyWord(ctx);

/** 自动闭合括号 / 引号 */
export function autoCloseExtensions(on: boolean): Extension {
  return on ? [closeBrackets()] : [];
}

/** 输入时按语言自动缩进 */
export function autoIndentExtension(on: boolean): Extension {
  return on ? [indentOnInput()] : [];
}

/** 补全键位（随补全扩展一起挂/摘，避免只读状态下仍然抢键） */
export function completionKeymap(): Extension {
  return keymap.of([
    { key: "Ctrl-Space", run: startCompletion },
    { key: "Alt-/", run: startCompletion },
    { key: "Enter", run: acceptCompletion },
    { key: "Escape", run: closeCompletion },
    { key: "ArrowDown", run: moveCompletionSelection(true) },
    { key: "ArrowUp", run: moveCompletionSelection(false) },
  ]);
}

/**
 * 单词补全：只读或不启用时整体置空；文档过大时由源自身返回 null
 * （不重配扩展，避免切标签时反复挂载/卸载）。
 */
export function completionExtensions(opts: { readonly: boolean }): Extension {
  if (opts.readonly || !settings.wordCompletion) return [];
  return [
    autocompletion({
      override: [guardedWordSource],
      // 不用内置 keymap：见文件头说明
      defaultKeymap: false,
      activateOnTyping: true,
    }),
    completionKeymap(),
  ];
}

/** 闭合括号的 Backspace 联动：必须排在 defaultKeymap 之前才生效 */
export { closeBracketsKeymap };
