import {
  CRON_PRESETS,
  CRON_SPECS,
  describeCron,
  formatCron,
  nextRuns,
  parseCron,
  type CronFields,
} from "./cron";

/**
 * Cron 解析 / 生成对话框（命令面板入口）：
 * 六个字段（秒 分 时 日 月 周）实时合成表达式 + 中文描述 + 未来 5 次执行时刻；
 * 秒字段留空即传统 5 段写法；反向粘贴 5 / 6 段表达式都会回填各字段。
 */

const WEEK_SHORT = ["日", "一", "二", "三", "四", "五", "六"];

/** 表达式说明（静态文案；图例为完整 cron 结构，并注明本编辑器实际支持的段数） */
const HELP_HTML = `
  <summary>表达式说明</summary>
  <div class="cron-help-body">
    <pre class="cron-legend">*   *   *   *   *   *   *
┬   ┬   ┬   ┬   ┬   ┬   ┬
│   │   │   │   │   │   └─ 年（可选）
│   │   │   │   │   └─ 星期 (0-7, 1L-7L，0/7 为周日)
│   │   │   │   └─ 月份 (1-12, JAN-DEC)
│   │   │   └─ 日 (1-31, L)
│   │   └─ 小时 (0-23)
│   └─ 分钟 (0-59)
└─ 秒 (0-59；传统 cron 在绝大多数 Unix / Linux 上都没有这个字段)</pre>
    <div class="cron-help-line">语法：<code>*</code> 任意 · <code>a</code> 单值 · <code>a-b</code> 范围 · <code>*</code>+<code>/n</code> 每 n · <code>a-b/n</code> 范围内每 n · <code>,</code> 并列</div>
    <div class="cron-help-line">日与周<b>都</b>限定时按「或」匹配（任一命中即执行）；只有一个受限时按该字段匹配。</div>
    <div class="cron-help-line"><b>本编辑器支持 5 / 6 / 7 段</b>：5 段=分 时 日 月 周；6 段=秒 分 时 日 月 周；7 段再加末尾的「年」。秒留空按第 0 秒触发；年留空表示不限制（输出 7 段时秒位自动补 0 以对齐位置）；<code>L</code>、<code>1L-7L</code>、<code>JAN-DEC</code> 等扩展语法暂不支持。</div>
  </div>
`;

function formatDateTime(d: Date, withSeconds: boolean): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
  return `${withSeconds ? `${hm}:${p(d.getSeconds())}` : hm} 周${WEEK_SHORT[d.getDay()]}`;
}

export class CronPanel {
  private backdrop: HTMLElement | null = null;
  private inputs = {} as Record<keyof CronFields, HTMLInputElement>;
  private exprEl!: HTMLInputElement;
  private descEl!: HTMLElement;
  private nextEl!: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
    title.textContent = "Cron 表达式解析 / 生成";
    dialog.append(title);

    // ---- 七个字段（秒 / 年可留空） ----
    for (const spec of CRON_SPECS) {
      const isSecond = spec.key === "second";
      const isYear = spec.key === "year";
      const optional = isSecond || isYear;
      const row = document.createElement("div");
      row.className = "dialog-fields";
      const label = document.createElement("label");
      label.textContent = isSecond
        ? `${spec.label}（留空 = 5 段）`
        : isYear
          ? `${spec.label}（留空 = 不限制）`
          : `${spec.label}（${spec.min}-${spec.max}）`;
      const input = document.createElement("input");
      input.className = "dialog-input";
      input.value = optional ? "" : "*";
      input.spellcheck = false;
      input.placeholder = isSecond
        ? "留空即按传统 5 段（第 0 秒）触发"
        : isYear
          ? `${spec.min}-${spec.max}；留空 = 不限制`
          : "* | 5 | 1-5 | */10 | 1,15";
      input.addEventListener("input", () => this.scheduleRefresh());
      this.inputs[spec.key] = input;
      row.append(label, input);
      dialog.append(row);
    }

    // ---- 常用预设 ----
    const presets = document.createElement("div");
    presets.className = "cron-presets";
    for (const preset of CRON_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "df-btn df-btn-wide";
      btn.textContent = preset.label;
      btn.addEventListener("click", () => {
        for (const spec of CRON_SPECS) {
          this.inputs[spec.key].value = preset.fields[spec.key];
        }
        this.scheduleRefresh();
      });
      presets.append(btn);
    }
    dialog.append(presets);

