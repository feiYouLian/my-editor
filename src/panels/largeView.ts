/**
 * 大文件只读虚拟视图（控制器）：只渲染视口 ±PADDING_LINES 的行，
 * 行内容按窗口从后端拉取；支持整文件过滤（流式批次）与缩略图密度。
 *
 * 分层：DOM 骨架在 largeView/dom.ts，行缓存在 largeView/lineCache.ts，
 * 缩略图绘制在 largeView/minimap.ts，本文件只做虚拟化与交互编排。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DEFAULT_PADDING_LINES,
  ENCODINGS,
  LINE_HEIGHT,
  MINIMAP_BUCKETS,
} from "./largeView/constants";
import { buildLargeViewDom, type LargeViewDom } from "./largeView/dom";
import { LineCache, coalesceLines } from "./largeView/lineCache";
import { MatchBuffer } from "./largeView/matchBuffer";
import { drawMinimap } from "./largeView/minimap";
import type {
  FilterBatch,
  FilterResult,
  IndexReady,
  LargeFileInfo,
  LargeRefresh,
  LineWindow,
} from "./largeView/types";
import { firstLine } from "../core/errors";
import { confirmAction } from "../ui/dialogs";
import { showErrorCard, showResultCard } from "../ui/resultCard";
import { showHelpDialog } from "./helpDialog";

export type { LargeFileInfo } from "./largeView/types";

export interface LargeViewDeps {
  onMessage: (text: string) => void;
  /** 逃生门：改用编辑器打开 */
  onOpenInEditor: (info: LargeFileInfo) => void;
  /**
   * 索引完成后的真实总行数：虚拟视图自己不再展示"名字·体积·行数"，
   * 一律交给状态栏，所以这里必须把最新行数回报给上层。
   */
  onTotalLines?: (totalLines: number, newline: string) => void;
}

export class LargeView {
  private info: LargeFileInfo | null = null;
  /** 过滤命中行号（Uint32Array 定长缓冲，上限与后端 MAX_FILTER_MATCHES 一致） */
  private readonly matchBuf = new MatchBuffer();
  /** 超长行裁剪提示只提示一次（每次打开视图重置） */
  private clampWarned = false;
  private density: number[] = [];
  private readonly cache = new LineCache();
  private caseOn = false;
  private regexOn = false;
  private loading = false;
  /** 自动换行：长日志行折行显示（关掉时靠横向滚动查看完整内容） */
  private wrapOn = false;
  /** 跟随文件尾部：每秒查一次文件大小，增长时续扫索引并刷新尾窗 */
  private followOn = false;
  private followTimer: ReturnType<typeof setInterval> | null = null;
  /** 上一轮续扫未返回时不再叠加请求 */
  private followBusy = false;
  /** 程序化贴底滚动期间忽略"离开底部"判定，避免刷新瞬间自己把自己暂停 */
  private programmaticScroll = false;
  /** 当前选中的原始行号（0 基），用于复制行 */
  private selectedLine: number | null = null;
  /** 已见最长行字符数：决定横向滚动宽度，只增不减以避免滚动条抖动 */
  private maxLineChars = 0;
  /** 等宽字符宽度（px）：懒测量，用于算横向滚动宽度 */
  private charWidth = 0;
  private paddingLines = DEFAULT_PADDING_LINES;
  private rafId = 0;
  private unlisteners: Array<() => void> = [];

  private el!: LargeViewDom;

  /** 当前过滤请求号：用于丢弃上一次过滤迟到的批次 */
  private filterRequestId = 0;
  /** 已收尾的请求号：批次末条与命令返回都可能先到 */
  private filterFinishedId = -1;
  /** 流式刷新节流时间戳 */
  private lastStreamRefresh = 0;
  /** 应用主题切换观察器：缩略图颜色取自 CSS 变量，需要主动重绘 */
  private themeObserver: MutationObserver | null = null;

  constructor(private host: HTMLElement, private deps: LargeViewDeps) {
    this.mount();
  }

