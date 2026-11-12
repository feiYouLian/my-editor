/**
 * 灵活比较工作台：两侧各自选来源（当前标签 / 打开的文件 / 磁盘文件 / 剪贴板 / 空文本），
 * 内容在文本框里可直接编辑，停顿后自动重算差异。
 *
 * 分层：本模块只做 UI 与比较编排，取内容 / 读文件 / 读剪贴板 / 调 diff 全部经 deps 注入；
 * 差异行的渲染复用 diffPanel/render，与只读差异面板保持一致。
 */

import { firstLine } from "../core/errors";
import { confirmAction } from "../ui/dialogs";
import { gapStarts, renderDiffRows } from "./diffPanel/render";
import type { DiffPayload } from "./diffPanel/types";

export interface CompareContent {
  label: string;
  text: string;
}

export interface CompareTabInfo {
  id: string;
  label: string;
}

export interface CompareWorkbenchDeps {
  /** 当前激活标签的最新内容（含未保存）；没有可比较的文本标签时返回 null */
  activeContent: () => CompareContent | null;
  /** 编辑器里当前选中的文本（只比较某个方法 / 代码块用）；无选区返回 null */
  activeSelection: () => CompareContent | null;
  /** 当前标签的磁盘版本（「修改前 ⇄ 修改后」的另一侧）；未命名 / 无文件返回 null */
  activeDiskContent: () => Promise<CompareContent | null>;
  /** 可选的已打开标签（虚拟大文件已在装配层过滤） */
  listTabs: () => CompareTabInfo[];
  tabContent: (id: string) => CompareContent | null;
  /** 系统文件选择器；取消返回 null */
  pickFile: () => Promise<string | null>;
  readFile: (path: string) => Promise<CompareContent>;
  readClipboard: () => Promise<string>;
  computeDiff: (left: CompareContent, right: CompareContent) => Promise<DiffPayload>;
  /** 写入系统剪贴板；成功返回 true */
  copyText: (text: string) => Promise<boolean>;
  showMessage: (text: string, durationMs?: number) => void;
}

type CompareSource =
  | { kind: "active" }
  | { kind: "selection" }
  | { kind: "disk" }
  | { kind: "tab"; id: string }
  | { kind: "clipboard" }
  | { kind: "blank" }
  | { kind: "file"; path: string };

interface SideState {
  root: HTMLElement;
  select: HTMLSelectElement;
  note: HTMLElement;
  textarea: HTMLTextAreaElement;
  source: CompareSource;
  /** 载入时的原文，用于判断这一侧是否被编辑过 */
  loaded: string;
  label: string;
  /** 最近一次成功应用的 select 值，切换失败时回退 */
  value: string;
}

/** 输入停顿后自动比较的间隔 */
const AUTO_COMPARE_MS = 450;

function makeButton(label: string, title: string, wide = true): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = wide ? "df-btn df-btn-wide" : "df-btn";
  button.textContent = label;
  button.title = title;
  return button;
}

function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