    // ---- 合成表达式（可粘贴回填） ----
    const exprRow = document.createElement("div");
    exprRow.className = "dialog-fields";
    const exprLabel = document.createElement("label");
    exprLabel.textContent = "表达式";
    this.exprEl = document.createElement("input");
    this.exprEl.className = "dialog-input";
    this.exprEl.spellcheck = false;
    this.exprEl.title = "粘贴 5 段表达式可反向回填上方字段";
    this.exprEl.addEventListener("focus", () => this.exprEl.select());
    this.exprEl.addEventListener("change", () => this.applyExpression());
    exprRow.append(exprLabel, this.exprEl);
    dialog.append(exprRow);

    // ---- 解析结果 ----
    this.descEl = document.createElement("p");
    this.descEl.className = "dialog-text";
    const nextTitle = document.createElement("p");
    nextTitle.className = "dialog-text";
    nextTitle.textContent = "下次执行（本地时间）";
    this.nextEl = document.createElement("div");
    this.nextEl.className = "cron-next";
    dialog.append(this.descEl, nextTitle, this.nextEl);

    // ---- 表达式说明（默认展开，可折叠） ----
    const help = document.createElement("details");
    help.className = "cron-help";
    help.open = true;
    help.innerHTML = HELP_HTML;
    dialog.append(help);

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

    this.scheduleRefresh();
    this.inputs.minute.focus();
  }

  /** 反向解析：粘贴 7 / 6 / 5 段表达式，回填到各字段 */
  private applyExpression(): void {
    const parts = this.exprEl.value.trim().split(/\s+/);
    const order: (keyof CronFields)[] = ["second", "minute", "hour", "day", "month", "week", "year"];
    const fill = (keys: (keyof CronFields)[]) => {
      keys.forEach((key, i) => {
        this.inputs[key].value = parts[i];
      });
    };
    if (parts.length === order.length) {
      fill(order); // 7 段：秒 分 时 日 月 周 年
    } else if (parts.length === order.length - 1) {
      // 6 段：末段像「年」则按「分 时 日 月 周 年」，否则按「秒 分 时 日 月 周」
      if (this.looksLikeYear(parts[5])) {
        this.inputs.second.value = "";
        fill(order.slice(1));
      } else {
        this.inputs.year.value = "";
        fill(order.slice(0, -1));
      }
    } else if (parts.length === order.length - 2) {
      this.inputs.second.value = "";
      this.inputs.year.value = "";
      fill(order.slice(1, -1)); // 5 段：分 时 日 月 周
    } else {
      return;
    }
    this.scheduleRefresh();
  }

  /** 末段是否像「年」：含 >31 的数值（周最大 7、日最大 31，年至少 4 位） */
  private looksLikeYear(text: string): boolean {
    return text.split(",").some((p) => {
      const num = Number(p.split("-")[0].split("/")[0]);
      return !Number.isNaN(num) && num > 31;
    });
  }

  private readFields(): CronFields {
    return {
      second: this.inputs.second.value,
      minute: this.inputs.minute.value,
      hour: this.inputs.hour.value,
      day: this.inputs.day.value,
      month: this.inputs.month.value,
      week: this.inputs.week.value,
      year: this.inputs.year.value,
    };
  }

  /** 输入防抖：表达式极端（如 2 月 29 日）时逐字符求下次时刻会略慢 */
  private scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.render();
    }, 120);
  }

  private render(): void {
    const fields = this.readFields();
    const expr = formatCron(fields);
    if (this.exprEl.value !== expr && document.activeElement !== this.exprEl) {
      this.exprEl.value = expr;
    }

    const parsed = parseCron(fields);
    if (parsed.error) {
      this.descEl.textContent = `表达式无效：${parsed.error}`;
      this.nextEl.innerHTML = "";
      return;
    }
    this.descEl.textContent = `含义：${describeCron(fields)}`;

    const runs = nextRuns(fields, 5);
    this.nextEl.innerHTML = "";
    if (runs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cron-next-row";
      empty.textContent = "在支持的范围内（至 2099 年）无匹配时刻";
      this.nextEl.append(empty);
      return;
    }
    const withSeconds = fields.second.trim() !== "";
    for (const time of runs) {
      const row = document.createElement("div");
      row.className = "cron-next-row";
      row.textContent = formatDateTime(time, withSeconds);
      this.nextEl.append(row);
    }
  }
}
