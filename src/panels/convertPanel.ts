/**
 * 格式转换面板（模态）：源格式探测/覆盖、目标下拉、动态选项、双栏预览、
 * 替换 / 插入新标签 / 复制三种输出动作。
 *
 * 纯展示与交互；写回编辑器、新建标签由 app 层经 deps 注入（单向依赖）。
 */

import {
  CONVERT_OPTION_SPECS,
  CONVERT_TARGET_HINTS,
  CONVERT_TARGET_LABELS,
  ConvertError,
  convert,
  detectFormat,
  parseJsonText,
  targetExtension,
  type ConvertFormat,
  type ConvertKind,
  type ConvertOptions,
  type ConvertTarget,
} from "../core/convert";
import { jsonToCode, type CodegenOptions } from "../core/convertCodegen";
import { confirmAction } from "../ui/dialogs";

/** 超过此行数替换前确认（与格式化一致） */
const CONFIRM_LINES = 10000;
/** 源文本预览截断行数 */
const PREVIEW_LINES = 2000;
/** 输入变化后的重算防抖 */
const DEBOUNCE_MS = 150;

export interface ConvertSource {
  text: string;
  /** 选区范围；无选区时为整篇 [0, len] */
  from: number;
  to: number;
  hasSelection: boolean;
  readonly: boolean;
  lineCount: number;
  tabId: string;
}

export interface ConvertPanelDeps {
  /** 把结果写回编辑器（选区或整篇）；返回是否成功 */
  replace: (text: string, source: ConvertSource) => boolean;
  /** 插入为新的未命名标签（target 决定语言键与扩展名） */
  insertAsTab: (text: string, target: ConvertTarget) => void;
  showMessage: (text: string) => void;
}

function truncatePreview(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= PREVIEW_LINES) return text;
  return `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…（仅显示前 ${PREVIEW_LINES} 行）`;
}

export class ConvertPanel {
  private backdrop: HTMLElement | null = null;
  private sourceSelect!: HTMLSelectElement;
  private targetSelect!: HTMLSelectElement;
  private detectHint!: HTMLElement;
  private optionsEl!: HTMLElement;
  private sourcePre!: HTMLElement;
  private outputPre!: HTMLElement;
  private hintEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private replaceBtn!: HTMLButtonElement;
  private insertBtn!: HTMLButtonElement;
  private copyBtn!: HTMLButtonElement;

  private source: ConvertSource | null = null;
  private result: string | null = null;
  private optionValues = new Map<string, string | boolean>();
  private timer: number | null = null;
  /** 异步转换代号：丢弃过期结果（防抖 + 快速切换目标） */
  private generation = 0;

  constructor(private deps: ConvertPanelDeps) {}

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  toggle(source: ConvertSource): void {
    if (this.isOpen) this.close();
    else this.open(source);
  }

  close(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.generation++;
    this.backdrop?.remove();
    this.backdrop = null;
    this.source = null;
    this.result = null;
  }

  open(source: ConvertSource): void {
    if (this.isOpen) return;
    this.source = source;
    this.result = null;

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "dialog dialog-convert";
    dialog.setAttribute("role", "dialog");
    dialog.append(this.buildHead(), this.buildControls(), this.buildPreview());
    this.errorEl = document.createElement("p");
    this.errorEl.className = "dialog-error hidden";
    dialog.append(this.errorEl, this.buildActions());
    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;

    this.sourcePre.textContent = truncatePreview(source.text);
    this.sourceSelect.value = detectFormat(source.text) ?? "auto";
    this.onSourceChange();
    this.sourceSelect.focus();
  }

  // ---- DOM 构建 ----

  private buildHead(): HTMLElement {
    const head = document.createElement("div");
    head.className = "convert-head";
    const title = document.createElement("h3");
    title.textContent = "格式转换";
    const scope = document.createElement("span");
    scope.className = "convert-scope";
    scope.textContent = this.source?.hasSelection ? "范围：选区" : "范围：整篇";
    head.append(title, scope);
    return head;
  }

