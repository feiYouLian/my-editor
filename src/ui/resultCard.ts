/**
 * 结果卡：产物类动作的常驻反馈。
 *
 * 三段式回答三个问题：
 *   做了什么（含产物名与格式）/ 产物在哪（可打开目录、复制路径）/ 这是什么（用途与下一步）。
 * 失败态同样三段：失败原因 / 自救动作 / 影响范围，不静默、不只给错误串。
 *
 * 卡片 8 秒后自动收起，鼠标悬停时暂停；需要回看时走通知中心
 * （app/resultCenter 负责同时写入通知，ui 层不依赖 app）。
 */

import { invoke } from "@tauri-apps/api/core";
import { firstLine } from "../core/errors";

export interface ResultCardAction {
  label: string;
  run: () => void;
}

export interface ResultCardSpec {
  /** 段 1：动作结果，含产物名与格式 */
  title: string;
  /** 段 2：产物绝对路径（产物类动作必填） */
  path?: string;
  /** 段 2 的附加动作（如「覆盖 / 换个名字」这类需要用户拍板的选择） */
  actions?: ResultCardAction[];
  /** 段 3：这是什么 / 能拿它做什么 / 会不会改原文件 */
  hint: string;
  /** 深链到帮助锚点 */
  learnMore?: () => void;
  /** 命令 id：app 层的 reportResult 据此生成「了解更多」（跳到命令索引对应条目） */
  helpId?: string;
  /** 去重键：同一动作重复执行时只保留最新一张 */
  key?: string;
}

export interface ResultErrorSpec {
  /** 段 1：哪个动作失败了 */
  title: string;
  /** 段 2：失败原因（原文，不吞） */
  message: string;
  /** 段 3：影响范围与下一步 */
  hint?: string;
  retry?: () => void;
  openSettings?: () => void;
}

const AUTO_DISMISS_MS = 8000;
const MAX_CARDS = 3;

function makeButton(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "result-card-action";
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/** 卡片容器：每次按 DOM 查找，不保留模块级引用 */
function stack(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(".result-card-stack");
  if (existing) return existing;
  const el = document.createElement("div");
  el.className = "result-card-stack";
  document.body.append(el);
  return el;
}

function mount(card: HTMLElement, key?: string): void {
  const host = stack();
  if (key) {
    for (const el of host.querySelectorAll("[data-result-key]")) {
      if (el.getAttribute("data-result-key") === key) el.remove();
    }
  }
  card.dataset.resultKey = key ?? "";
  host.append(card);
  while (host.children.length > MAX_CARDS) host.firstElementChild?.remove();

  let timer = window.setTimeout(() => card.remove(), AUTO_DISMISS_MS);
  const restart = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => card.remove(), AUTO_DISMISS_MS);
  };
  card.addEventListener("mouseenter", () => window.clearTimeout(timer));
  card.addEventListener("mouseleave", restart);
}

function head(title: string, onClose: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "result-card-head";
  const text = document.createElement("span");
  text.className = "result-card-title";
  text.textContent = title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "result-card-close";
  close.textContent = "×";
  close.title = "关闭（结果仍保留在通知中心）";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    onClose();
  });
  row.append(text, close);
  return row;
}

function pathRow(path: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "result-card-path";

  const text = document.createElement("span");
  text.className = "result-card-path-text";
  text.textContent = path;
  text.title = path;

  const reveal = makeButton("打开所在目录", () => {
    void invoke("reveal_in_file_manager", { path }).catch((e) => {
      reveal.textContent = "打开失败";
      reveal.title = firstLine(e);
    });
  });

  const copy = makeButton("复制路径", () => {
    void navigator.clipboard.writeText(path).then(
      () => {
        copy.textContent = "已复制";
        window.setTimeout(() => {
          copy.textContent = "复制路径";
        }, 1500);
      },
      () => {
        copy.textContent = "复制失败";
      },
    );
  });

  row.append(text, reveal, copy);
  return row;
}

/** 成功态：产物类动作的统一反馈 */
export function showResultCard(spec: ResultCardSpec): void {
  const card = document.createElement("div");
  card.className = "result-card";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");

  card.append(head(spec.title, () => card.remove()));
  if (spec.path) card.append(pathRow(spec.path));

  const hint = document.createElement("div");
  hint.className = "result-card-hint";
  hint.textContent = spec.hint;
  card.append(hint);

  if (spec.actions?.length || spec.learnMore) {
    const foot = document.createElement("div");
    foot.className = "result-card-foot";
    for (const action of spec.actions ?? []) {
      foot.append(makeButton(action.label, action.run));
    }
    if (spec.learnMore) foot.append(makeButton("了解更多", spec.learnMore));
    card.append(foot);
  }

  mount(card, spec.key);
}

/** 失败态：原因 + 自救动作，绝不只给一行错误串 */
export function showErrorCard(spec: ResultErrorSpec): void {
  const card = document.createElement("div");
  card.className = "result-card result-card-error";
  card.setAttribute("role", "alert");

  card.append(head(spec.title, () => card.remove()));

  const reason = document.createElement("div");
  reason.className = "result-card-reason";
  reason.textContent = spec.message;
  card.append(reason);

  if (spec.hint) {
    const hint = document.createElement("div");
    hint.className = "result-card-hint";
    hint.textContent = spec.hint;
    card.append(hint);
  }

  const actions: HTMLButtonElement[] = [];
  if (spec.retry) actions.push(makeButton("重试", spec.retry));
  if (spec.openSettings) actions.push(makeButton("打开配置", spec.openSettings));
  if (actions.length > 0) {
    const foot = document.createElement("div");
    foot.className = "result-card-foot";
    foot.append(...actions);
    card.append(foot);
  }

  mount(card, spec.title);
}
