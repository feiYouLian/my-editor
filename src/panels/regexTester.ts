/**
 * 正则测试器对话框（命令面板入口）：
 * 输入表达式与开关（g / i / m / s / u），在下方测试文本中实时列出匹配位置与捕获组，
 * 并可选做替换预览。纯前端 RegExp，无依赖。
 */

const FLAGS: { key: string; label: string; title: string }[] = [
  { key: "g", label: "g", title: "全局匹配（列出全部匹配）" },
  { key: "i", label: "i", title: "忽略大小写" },
  { key: "m", label: "m", title: "多行：^ $ 匹配每行首尾" },
  { key: "s", label: "s", title: "单行：. 匹配换行" },
  { key: "u", label: "u", title: "Unicode 模式" },
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

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  close(): void {
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
    this.patternInput.addEventListener("input", () => this.render());
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
    this.textArea.addEventListener("input", () => this.render());
    dialog.append(textLabel, this.textArea);

    // ---- 替换预览（可选） ----
    const replaceRow = document.createElement("div");
    replaceRow.className = "dialog-fields";
    const replaceLabel = document.createElement("label");
    replaceLabel.textContent = "替换";
    this.replaceInput = document.createElement("input");
    this.replaceInput.className = "dialog-input";
    this.replaceInput.spellcheck = false;
    this.replaceInput.placeholder = "替换文本（支持 $1 / $&）";
    this.replaceInput.addEventListener("input", () => this.render());
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

  private buildRegex(): { re: RegExp | null; error: string | null } {
    const pattern = this.patternInput.value;
    this.statusEl.textContent = "";
    this.listEl.innerHTML = "";
    this.replaceOut.textContent = "";
    this.replaceOut.classList.add("hidden");
    if (pattern === "") {
      this.statusEl.textContent = "请输入正则表达式";
      return { re: null, error: null };
    }
    const flags = [...FLAGS.map((f) => f.key).filter((k) => this.flags.has(k))].join("");
    try {
      return { re: new RegExp(pattern, flags), error: null };
    } catch (e) {
      return { re: null, error: `正则无效：${String(e).split("\n")[0]}` };
    }
  }

  private render(): void {
    const { re, error } = this.buildRegex();
    if (error) {
      this.statusEl.textContent = error;
      return;
    }
    if (!re) return;

    const text = this.textArea.value;
    // 列表需要全局迭代：未勾选 g 时内部临时补上
    const iterRe = re.global ? re : new RegExp(re.source, `${re.flags}g`);
    const matches: RegExpExecArray[] = [];
    let truncated = false;
    let m: RegExpExecArray | null;
    while ((m = iterRe.exec(text)) !== null) {
      matches.push(m);
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      if (m[0] === "") iterRe.lastIndex += 1; // 零宽匹配防死循环
    }

    const tail = truncated ? `（仅列出前 ${MAX_MATCHES} 处）` : "";
    this.statusEl.textContent = text.trim() === ""
      ? "请在下方粘贴测试文本"
      : `匹配 ${matches.length} 处${tail}`;

    for (const match of matches) {
      const row = document.createElement("div");
      row.className = "regex-row";
      const head = document.createElement("span");
      head.className = "regex-index";
      head.textContent = `${match.index}`;
      const body = document.createElement("span");
      body.textContent = match[0] === "" ? "（零宽匹配）" : match[0];
      row.append(head, body);
      // 捕获组
      for (let i = 1; i < match.length; i += 1) {
        if (match[i] === undefined) continue;
        const group = document.createElement("span");
        group.className = "regex-group";
        group.textContent = `$${i}=${match[i]}`;
        row.append(group);
      }
      this.listEl.append(row);
    }

    // 替换预览
    const replacement = this.replaceInput.value;
    if (replacement !== "" && matches.length > 0) {
      const preview = text.replace(
        re.global ? re : new RegExp(re.source, `${re.flags}g`),
        replacement,
      );
      const cut = preview.length > 2000 ? `${preview.slice(0, 2000)}…` : preview;
      this.replaceOut.textContent = `替换预览（前 2000 字符）：\n${cut}`;
      this.replaceOut.classList.remove("hidden");
    }
  }
}