  private buildControls(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "convert-controls";

    const sourceRow = document.createElement("div");
    sourceRow.className = "dialog-fields";
    const sourceLabel = document.createElement("label");
    sourceLabel.textContent = "源格式";
    this.sourceSelect = document.createElement("select");
    this.sourceSelect.className = "dialog-input";
    for (const [value, label] of [
      ["auto", "自动识别"],
      ["json", "JSON"],
      ["yaml", "YAML"],
      ["properties", "Properties"],
    ] as const) {
      this.sourceSelect.append(new Option(label, value));
    }
    this.sourceSelect.addEventListener("change", () => this.onSourceChange());
    this.detectHint = document.createElement("span");
    this.detectHint.className = "convert-detect";
    sourceRow.append(sourceLabel, this.sourceSelect, this.detectHint);

    const targetRow = document.createElement("div");
    targetRow.className = "dialog-fields";
    const targetLabel = document.createElement("label");
    targetLabel.textContent = "目标";
    this.targetSelect = document.createElement("select");
    this.targetSelect.className = "dialog-input";
    this.targetSelect.addEventListener("change", () => {
      this.renderOptions();
      this.schedule();
    });
    targetRow.append(targetLabel, this.targetSelect);

    this.optionsEl = document.createElement("div");
    this.optionsEl.className = "convert-options";
    this.hintEl = document.createElement("p");
    this.hintEl.className = "convert-hint";

    wrap.append(sourceRow, targetRow, this.optionsEl, this.hintEl);
    return wrap;
  }

  private buildPreview(): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "convert-grid";
    const left = document.createElement("div");
    left.className = "convert-pane";
    const leftLabel = document.createElement("div");
    leftLabel.className = "convert-label";
    leftLabel.textContent = "源文本（只读）";
    this.sourcePre = document.createElement("pre");
    this.sourcePre.className = "convert-pre";
    left.append(leftLabel, this.sourcePre);

