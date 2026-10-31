/**
 * 正则测试器对话框（命令面板入口）：
 * 表达式与替换预览统一走 Rust `regex`（与工作区搜索同引擎），
 * 避免 JS RegExp 能测、搜索却报“正则无效”的双轨问题。
 */

import { invoke } from "@tauri-apps/api/core";
import { firstLine } from "../core/errors";

interface RegexTestMatch {
  start: number;
  end: number;
  text: string;
  groups: (string | null)[];
}

interface RegexTestResult {
  matches: RegexTestMatch[];
  truncated: boolean;
}

interface RegexPreview {
  text: string;
  truncated: boolean;
}


const FLAGS: { key: string; label: string; title: string }[] = [
  { key: "g", label: "g", title: "列出全部匹配（最多 200 处）" },
  { key: "i", label: "i", title: "忽略大小写" },
  { key: "m", label: "m", title: "多行：^ $ 匹配每行首尾" },
  { key: "s", label: "s", title: "单行：. 匹配换行" },
  { key: "u", label: "u", title: "Unicode（Rust regex 默认开启，此开关仅兼容展示）" },
];

/** 匹配结果展示上限 */
const MAX_MATCHES = 200;

export class RegexTesterPanel {
  private backdrop: HTMLElement | null = null;
  private patternInput!: HTMLInputElement;
  private replaceInput!: HTMLInputElement;
  private textArea!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;
  private replaceOut!: HTMLElement;
  private flagButtons = new Map<string, HTMLButtonElement>();
  private flags = new Set<string>(["g"]);
  /** 异步测试的代际号：输入变化后旧结果必须丢弃 */
  private renderSeq = 0;
  private renderTimer: number | null = null;

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  close(): void {
    this.renderSeq += 1;
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.backdrop?.remove();
    this.backdrop = null;
  }

  open(): void {
    if (this.isOpen) return;

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "dialog dialog-wide";
    dialog.setAttribute("role", "dialog");

    const title = document.createElement("h3");
    title.textContent = "正则测试器";
    dialog.append(title);

    // ---- 表达式 + 开关 ----
    const patternRow = document.createElement("div");
    patternRow.className = "dialog-fields";
    const patternLabel = document.createElement("label");
    patternLabel.textContent = "表达式";
    this.patternInput = document.createElement("input");
    this.patternInput.className = "dialog-input";
    this.patternInput.spellcheck = false;
    this.patternInput.placeholder = "如 (\\w+)@(\\w+\\.\\w+)";
    this.patternInput.addEventListener("input", () => this.scheduleRender());
    const flagRow = document.createElement("div");
    flagRow.className = "regex-flags";
    for (const flag of FLAGS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `gs-toggle${this.flags.has(flag.key) ? " active" : ""}`;
      btn.textContent = flag.label;
      btn.title = flag.title;
      btn.addEventListener("click", () => {
        if (this.flags.has(flag.key)) this.flags.delete(flag.key);
        else this.flags.add(flag.key);
        btn.classList.toggle("active", this.flags.has(flag.key));
        this.render();
      });
      this.flagButtons.set(flag.key, btn);
      flagRow.append(btn);
    }
    patternRow.append(patternLabel, this.patternInput, flagRow);
    dialog.append(patternRow);

    // ---- 测试文本 ----
    const textLabel = document.createElement("p");
    textLabel.className = "dialog-text";
    textLabel.textContent = "测试文本";
    this.textArea = document.createElement("textarea");
    this.textArea.className = "dialog-input regex-text";
    this.textArea.spellcheck = false;
    this.textArea.placeholder = "粘贴要测试的文本…";
    this.textArea.addEventListener("input", () => this.scheduleRender());
    dialog.append(textLabel, this.textArea);

    // ---- 替换预览（可选） ----
    const replaceRow = document.createElement("div");
    replaceRow.className = "dialog-fields";
    const replaceLabel = document.createElement("label");
    replaceLabel.textContent = "替换";
    this.replaceInput = document.createElement("input");
    this.replaceInput.className = "dialog-input";
    this.replaceInput.spellcheck = false;
    this.replaceInput.placeholder = "替换文本（Rust：$1 / ${name} / $0）";
    this.replaceInput.addEventListener("input", () => this.scheduleRender());
    replaceRow.append(replaceLabel, this.replaceInput);
    dialog.append(replaceRow);

    // ---- 结果 ----
    this.statusEl = document.createElement("p");
    this.statusEl.className = "dialog-text";
    this.listEl = document.createElement("div");
    this.listEl.className = "regex-list";
    this.replaceOut = document.createElement("pre");
    this.replaceOut.className = "regex-replace";
    dialog.append(this.statusEl, this.listEl, this.replaceOut);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "primary";
    closeBtn.textContent = "关闭";
    closeBtn.addEventListener("click", () => this.close());
    actions.append(closeBtn);
    dialog.append(actions);

    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;

    this.render();
    this.patternInput.focus();
  }

  private scheduleRender(): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    // 输入防抖：避免每次按键都发一次 IPC（文本可能很大）
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.render();
    }, 150);
  }

  private clearResults(): void {
    this.statusEl.textContent = "";
    this.listEl.innerHTML = "";
    this.replaceOut.textContent = "";
    this.replaceOut.classList.add("hidden");
  }

  private async render(): Promise<void> {
    const pattern = this.patternInput.value;
    this.clearResults();
    if (pattern === "") {
      this.statusEl.textContent = "请输入正则表达式";
      return;
    }
    const text = this.textArea.value;
    if (text.trim() === "") {
      this.statusEl.textContent = "请在下方粘贴测试文本";
      return;
    }

    const token = ++this.renderSeq;
    const flags = [...FLAGS.map((f) => f.key).filter((k) => this.flags.has(k))].join("");
    try {
      const result = await invoke<RegexTestResult>("regex_test", {
        pattern,
        flags,
        text,
        maxMatches: MAX_MATCHES,
      });
      if (token !== this.renderSeq) return;

      const tail = result.truncated ? `（仅列出前 ${MAX_MATCHES} 处）` : "";
      const engineHint = this.replaceInput.value.includes("$&")
        ? "；$& 不是 Rust 语法，请用 $0 表示整个匹配"
        : "";
      this.statusEl.textContent = `匹配 ${result.matches.length} 处${tail}（Rust regex）${engineHint}`;

      for (const match of result.matches) {
        const row = document.createElement("div");
        row.className = "regex-row";
        const head = document.createElement("span");
        head.className = "regex-index";
        head.textContent = `${match.start}`;
        const body = document.createElement("span");
        body.textContent = match.text === "" ? "（零宽匹配）" : match.text;
        row.append(head, body);
        match.groups.forEach((value, index) => {
          if (value === null) return;
          const group = document.createElement("span");
          group.className = "regex-group";
          group.textContent = `$${index + 1}=${value}`;
          row.append(group);
        });
        this.listEl.append(row);
      }

      const replacement = this.replaceInput.value;
      if (replacement !== "" && result.matches.length > 0) {
        const preview = await invoke<RegexPreview>("regex_replace_preview", {
          pattern,
          flags,
          replacement,
          text,
          maxChars: 2000,
        });
        if (token !== this.renderSeq) return;
        this.replaceOut.textContent = `替换预览（前 2000 字符）：\n${preview.text}${preview.truncated ? "…" : ""}`;
        this.replaceOut.classList.remove("hidden");
      }
    } catch (e) {
      if (token !== this.renderSeq) return;
      this.statusEl.textContent = `正则无效：${firstLine(e)}`;
    }
  }
}
