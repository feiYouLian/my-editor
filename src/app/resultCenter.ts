/**
 * 结果卡出口：卡片当场看见，通知中心留底可回看。
 *
 * ui/resultCard 只画卡片（不依赖 app）；这里补上「错过也能找回」的一环，
 * 面板通过 Deps 注入拿到本模块，避免 panels → app 的越界依赖。
 */

import type { ResultCardSpec, ResultErrorSpec } from "../ui/resultCard";
import { showErrorCard, showResultCard } from "../ui/resultCard";
import { showHelpDialog } from "../panels/helpDialog";
import { addNotice } from "./noticeStore";

export function reportResult(spec: ResultCardSpec): void {
  // helpId → 「了解更多」：跳到命令索引里该命令的条目（docs/COMMANDS.md）
  const card =
    spec.helpId && !spec.learnMore
      ? { ...spec, learnMore: () => showHelpDialog("commands", spec.helpId!) }
      : spec;
  showResultCard(card);
  const detail = spec.path ? `${spec.path}\n${spec.hint}` : spec.hint;
  addNotice("result", spec.title, [], spec.key, detail);
}

export function reportFailure(spec: ResultErrorSpec): void {
  showErrorCard(spec);
  addNotice("result", `${spec.title}：${spec.message}`, [], spec.title, spec.hint);
}