    const right = document.createElement("div");
    right.className = "convert-pane";
    const rightLabel = document.createElement("div");
    rightLabel.className = "convert-label";
    rightLabel.textContent = "转换结果（只读）";
    this.outputPre = document.createElement("pre");
    this.outputPre.className = "convert-pre convert-out";
    right.append(rightLabel, this.outputPre);
    grid.append(left, right);
    return grid;
  }

  private buildActions(): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    this.replaceBtn = document.createElement("button");
    this.replaceBtn.type = "button";
    this.replaceBtn.className = "primary";
    this.replaceBtn.textContent = this.source?.hasSelection ? "替换选区" : "替换整篇";
    this.replaceBtn.addEventListener("click", () => void this.applyReplace());
    this.insertBtn = document.createElement("button");
    this.insertBtn.type = "button";
    this.insertBtn.textContent = "插入新标签";
    this.insertBtn.addEventListener("click", () => this.applyInsert());
    this.copyBtn = document.createElement("button");
    this.copyBtn.type = "button";
    this.copyBtn.textContent = "复制";
    this.copyBtn.addEventListener("click", () => void this.applyCopy());
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "关闭";
    closeBtn.addEventListener("click", () => this.close());
    actions.append(this.replaceBtn, this.insertBtn, this.copyBtn, closeBtn);
    return actions;
  }

  // ---- 交互 ----

  private currentFormat(): ConvertFormat | null {
    const value = this.sourceSelect.value;
    if (value !== "auto") return value as ConvertFormat;
    return this.source ? detectFormat(this.source.text) : null;
  }

  private targetsFor(format: ConvertFormat | null): ConvertTarget[] {
    if (format === "json") return ["json2yaml", "json2java", "json2ts"];
    if (format === "yaml") return ["yaml2json", "yaml2properties"];
    if (format === "properties") return ["properties2yaml"];
    return [];
  }

  private onSourceChange(): void {
    const format = this.currentFormat();
    const detected = this.source ? detectFormat(this.source.text) : null;
    this.detectHint.textContent = detected
      ? `自动识别：${detected.toUpperCase()}`
      : "无法自动识别，请手动选择";

    const previous = this.targetSelect.value as ConvertTarget;
    const targets = this.targetsFor(format);
    this.targetSelect.innerHTML = "";
    for (const target of targets) {
      this.targetSelect.append(new Option(CONVERT_TARGET_LABELS[target], target));
    }
    if (targets.includes(previous)) this.targetSelect.value = previous;
    this.targetSelect.disabled = targets.length === 0;

    this.renderOptions();
    this.schedule();
  }

  /** 选项区随目标动态重建（值存在 optionValues 里，跨目标保留） */
  private renderOptions(): void {
    const target = this.targetSelect.value as ConvertTarget;
    this.optionsEl.innerHTML = "";
    this.hintEl.textContent = CONVERT_TARGET_HINTS[target] ?? "";
    const specs = CONVERT_OPTION_SPECS[target] ?? [];
    for (const spec of specs) {
      const row = document.createElement("div");
      row.className = "dialog-fields";
      const label = document.createElement("label");
      label.textContent = spec.label;
      if (spec.kind === "boolean") {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(this.optionValues.get(spec.key) ?? spec.defaultValue);
        input.addEventListener("change", () => {
          this.optionValues.set(spec.key, input.checked);
          this.schedule();
        });
        const hint = document.createElement("span");
        hint.className = "convert-detect";
        hint.textContent = spec.hint ?? "";
        row.append(input, label, hint);
      } else if (spec.kind === "select") {
        const select = document.createElement("select");
        select.className = "dialog-input";
        for (const choice of spec.choices ?? []) {
          select.append(new Option(choice.label, choice.value));
        }
        select.value = String(this.optionValues.get(spec.key) ?? spec.defaultValue);
        select.addEventListener("change", () => {
          this.optionValues.set(spec.key, select.value);
          this.schedule();
        });
        row.append(label, select);
      } else {
        const input = document.createElement("input");
        input.className = "dialog-input";
        input.value = String(this.optionValues.get(spec.key) ?? spec.defaultValue);
        input.addEventListener("input", () => {
          this.optionValues.set(spec.key, input.value);
          this.schedule();
        });
        row.append(label, input);
      }
      this.optionsEl.append(row);
    }
  }

  private codegenOptions(): CodegenOptions {
    return {
      className: String(this.optionValues.get("className") ?? "Root"),
      javaStyle: (this.optionValues.get("javaStyle") as "class" | "record") ?? "class",
      javaLombok: Boolean(this.optionValues.get("javaLombok")),
    };
  }

  private schedule(): void {
    // 输入已变化：旧结果立即失效，避免防抖窗口内把上一次目标的结果应用到新选择
    this.result = null;
    this.setActionsEnabled(false);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.recompute();
    }, DEBOUNCE_MS);
  }

  private async recompute(): Promise<void> {
    if (!this.source) return;
    const gen = ++this.generation;
    const target = this.targetSelect.value as ConvertTarget | "";
    const format = this.currentFormat();
    if (!format || !target) {
      this.result = null;
      this.outputPre.textContent = "";
      this.setError("无法识别源格式，请在上方手动选择");
      this.setActionsEnabled(false);
      return;
    }
    this.setBusy(true);
    try {
      let result: string;
      if (target === "json2java" || target === "json2ts") {
        result = jsonToCode(
          parseJsonText(this.source.text),
          target === "json2java" ? "java" : "ts",
          this.codegenOptions(),
        );
      } else {
        const opts: ConvertOptions = {
          inferScalarTypes: Boolean(this.optionValues.get("inferScalarTypes")),
        };
        result = await convert(this.source.text, target as ConvertKind, opts);
      }
      if (gen !== this.generation) return;
      this.result = result;
      this.outputPre.textContent = result;
      this.setError("");
      this.setActionsEnabled(true);
    } catch (e) {
      if (gen !== this.generation) return;
      this.result = null;
      this.outputPre.textContent = "";
      const message =
        e instanceof ConvertError || e instanceof Error ? e.message : String(e);
      this.setError(message);
      this.setActionsEnabled(false);
    } finally {
      if (gen === this.generation) this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    if (busy) {
      this.setActionsEnabled(false);
      return;
    }
    this.setActionsEnabled(this.result !== null);
  }

  private setActionsEnabled(enabled: boolean): void {
    const canWrite = enabled && !this.source?.readonly;
    this.replaceBtn.disabled = !canWrite;
    this.replaceBtn.title = this.source?.readonly ? "只读文件不可替换" : "";
    this.insertBtn.disabled = !enabled;
    this.copyBtn.disabled = !enabled;
  }

  private setError(text: string): void {
    this.errorEl.textContent = text;
    this.errorEl.classList.toggle("hidden", !text);
  }

  private async applyReplace(): Promise<void> {
    if (!this.source || !this.result || this.source.readonly) return;
    if (this.source.lineCount > CONFIRM_LINES) {
      const ok = await confirmAction(
        `文档超过 ${CONFIRM_LINES} 行，转换结果替换可能耗时较久，继续？`,
      );
      if (!ok) return;
    }
    const result = this.result;
    const source = this.source;
    if (this.deps.replace(result, source)) this.close();
  }

  private applyInsert(): void {
    if (!this.result) return;
    const target = this.targetSelect.value as ConvertTarget;
    this.deps.insertAsTab(this.result, target);
    this.close();
  }

  private async applyCopy(): Promise<void> {
    if (!this.result) return;
    try {
      await navigator.clipboard.writeText(this.result);
      this.deps.showMessage(`已复制转换结果（${targetExtension(this.targetSelect.value as ConvertTarget)}）`);
    } catch {
      this.deps.showMessage("复制失败：剪贴板不可用");
    }
  }
}