  private mount(): void {
    const el = buildLargeViewDom(this.host);
    this.el = el;

    el.helpBtn.addEventListener("click", () => showHelpDialog("guide", "看一个大日志"));

    // ---- 事件 ----
    el.scrollEl.addEventListener(
      "scroll",
      () => {
        this.pauseFollowIfScrolledUp();
        this.scheduleLoad();
      },
      { passive: true },
    );
    el.followBtn.addEventListener("click", () => this.toggleFollow());
    el.filterBtn.addEventListener("click", () => void this.runFilter());
    el.clearBtn.addEventListener("click", () => void this.clearFilter());
    el.copyMatchesBtn.addEventListener("click", () => void this.copyMatches());
    el.exportMatchesBtn.addEventListener("click", () => void this.exportMatches());
    el.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.runFilter();
      }
    });
    el.wrapBtn.addEventListener("click", () => this.toggleWrap());
    el.gotoBtn.addEventListener("click", () => this.goToLine(Number(this.el.gotoInput.value)));
    el.gotoInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.goToLine(Number(this.el.gotoInput.value));
      }
    });
    el.copyBtn.addEventListener("click", () => this.copySelectedLine());
    el.encodingSelect.addEventListener("change", () => void this.changeEncoding());
    el.editorBtn.addEventListener("click", () => {
      if (this.info) this.deps.onOpenInEditor(this.info);
    });
    el.canvas.addEventListener("click", (e) => {
      const rect = el.canvas.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
      const total = this.virtualCount();
      el.scrollEl.scrollTop = ratio * total * LINE_HEIGHT - el.scrollEl.clientHeight / 2;
      this.scheduleLoad();
    });

    // 主题切换不产生滚动/渲染事件：观察 data-theme 后重绘，避免沿用旧主题配色
    if (typeof MutationObserver === "function") {
      this.themeObserver = new MutationObserver(() => this.drawMinimap());
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }

    // 大小写 / 正则开关（互斥样式，各自独立状态）
    const wireToggle = (btn: HTMLButtonElement, isOn: () => boolean): void => {
      btn.addEventListener("click", () => {
        if (btn === el.caseBtn) this.caseOn = !this.caseOn;
        else this.regexOn = !this.regexOn;
        btn.classList.toggle("active", isOn());
      });
    };
    wireToggle(el.caseBtn, () => this.caseOn);
    wireToggle(el.regexBtn, () => this.regexOn);
  }

  // ---- 生命周期 ----

  /** 重建编码下拉：只提供单字节候选；当前编码若不在列表（如 UTF-16）加一条禁用的展示项 */
  private syncEncodingOptions(current: string): void {
    const select = this.el.encodingSelect;
    select.innerHTML = "";
    for (const name of ENCODINGS) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.append(opt);
    }
    if (!ENCODINGS.includes(current)) {
      const opt = document.createElement("option");
      opt.value = current;
      opt.textContent = `${current}（不支持切换）`;
      opt.disabled = true;
      select.append(opt);
    }
    select.value = current;
  }

  async open(info: LargeFileInfo, paddingLines = DEFAULT_PADDING_LINES): Promise<void> {
    void this.cancel();
    // 换文件时复位跟随：上一个日志的"正在跟随"不该带到新文件上
    this.setFollow(false);
    this.info = info;
    this.filterRequestId++;
    this.filterFinishedId = -1;
    this.paddingLines = Math.max(0, paddingLines);
    this.matchBuf.reset();
    this.density = [];
    this.cache.clear();
    this.host.classList.remove("hidden");
    // 标题按文件类型区分：.log 显示“日志视图”，其余大文件统称“大文件视图”
    this.el.titleEl.textContent = /\.log$/i.test(info.path) ? "日志视图" : "大文件视图";
    this.syncEncodingOptions(info.encoding);
    this.el.filterInput.value = "";
    // 换行开关是会话级偏好（跨文件保留），但"最长行"必须按新文件重算
    this.maxLineChars = 0;
    this.el.rowsEl.style.width = "";
    this.host.classList.toggle("lv-wrap", this.wrapOn);
    this.el.wrapBtn.classList.toggle("on", this.wrapOn);
    this.updateIndexHint();
    this.el.scrollEl.scrollTop = 0;
    this.selectedLine = null;

    await this.ensureListeners();
    void this.loadDensity();
    await this.loadWindow();
  }

  close(): void {
    this.setFollow(false);
    this.info = null;
    this.selectedLine = null;
    this.filterRequestId++;
    this.filterFinishedId = -1;
    this.matchBuf.reset();
    this.cache.clear();
    this.clampWarned = false;
    this.host.classList.add("hidden");
  }

  /**
   * 退出 / 重载界面前释放：解除全局事件订阅与主题观察器。
   * 与 close() 分开——close() 只复位视图状态（切标签后还会再 open），
   * 事件订阅必须留着，否则切回来收不到索引进度与过滤批次。
   */
  dispose(): void {
    this.close();
    for (const un of this.unlisteners) un();
    this.unlisteners.length = 0;
    this.themeObserver?.disconnect();
    this.themeObserver = null;
  }

  /**
   * 后端把超长行裁到 4000 字符并补 `…`。不说明的话，用户会以为文件内容就到这里
   * （「行尾怎么少了一截」）。只提示一次，避免滚动时反复刷屏。
   */
  private noteClampedLine(win: LineWindow): void {
    if (!win.truncatedLines || this.clampWarned) return;
    this.clampWarned = true;
    this.deps.onMessage(
      "部分超长行已裁剪显示（单行最多 4000 字符），完整内容请用「以编辑器打开」查看",
    );
  }

  private async ensureListeners(): Promise<void> {
    if (this.unlisteners.length) return;
    this.unlisteners.push(
      await listen<{ id: string; scanned: number; total: number; lines: number }>(
        "large://index-progress",
        (e) => {
          if (e.payload.id !== this.info?.id) return;
          const pct = e.payload.total
            ? Math.round((e.payload.scanned / e.payload.total) * 100)
            : 0;
          this.el.indexEl.textContent = `索引建立中 ${pct}%`;
        },
      ),
    );
    this.unlisteners.push(
      await listen<IndexReady>("large://index-ready", (e) => {
        if (!this.info || e.payload.id !== this.info.id) return;
        this.info.totalLines = e.payload.totalLines;
        this.info.newline = e.payload.newline;
        this.info.complete = true;
        this.info.indexedBytes = this.info.size;
        this.el.indexEl.textContent = "";
        this.deps.onTotalLines?.(this.info.totalLines, this.info.newline);
        void this.loadDensity();
        this.resizeSpacer();
        void this.loadWindow();
      }),
    );
    this.unlisteners.push(
      await listen<{ id: string; scanned: number; total: number; matches: number }>(
        "large://filter-progress",
        (e) => {
          if (e.payload.id !== this.info?.id) return;
          const pct = e.payload.total
            ? Math.round((e.payload.scanned / e.payload.total) * 100)
            : 0;
          this.el.statusEl.textContent = `过滤中 ${pct}%（已命中 ${e.payload.matches} 行）`;
        },
      ),
    );
    this.unlisteners.push(
      await listen<FilterBatch>("large://filter-batch", (e) => {
        const p = e.payload;
        if (!this.info || p.id !== this.info.id) return;
        if (p.requestId !== this.filterRequestId) return;
        this.applyFilterBatch(p);
      }),
    );
  }

  /** 流式批次：追加命中行，首批到达即先渲染；末批收尾 */
  private applyFilterBatch(p: FilterBatch): void {
    // 命令返回可能晚于末批事件：已收尾后到达的批次不得再追加，否则重复计行
    if (this.filterFinishedId === p.requestId) return;
    // 取消：整批结果作废。必须在 append 之前判断——块内检查点会让取消落在
    // 批次中间，先追加再判断就会留下「已中止 + 仍按半截命中虚拟化」的矛盾视图
    if (p.cancelled) {
      this.finishCancelled(p.requestId);
      return;
    }
    // 上限由 MatchBuffer 内部裁剪：Uint32Array 定长，不能像 number[] 那样 push
    this.matchBuf.append(p.matches);
    if (!p.done) {
      this.el.statusEl.textContent = `过滤中…（已命中 ${this.matchBuf.length} 行）`;
      // 用户停在顶部时优先刷新首批结果，节流避免每批都读盘
      const now = performance.now();
      if (
        p.matches.length > 0 &&
        this.el.scrollEl.scrollTop <= 1 &&
        now - this.lastStreamRefresh > 200
      ) {
        this.lastStreamRefresh = now;
        void this.loadWindow();
      }
      return;
    }
    this.filterFinishedId = p.requestId;
    this.deps.onMessage(
      p.truncated
        ? `过滤命中已达上限，仅保留前 ${this.matchBuf.length} 行`
        : `过滤命中 ${this.matchBuf.length} 行`,
    );
    void this.loadWindow();
    this.drawMinimap();
  }

  /**
   * 取消收尾：结果集作废、回到未过滤全文。
   * 末批事件与命令返回谁先到都会走这里，幂等（重复调用只认第一次）。
   */
  private finishCancelled(requestId: number): void {
    if (this.filterFinishedId === requestId) return;
    this.filterFinishedId = requestId;
    this.matchBuf.reset();
    this.cache.clear();
    this.deps.onMessage("过滤已中止，已恢复显示全部行");
    void this.loadWindow();
    this.drawMinimap();
  }

  private updateIndexHint(): void {
    const info = this.info;
    if (!info) return;
    if (info.complete) {
      this.el.indexEl.textContent = "";
      return;
    }
    const pct = info.size ? Math.round((info.indexedBytes / info.size) * 100) : 0;
    this.el.indexEl.textContent = `索引建立中 ${pct}%`;
  }

  // ---- 虚拟化 ----

  /** 当前可滚动的条目数：过滤模式为命中数，否则为总行数 */
  private virtualCount(): number {
    if (this.matchBuf.active) return this.matchBuf.length;
    return this.info?.totalLines ?? 0;
  }

  /** 虚拟条目下标 → 原始行号 */
  private lineOf(index: number): number {
    if (this.matchBuf.active) return this.matchBuf.at(index);
    return index;
  }

  private resizeSpacer(): void {
    this.el.spacerEl.style.height = `${this.virtualCount() * LINE_HEIGHT}px`;
  }

  private scheduleLoad(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      void this.loadWindow();
      this.drawMinimap();
    });
  }

  /** 跳转到指定行（1 基）；过滤模式下跳到第一个命中行号 >= 目标的位置 */
  private goToLine(line: number): void {
    if (!this.info) return;
    if (!Number.isFinite(line) || line < 1) {
      this.deps.onMessage("请输入大于 0 的行号");
      return;
    }
    let index = line - 1;
    if (this.matchBuf.active) {
      const matches = this.matchBuf.view();
      if (!matches || matches.length === 0) {
        this.deps.onMessage("当前过滤没有命中行");
        return;
      }
      index = -1;
      for (let i = 0; i < matches.length; i += 1) {
        if (this.lineOf(i) + 1 >= line) {
          index = i;
          break;
        }
      }
      if (index < 0) index = matches.length - 1;
    } else if (line > this.virtualCount()) {
      this.deps.onMessage(`行号超出范围（共 ${this.virtualCount()} 行）`);
      return;
    }
    this.el.scrollEl.scrollTop = Math.max(
      0,
      index * LINE_HEIGHT - this.el.scrollEl.clientHeight / 2,
    );
    this.scheduleLoad();
    this.el.gotoInput.value = "";
  }

  /** 复制选中行：行内容已在缓存（点击行时可见），无需再次读盘 */
  private copySelectedLine(): void {
    if (this.selectedLine === null) {
      this.deps.onMessage("请先点击要复制的行");
      return;
    }
    const text = this.cache.get(this.selectedLine) ?? "";
    if (!text) {
      this.deps.onMessage("该行内容尚未载入，请稍后再试");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => this.deps.onMessage(`已复制第 ${this.selectedLine! + 1} 行`),
      () => this.deps.onMessage("复制失败"),
    );
  }

  private async loadWindow(): Promise<void> {
    const info = this.info;
    if (!info || this.loading) return;
    const total = this.virtualCount();
    this.resizeSpacer();
    if (total === 0) {
      this.el.rowsEl.innerHTML = "";
      this.el.statusEl.textContent = this.matchBuf.active ? "没有匹配的行" : "空文件";
      return;
    }

    const firstVisible = Math.floor(this.el.scrollEl.scrollTop / LINE_HEIGHT);
    // 换行模式下行会变高：少渲染一些行，避免一屏内容溢出到视口外太远
    const perLine = this.wrapOn ? LINE_HEIGHT * 2.5 : LINE_HEIGHT;
    const visibleCount = Math.ceil(this.el.scrollEl.clientHeight / perLine) + 2;
    const pad = this.wrapOn ? 0 : this.paddingLines;

    const matches = this.matchBuf.view();
    if (matches) {
      const overscan = this.wrapOn ? 4 : 40;
      const from = Math.max(0, firstVisible - overscan);
      const to = Math.min(matches.length, firstVisible + visibleCount + overscan);
      // 局部数组只覆盖视口附近的行，不影响常驻内存
      const missing: number[] = [];
      for (let i = from; i < to; i += 1) {
        const ln = matches[i];
        if (!this.cache.has(ln)) missing.push(ln);
      }
      if (missing.length) {
        this.loading = true;
        try {
          await this.fetchLines(missing);
        } finally {
          this.loading = false;
        }
      }
      this.renderRows(from, to);
      return;
    }

    const start = Math.max(0, firstVisible - pad);
    const end = Math.min(total, firstVisible + visibleCount + pad);
    this.loading = true;
    try {
      await this.fetchRange(start, end - start);
    } finally {
      this.loading = false;
    }
    this.renderRows(start, end);
  }

  private async fetchRange(start: number, count: number): Promise<void> {
    const info = this.info;
    if (!info || count <= 0) return;
    try {
      const win = await invoke<LineWindow>("read_large_lines", { id: info.id, start, count });
      this.cache.remember(win);
      this.noteClampedLine(win);
    } catch (e) {
      this.el.statusEl.textContent = `读取失败：${firstLine(e)}`;
    }
  }

  /** 批量读取缺失行：合并为连续区间后一次 invoke 读一段。
   *  逐行 invoke 在命中集大时会并发几十次 IPC，且缓存超限整表清空，
   *  造成反复回读与掉帧。 */
  private async fetchLines(lines: number[]): Promise<void> {
    const info = this.info;
    if (!info || lines.length === 0) return;
    try {
      for (const [start, count] of coalesceLines(lines)) {
        const win = await invoke<LineWindow>("read_large_lines", { id: info.id, start, count });
        this.cache.remember(win);
        this.noteClampedLine(win);
      }
    } catch (e) {
      this.el.statusEl.textContent = `读取失败：${firstLine(e)}`;
    }
  }

  private renderRows(from: number, to: number): void {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i += 1) {
      const no = this.lineOf(i);
      const text = this.cache.get(no) ?? "";
      const row = document.createElement("div");
      row.className = "lv-row";
      if (this.selectedLine === no) row.classList.add("row-selected");
      row.addEventListener("click", () => {
        this.selectedLine = no;
        this.el.rowsEl.querySelectorAll(".lv-row.row-selected").forEach((el) => {
          el.classList.remove("row-selected");
        });
        row.classList.add("row-selected");
      });
      const gutter = document.createElement("span");
      gutter.className = "lv-no";
      gutter.textContent = `${no + 1}`;
      const body = document.createElement("span");
      body.className = "lv-text";
      body.textContent = text || " ";
      body.title = text;
      if (text.length > this.maxLineChars) this.maxLineChars = text.length;
      row.append(gutter, body);
      frag.append(row);
    }
    this.el.rowsEl.style.transform = `translateY(${from * LINE_HEIGHT}px)`;
    this.el.rowsEl.innerHTML = "";
    this.el.rowsEl.append(frag);
    this.applyRowsWidth();

    const total = this.virtualCount();
    const wrapHint = this.wrapOn ? " · 换行模式（滚动按行定位）" : "";
    this.el.statusEl.textContent = this.matchBuf.active
      ? `命中 ${this.matchBuf.length} 行 · 显示第 ${from + 1}–${to} 条${wrapHint}`
      : `显示第 ${from + 1}–${to} 行 / 共 ${total} 行${wrapHint}`;
  }

  /** 自动换行开关：关掉时靠横向滚动看完整长行，两者互补 */
  private toggleWrap(): void {
    this.wrapOn = !this.wrapOn;
    this.el.wrapBtn.classList.toggle("on", this.wrapOn);
    this.host.classList.toggle("lv-wrap", this.wrapOn);
    this.applyRowsWidth();
    void this.loadWindow();
    this.deps.onMessage(
      this.wrapOn
        ? "已开启自动换行：长行折行显示（横向滚动关闭）"
        : "已关闭自动换行：长行可横向滚动查看",
    );
  }

  // ---- 跟随文件尾部（tail -f） ----

  /** 轮询间隔：日志追加通常秒级可见，1s 足够且不会明显吃 CPU */
  private static readonly FOLLOW_POLL_MS = 1000;
  /** 距底部多少像素内算"在底部"（留一行余量，避免像素取整误差） */
  private static readonly FOLLOW_BOTTOM_SLACK = LINE_HEIGHT * 2;

  private toggleFollow(): void {
    if (this.followOn) {
      this.setFollow(false);
      this.deps.onMessage("已停止跟随");
      return;
    }
    if (!this.info) return;
    if (this.matchBuf.active) {
      this.deps.onMessage("过滤模式下不支持跟随：请先点「清除」退出过滤");
      return;
    }
    this.setFollow(true);
    this.scrollToBottom();
    void this.loadWindow();
    this.deps.onMessage("已开启跟随：文件追加时自动显示最新内容（手动上滚会暂停）");
  }

  /** 开关跟随时同步按键状态与轮询计时器（任何路径都必须成对，避免计时器泄漏） */
  private setFollow(on: boolean): void {
    this.followOn = on;
    this.el.followBtn.classList.toggle("active", on);
    if (this.followTimer !== null) {
      clearInterval(this.followTimer);
      this.followTimer = null;
    }
    if (on) {
      this.followTimer = setInterval(() => void this.followTick(), LargeView.FOLLOW_POLL_MS);
    }
  }

  /** 贴底：让新内容立即进入视口（记录程序化滚动，避免被判成"用户上滚"） */
  private scrollToBottom(): void {
    const el = this.el.scrollEl;
    this.programmaticScroll = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      this.programmaticScroll = false;
    });
  }

  /** 用户手动上滚离开底部 → 暂停跟随（否则日志一更新就被拽回底部，翻不动） */
  private pauseFollowIfScrolledUp(): void {
    if (!this.followOn || this.programmaticScroll) return;
    const el = this.el.scrollEl;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - LargeView.FOLLOW_BOTTOM_SLACK;
    if (atBottom) return;
    this.setFollow(false);
    this.deps.onMessage("已暂停跟随（向上滚动离开底部），点「跟随」可继续");
  }

  /**
   * 一轮跟随：
   * 后端把索引续扫到最新 EOF（单次上限 32MB），有增长才重读尾窗。
   * 文件被截断/轮转时停止跟随并提示重新打开。
   */
  private async followTick(): Promise<void> {
    const info = this.info;
    if (!this.followOn || !info || this.followBusy || this.loading) return;
    // 标签切走 / 窗口最小化时不轮询（切回来下一轮自然会补齐）
    if (document.hidden || this.host.classList.contains("hidden")) return;
    this.followBusy = true;
    try {
      const res = await invoke<LargeRefresh>("refresh_large_file", { id: info.id });
      if (!this.followOn || this.info !== info) return;
      if (res.resetRequired) {
        this.setFollow(false);
        this.deps.onMessage("文件已被截断或替换，请重新打开以继续查看");
        return;
      }
      if (!res.grew) return;
      // 追加内容可能续写"最后一行"，缓存整体作废最省心（窗口很小，重读代价低）
      this.cache.clear();
      info.size = res.info.size;
      info.totalLines = res.info.totalLines;
      info.indexedBytes = res.info.indexedBytes;
      info.complete = res.info.complete;
      this.deps.onTotalLines?.(info.totalLines, info.newline);
      this.updateIndexHint();
      this.resizeSpacer();
      this.scrollToBottom();
      await this.loadWindow();
      this.drawMinimap();
    } catch (e) {
      // 会话被释放（关标签/切文件）属正常路径，只提示其它错误
      if (this.info !== info) return;
      this.setFollow(false);
      this.el.statusEl.textContent = `跟随失败：${firstLine(e)}`;
    } finally {
      this.followBusy = false;
    }
  }

  /** 横向滚动宽度：按"已见最长行"算，只增不减，避免滚动条随窗口抖动 */
  private applyRowsWidth(): void {
    const rows = this.el.rowsEl;
    if (this.wrapOn) {
      rows.style.width = "";
      return;
    }
    // 行号列 64 + 文本左内边距 8 + 右侧余量
    const width = this.maxLineChars * this.measureCharWidth() + 80;
    rows.style.width = `${Math.max(0, Math.round(width))}px`;
  }

  /** 等宽字符宽度：懒测量一次（与 .lv-row 的字体族/字号保持一致） */
  private measureCharWidth(): number {
    if (this.charWidth > 0) return this.charWidth;
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = '12px Consolas, "Cascadia Mono", "Cascadia Code", monospace';
      this.charWidth = Math.max(4, ctx.measureText("0123456789").width / 10);
    } else {
      this.charWidth = 7;
    }
    return this.charWidth;
  }

  // ---- 过滤 ----

  private async runFilter(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const query = this.el.filterInput.value;
    if (!query) {
      await this.clearFilter();
      return;
    }
    const requestId = ++this.filterRequestId;
    this.filterFinishedId = -1;
    this.lastStreamRefresh = 0;
    // 过滤模式按"命中行号"虚拟化，与跟随（按总行数贴底）语义冲突
    this.setFollow(false);
    // 先切到空结果集：批次到达即可增量渲染，不用等整文件扫完
    this.matchBuf.begin();
    this.cache.clear();
    this.el.scrollEl.scrollTop = 0;
    this.resizeSpacer();
    this.el.statusEl.textContent = "过滤中…";
    try {
      const res = await invoke<FilterResult>("filter_large_file", {
        id: info.id,
        query,
        caseSensitive: this.caseOn,
        useRegex: this.regexOn,
        requestId,
      });
      if (requestId !== this.filterRequestId) return;
      if (res.cancelled) {
        // 取消：返回值里的命中也不用，直接复位到未过滤全文
        this.finishCancelled(requestId);
        return;
      }
      this.matchBuf.replace(res.matches);
      // 末批事件可能先到并已完成收尾
      if (this.filterFinishedId === requestId) return;
      this.filterFinishedId = requestId;
      this.deps.onMessage(
        res.truncated
          ? `过滤命中已达上限，仅保留前 ${res.matches.length} 行`
          : `过滤命中 ${res.matches.length} 行`,
      );
      await this.loadWindow();
      this.drawMinimap();
    } catch (e) {
      if (requestId !== this.filterRequestId) return;
      this.el.statusEl.textContent = `过滤失败：${firstLine(e)}`;
    }
  }

  private async clearFilter(): Promise<void> {
    // 丢弃仍在推送的批次，并中止后端仍在校验的扫描
    this.filterRequestId++;
    this.filterFinishedId = -1;
    void this.cancel();
    this.matchBuf.reset();
    this.cache.clear();
    this.el.scrollEl.scrollTop = 0;
    await this.loadWindow();
    this.drawMinimap();
  }

  /**
   * 取过滤命中的行文本。
   * 命中行号递增：按连续区间批量读，单次上限与后端 `read_large_lines` 一致（4000 行）。
   */
  private async collectMatches(limit: number): Promise<string[]> {
    const info = this.info;
    const total = this.matchBuf.length;
    if (!info || total === 0) return [];
    const windowMax = 4000;
    const n = Math.min(total, limit);
    const out: string[] = [];
    let i = 0;
    while (i < n) {
      const start = this.matchBuf.at(i);
      let end = i + 1;
      while (end < n && this.matchBuf.at(end) === start + (end - i)) end += 1;
      while (i < end) {
        const count = Math.min(end - i, windowMax);
        const win = await invoke<LineWindow>("read_large_lines", {
          id: info.id,
          start: this.matchBuf.at(i),
          count,
        });
        out.push(...win.lines);
        i += count;
      }
    }
    return out;
  }

  /** 复制命中行（最多 5000 行）：只读视图的结果出口之一 */
  private async copyMatches(): Promise<void> {
    const total = this.matchBuf.length;
    if (!this.matchBuf.active) {
      this.deps.onMessage("先执行一次过滤：复制只针对命中行");
      return;
    }
    if (total === 0) {
      this.deps.onMessage("当前过滤没有命中行");
      return;
    }
    const limit = Math.min(total, 5000);
    const lines = await this.collectMatches(limit);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      showResultCard({
        title: limit < total ? `已复制前 ${limit} 行命中（共 ${total} 行）` : `已复制 ${total} 行命中`,
        hint: "内容是过滤结果的纯文本，可直接粘贴到其它应用；原文件未改动",
        key: "large-copy",
      });
    } catch (e) {
      showErrorCard({
        title: "复制命中失败",
        message: e instanceof Error ? e.message : String(e),
        hint: "剪贴板可能被其它程序占用；可改用「导出命中」落地成文件。",
      });
    }
  }

  /** 导出命中行到 `<文件>.filtered.txt`：原文件保持只读，不改动一个字节 */
  private async exportMatches(): Promise<void> {
    const info = this.info;
    const total = this.matchBuf.length;
    if (!info) return;
    if (!this.matchBuf.active) {
      this.deps.onMessage("先执行一次过滤：导出只针对命中行");
      return;
    }
    if (total === 0) {
      this.deps.onMessage("当前过滤没有命中行");
      return;
    }
    try {
      const lines = await this.collectMatches(total);
      const content = `${lines.join("\n")}\n`;
      let out: string;
      try {
        out = await invoke<string>("export_large_matches", {
          path: info.path,
          content,
          overwrite: false,
        });
      } catch (e) {
        // 「目标已存在」是后端 export_large_matches 的拒绝原因：确认后才带覆盖标记重试
        if (!String(e).includes("目标已存在")) throw e;
        const ok = await confirmAction(`${firstLine(e)}\n\n覆盖它？`, "覆盖");
        if (!ok) {
          this.deps.onMessage("已取消导出：原文件未改动");
          return;
        }
        out = await invoke<string>("export_large_matches", {
          path: info.path,
          content,
          overwrite: true,
        });
      }
      showResultCard({
        title: `已导出 ${total} 行命中`,
        path: out,
        hint: "原文件保持只读，这是过滤结果的副本（.filtered.txt），可直接打开或分发",
        key: "large-export",
      });
    } catch (e) {
      showErrorCard({
        title: "导出命中失败",
        message: e instanceof Error ? e.message : String(e),
        hint: "目标目录可能只读，或同名 .filtered.txt 正被占用；处理后可重新导出。",
      });
    }
  }

  /** 中止正在进行的过滤（只针对当前会话；换文件 / 清过滤 / 用户中止时调用） */
  async cancel(): Promise<void> {
    const id = this.info?.id;
    try {
      // 有会话时按 id 精确取消；视图尚未绑定会话时退回全量（无任务，空操作）
      if (id) await invoke("cancel_large_task", { id });
      else await invoke("cancel_large_task");
    } catch {
      // 无进行中任务时忽略
    }
  }

  private async changeEncoding(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const next = this.el.encodingSelect.value;
    if (next === info.encoding) return;
    try {
      await invoke("set_large_encoding", { id: info.id, encodingName: next });
      info.encoding = next;
      this.cache.clear();
      await this.loadWindow();
      this.deps.onMessage(`已按 ${next} 重新解释（只读视图，不写盘）`);
    } catch (e) {
      // 失败时把下拉恢复到当前编码，避免 UI 停在一个并未生效的值
      this.el.encodingSelect.value = info.encoding;
      this.el.statusEl.textContent = `切换编码失败：${firstLine(e)}`;
    }
  }

  // ---- 缩略图 ----

  private async loadDensity(): Promise<void> {
    const info = this.info;
    if (!info) return;
    try {
      this.density = await invoke<number[]>("large_minimap", {
        id: info.id,
        buckets: MINIMAP_BUCKETS,
      });
      this.drawMinimap();
    } catch {
      // 会话已释放时忽略
    }
  }

  private drawMinimap(): void {
    const info = this.info;
    if (!info) return;
    drawMinimap(this.el.canvas, {
      density: this.density,
      matches: this.matchBuf.view(),
      total: this.virtualCount(),
      scrollTop: this.el.scrollEl.scrollTop,
      clientHeight: this.el.scrollEl.clientHeight,
    });
  }
}