export class CompareWorkbench {
  private backdrop: HTMLElement | null = null;
  private dialog: HTMLElement | null = null;
  private left!: SideState;
  private right!: SideState;
  private body!: HTMLElement;
  private stats!: HTMLElement;
  private navInfo!: HTMLElement;
  private note!: HTMLElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private payload: DiffPayload | null = null;
  private expandedGaps = new Set<number>();
  private currentHunk = -1;
  private pendingHunk: number | null = null;
  private renderToken = 0;
  private compareSeq = 0;
  private compareRunning = false;
  private compareQueued = false;
  private compareTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: CompareWorkbenchDeps) {}

  /** 打开工作台；leftTabId 用于从某个标签直接带入左侧内容 */
  open(prefill: { leftTabId?: string } = {}): void {
    this.close();
    this.payload = null;
    this.expandedGaps.clear();
    this.currentHunk = -1;
    this.pendingHunk = null;

    const backdrop = document.createElement("div");
    backdrop.className = "diff-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "diff-dialog compare-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "灵活比较");

    // ---- 头部 ----
    const head = document.createElement("div");
    head.className = "diff-head";
    const title = document.createElement("div");
    title.className = "diff-title";
    title.textContent = "灵活比较";
    title.title = "两侧内容都可编辑；停顿后自动重新比较";

    this.stats = document.createElement("div");
    this.stats.className = "diff-stats";
    this.navInfo = document.createElement("span");
    this.navInfo.className = "df-nav-info";

    this.prevBtn = makeButton("▲", "上一处差异", false);
    this.prevBtn.addEventListener("click", () => this.gotoHunk(-1));
    this.nextBtn = makeButton("▼", "下一处差异", false);
    this.nextBtn.addEventListener("click", () => this.gotoHunk(1));

    const wrapBtn = makeButton("换行", "长行换行显示 / 溢出裁剪");
    wrapBtn.classList.add("active");
    wrapBtn.addEventListener("click", () => {
      const on = this.body.classList.toggle("df-wrap");
      wrapBtn.classList.toggle("active", on);
    });

    const expandBtn = makeButton("展开全部", "展开所有未变动区段");
    expandBtn.addEventListener("click", () => {
      if (this.payload) for (const gap of gapStarts(this.payload.rows)) this.expandedGaps.add(gap);
      this.renderRows();
    });

    const compareBtn = makeButton("重新比较", "立即按两侧当前内容重算差异");
    compareBtn.addEventListener("click", () => void this.compare());

    const patchBtn = makeButton("复制补丁", "把当前差异复制为统一 diff 补丁");
    patchBtn.addEventListener("click", () => void this.copyPatch());

    const closeBtn = makeButton("✕", "关闭（Esc）", false);
    closeBtn.setAttribute("aria-label", "关闭灵活比较");
    closeBtn.addEventListener("click", () => this.close());

    const helpBtn = makeButton("?", "两侧来源与自动比较说明", false);
    helpBtn.addEventListener("click", () => {
      this.deps.showMessage(
        "两侧都可以选来源或直接输入/粘贴；编辑停顿约半秒后自动重新比较，也可以点「重新比较」",
        6000,
      );
    });

    head.append(
      title,
      this.stats,
      this.navInfo,
      this.prevBtn,
      this.nextBtn,
      wrapBtn,
      expandBtn,
      compareBtn,
      patchBtn,
      helpBtn,
      closeBtn,
    );

    // ---- 两侧来源 + 可编辑内容 ----
    const sources = document.createElement("div");
    sources.className = "compare-sources";
    this.left = this.buildSide("left");
    this.right = this.buildSide("right");
    sources.append(this.left.root, this.right.root);

    // ---- 差异结果 ----
    this.body = document.createElement("div");
    this.body.className = "diff-body df-wrap";
    this.note = document.createElement("div");
    this.note.className = "diff-note";
    this.note.textContent = "选择两侧来源，或直接在文本框里输入 / 粘贴内容";

    dialog.append(head, sources, this.body, this.note);
    backdrop.append(dialog);
    document.body.append(backdrop);
    this.backdrop = backdrop;
    this.dialog = dialog;

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      this.close();
    });
    dialog.tabIndex = -1;
    dialog.focus();

    // ---- 初始内容：左侧当前标签（或指定标签），右侧空文本 ----
    const initial: { source: CompareSource; content: CompareContent | null } = prefill.leftTabId
      ? {
          source: { kind: "tab", id: prefill.leftTabId },
          content: this.deps.tabContent(prefill.leftTabId),
        }
      : { source: { kind: "active" }, content: this.deps.activeContent() };
    if (initial.content) {
      this.applyContent(this.left, initial.source, initial.content);
      this.left.select.value =
        initial.source.kind === "tab" ? `tab:${initial.source.id}` : "active";
      this.left.value = this.left.select.value;
    } else {
      this.left.select.value = "blank";
      this.left.value = "blank";
    }
    this.right.select.value = "blank";
    this.right.value = "blank";
    this.applyContent(this.right, { kind: "blank" }, { label: "空文本", text: "" });
    this.syncNav();
    this.right.textarea.focus();
    this.compareOnOpen();
  }

  /**
   * 打开时不急着比较：左侧往往已带入当前文件、右侧还是空的，
   * 立刻算会把整个文件显示成「全删」，看起来像误操作。
   * 有一侧为空就先给提示，等用户填上内容或点「重新比较」再算。
   */
  private compareOnOpen(): void {
    const left = this.left.textarea.value;
    const right = this.right.textarea.value;
    if (left.length === 0 && right.length === 0) {
      this.setNote("两侧都为空：选择来源或直接输入内容后自动比较");
      return;
    }
    if (left.length === 0 || right.length === 0) {
      this.setNote("有一侧为空：填上内容后自动比较，也可以点「重新比较」强制比较");
      return;
    }
    void this.compare();
  }

  close(): void {
    this.renderToken++;
    this.compareSeq++;
    if (this.compareTimer) clearTimeout(this.compareTimer);
    this.compareTimer = null;
    this.backdrop?.remove();
    this.backdrop = null;
    this.dialog = null;
    this.payload = null;
  }

  // ---- 两侧来源 ----

  private buildSide(kind: "left" | "right"): SideState {
    const root = document.createElement("section");
    root.className = "compare-side";

    const head = document.createElement("div");
    head.className = "compare-side-head";
    const sideTitle = textSpan(
      "compare-side-title",
      kind === "left" ? "左侧（原内容）" : "右侧（新内容）",
    );
    const select = document.createElement("select");
    select.className = "compare-source";
    select.title = "这一侧的内容来源";
    this.fillSourceOptions(select);
    const note = textSpan("compare-source-note", "");
    const resetBtn = makeButton("重置", "丢弃本侧编辑，重新从当前来源读取");
    const copyBtn = makeButton("复制", "复制本侧全文到剪贴板");
    head.append(sideTitle, select, note, resetBtn, copyBtn);

    const textarea = document.createElement("textarea");
    textarea.className = "compare-text";
    textarea.spellcheck = false;
    textarea.wrap = "off";
    textarea.placeholder =
      kind === "left" ? "选择来源，或直接输入 / 粘贴内容…" : "直接输入 / 粘贴要比较的内容…";
    textarea.addEventListener("input", () => this.scheduleCompare());

    const side: SideState = {
      root,
      select,
      note,
      textarea,
      source: { kind: "blank" },
      loaded: "",
      label: "空文本",
      value: "blank",
    };
    select.addEventListener("change", () => void this.changeSource(side));
    resetBtn.addEventListener("click", () => void this.reloadSide(side));
    copyBtn.addEventListener("click", () => void this.copySide(side));
    root.append(head, textarea);
    return side;
  }

  private fillSourceOptions(select: HTMLSelectElement): void {
    const add = (value: string, label: string): void => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    };
    add("active", "当前标签（含未保存）");
    add("selection", "当前选区（如有）");
    add("disk", "磁盘版本（当前文件）");
    for (const tab of this.deps.listTabs()) add(`tab:${tab.id}`, `标签 · ${tab.label}`);
    add("clipboard", "剪贴板");
    add("file", "磁盘文件…");
    add("blank", "空文本");
  }

  private async changeSource(side: SideState): Promise<void> {
    const value = side.select.value;
    let source: CompareSource | null;
    try {
      source = await this.parseSource(value);
    } catch (e) {
      side.select.value = side.value;
      this.deps.showMessage(firstLine(e));
      return;
    }
    // 选文件时用户可能取消：保持原来源，不打扰
    if (!source) {
      side.select.value = side.value;
      return;
    }
    if (this.isEdited(side)) {
      const ok = await confirmAction("切换来源会覆盖这一侧已编辑的内容，继续？", "覆盖");
      if (!ok) {
        side.select.value = side.value;
        return;
      }
    }
    try {
      const content = await this.loadSource(source);
      this.applyContent(side, source, content);
      if (source.kind === "file") {
        // 记住选过的文件：再次选择「磁盘文件…」才会重新弹选择器
        const fileValue = `file:${source.path}`;
        this.ensureFileOption(side.select, fileValue, content.label);
        side.select.value = fileValue;
        side.value = fileValue;
      }
      this.scheduleCompare(0);
    } catch (e) {
      side.select.value = side.value;
      this.deps.showMessage(`读取内容失败：${firstLine(e)}`);
    }
  }

  private async parseSource(value: string): Promise<CompareSource | null> {
    if (value === "active") return { kind: "active" };
    if (value === "selection") return { kind: "selection" };
    if (value === "disk") return { kind: "disk" };
    if (value === "clipboard") return { kind: "clipboard" };
    if (value === "blank") return { kind: "blank" };
    if (value.startsWith("tab:")) return { kind: "tab", id: value.slice(4) };
    if (value.startsWith("file:")) return { kind: "file", path: value.slice(5) };
    if (value === "file") {
      const path = await this.deps.pickFile();
      return path ? { kind: "file", path } : null;
    }
    throw new Error("未知来源");
  }

  private ensureFileOption(select: HTMLSelectElement, value: string, label: string): void {
    let option = Array.from(select.options).find((item) => item.value === value);
    if (!option) {
      option = document.createElement("option");
      option.value = value;
      // 插在「磁盘文件…」后面，保持固定项的顺序
      const trigger = Array.from(select.options).find((item) => item.value === "file");
      select.insertBefore(option, trigger?.nextSibling ?? null);
    }
    option.textContent = label;
  }

  private async loadSource(source: CompareSource): Promise<CompareContent> {
    switch (source.kind) {
      case "active": {
        const content = this.deps.activeContent();
        if (!content) throw new Error("当前没有可比较的文本标签");
        return content;
      }
      case "selection": {
        const content = this.deps.activeSelection();
        if (!content) throw new Error("当前没有选中内容，请先在编辑器里选中要比较的代码块");
        return content;
      }
      case "disk": {
        const content = await this.deps.activeDiskContent();
        if (!content) throw new Error("当前文件不在磁盘上（未命名或尚未保存）");
        return content;
      }
      case "tab": {
        const content = this.deps.tabContent(source.id);
        if (!content) throw new Error("该标签已关闭或不是文本文件");
        return content;
      }
      case "clipboard": {
        const text = await this.deps.readClipboard();
        return { label: "剪贴板", text };
      }
      case "file":
        return this.deps.readFile(source.path);
      case "blank":
        return { label: "空文本", text: "" };
    }
  }

  private applyContent(side: SideState, source: CompareSource, content: CompareContent): void {
    side.source = source;
    side.loaded = content.text;
    side.label = content.label;
    side.textarea.value = content.text;
    side.note.textContent = content.label;
    side.note.title = content.label;
    side.value = side.select.value;
  }

  private isEdited(side: SideState): boolean {
    return side.textarea.value !== side.loaded;
  }

  private async reloadSide(side: SideState): Promise<void> {
    if (this.isEdited(side)) {
      const ok = await confirmAction("重置会丢弃这一侧的编辑，继续？", "重置");
      if (!ok) return;
    }
    try {
      const content = await this.loadSource(side.source);
      this.applyContent(side, side.source, content);
      this.scheduleCompare(0);
    } catch (e) {
      this.deps.showMessage(`读取内容失败：${firstLine(e)}`);
    }
  }

  private async copySide(side: SideState): Promise<void> {
    const ok = await this.deps.copyText(side.textarea.value);
    this.deps.showMessage(ok ? "已复制这一侧的内容" : "复制失败：剪贴板不可用");
  }

  private async copyPatch(): Promise<void> {
    if (!this.payload) return;
    const ok = await this.deps.copyText(this.payload.patch);
    this.deps.showMessage(ok ? "已复制统一 diff 补丁" : "复制失败：剪贴板不可用");
  }

  // ---- 比较 ----

  private scheduleCompare(delay = AUTO_COMPARE_MS): void {
    if (this.compareTimer) clearTimeout(this.compareTimer);
    this.compareTimer = setTimeout(() => {
      this.compareTimer = null;
      void this.compare();
    }, delay);
  }

  private async compare(): Promise<void> {
    if (!this.dialog) return;
    if (this.compareRunning) {
      this.compareQueued = true;
      return;
    }
    this.compareRunning = true;
    const seq = ++this.compareSeq;
    this.setNote("比较中…");
    try {
      const payload = await this.deps.computeDiff(
        { label: this.left.label, text: this.left.textarea.value },
        { label: this.right.label, text: this.right.textarea.value },
      );
      if (seq !== this.compareSeq || !this.dialog) return;
      this.applyPayload(payload);
    } catch (e) {
      if (seq === this.compareSeq && this.dialog) this.setNote(`比较失败：${firstLine(e)}`);
    } finally {
      this.compareRunning = false;
      if (this.compareQueued) {
        this.compareQueued = false;
        void this.compare();
      }
    }
  }

  private applyPayload(payload: DiffPayload): void {
    this.payload = payload;
    this.currentHunk = payload.hunks.length ? 0 : -1;
    this.expandedGaps.clear();
    this.stats.replaceChildren(
      textSpan("df-add", `+${payload.added}`),
      textSpan("df-del", `-${payload.removed}`),
    );
    this.syncNav();
    this.setNote(
      payload.identical
        ? "两侧内容完全一致"
        : payload.newlineNormalized
          ? "红底为删除 / 修改，绿底为新增 / 修改后（行尾差异 CRLF / LF 已忽略）"
          : "红底为删除 / 修改，绿底为新增 / 修改后；两侧文本框可直接编辑",
    );
    this.renderRows();
  }

  private setNote(text: string): void {
    this.note.textContent = text;
  }

  private renderRows(): void {
    const payload = this.payload;
    if (!payload || !this.body) return;
    const token = ++this.renderToken;
    const scrollTop = this.body.scrollTop;
    renderDiffRows({
      body: this.body,
      payload,
      expandedGaps: this.expandedGaps,
      onExpandGap: (start) => {
        this.expandedGaps.add(start);
        this.renderRows();
      },
      token,
      isStale: (t) => t !== this.renderToken,
      onDone: () => {
        if (this.pendingHunk !== null) {
          const index = this.pendingHunk;
          this.pendingHunk = null;
          this.scrollToHunk(index);
        } else {
          this.body.scrollTop = scrollTop;
        }
      },
    });
  }

  private syncNav(): void {
    if (!this.payload) {
      this.navInfo.textContent = "待比较";
      this.prevBtn.disabled = true;
      this.nextBtn.disabled = true;
      return;
    }
    const total = this.payload.hunks.length;
    this.navInfo.textContent = total === 0 ? "无差异" : `第 ${this.currentHunk + 1} / ${total} 处`;
    this.prevBtn.disabled = total === 0;
    this.nextBtn.disabled = total === 0;
  }

  private gotoHunk(delta: number): void {
    const hunks = this.payload?.hunks ?? [];
    if (hunks.length === 0) return;
    this.currentHunk = (this.currentHunk + delta + hunks.length) % hunks.length;
    this.scrollToHunk(this.currentHunk);
  }

  private scrollToHunk(index: number): void {
    const hunk = this.payload?.hunks[index];
    if (!hunk) return;
    this.currentHunk = index;
    this.syncNav();
    const target = this.body.querySelector<HTMLElement>(`[data-hunk="${index}"]`);
    if (target) {
      this.pendingHunk = null;
      target.scrollIntoView({ block: "center" });
      return;
    }
    // 行是分帧渲染的：目标尚未构建时等 onDone 再跳
    this.pendingHunk = index;
  }
}
