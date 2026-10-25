/**
 * 大文件只读虚拟视图（控制器）：只渲染视口 ±PADDING_LINES 的行，
 * 行内容按窗口从后端拉取；支持整文件过滤（流式批次）与缩略图密度。
 *
 * 分层：DOM 骨架在 largeView/dom.ts，行缓存在 largeView/lineCache.ts，
 * 缩略图绘制在 largeView/minimap.ts，本文件只做虚拟化与交互编排。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatSize } from "../core/format";
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
  LineWindow,
} from "./largeView/types";

export type { LargeFileInfo } from "./largeView/types";

export interface LargeViewDeps {
  onMessage: (text: string) => void;
  /** 逃生门：改用编辑器打开 */
  onOpenInEditor: (info: LargeFileInfo) => void;
}

export class LargeView {
  private info: LargeFileInfo | null = null;
  /** 过滤命中行号（Uint32Array 定长缓冲，上限与后端 MAX_FILTER_MATCHES 一致） */
  private readonly matchBuf = new MatchBuffer();
  private density: number[] = [];
  private readonly cache = new LineCache();
  private caseOn = false;
  private regexOn = false;
  private loading = false;
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

  constructor(private host: HTMLElement, private deps: LargeViewDeps) {
    this.mount();
  }

  private mount(): void {
    const el = buildLargeViewDom(this.host);
    this.el = el;

    // ---- 事件 ----
    el.scrollEl.addEventListener("scroll", () => this.scheduleLoad());
    el.filterBtn.addEventListener("click", () => void this.runFilter());
    el.clearBtn.addEventListener("click", () => void this.clearFilter());
    el.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.runFilter();
      }
    });
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

  async open(info: LargeFileInfo, paddingLines = DEFAULT_PADDING_LINES): Promise<void> {
    void this.cancel();
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
    this.el.encodingSelect.value = ENCODINGS.includes(info.encoding) ? info.encoding : "UTF-8";
    this.el.filterInput.value = "";
    this.updateMeta();
    this.updateIndexHint();
    this.el.scrollEl.scrollTop = 0;

    await this.ensureListeners();
    void this.loadDensity();
    await this.loadWindow();
  }

  close(): void {
    this.info = null;
    this.filterRequestId++;
    this.filterFinishedId = -1;
    this.matchBuf.reset();
    this.cache.clear();
    this.host.classList.add("hidden");
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
        this.updateMeta();
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
    if (p.cancelled) {
      this.el.statusEl.textContent = "过滤已中止";
      return;
    }
    this.deps.onMessage(
      p.truncated
        ? `过滤命中已达上限，仅保留前 ${this.matchBuf.length} 行`
        : `过滤命中 ${this.matchBuf.length} 行`,
    );
    void this.loadWindow();
    this.drawMinimap();
  }

  private updateMeta(): void {
    const info = this.info;
    if (!info) return;
    this.el.metaEl.textContent = `${info.name} · ${formatSize(info.size)} · ${info.totalLines} 行 · ${info.encoding} · ${info.newline}`;
    this.el.metaEl.title = info.path;
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
    const visibleCount = Math.ceil(this.el.scrollEl.clientHeight / LINE_HEIGHT) + 1;

    const matches = this.matchBuf.view();
    if (matches) {
      const from = Math.max(0, firstVisible - 40);
      const to = Math.min(matches.length, firstVisible + visibleCount + 40);
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

    const start = Math.max(0, firstVisible - this.paddingLines);
    const end = Math.min(total, firstVisible + visibleCount + this.paddingLines);
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
    } catch (e) {
      this.el.statusEl.textContent = `读取失败：${String(e).split("\n")[0]}`;
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
      }
    } catch (e) {
      this.el.statusEl.textContent = `读取失败：${String(e).split("\n")[0]}`;
    }
  }

  private renderRows(from: number, to: number): void {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i += 1) {
      const no = this.lineOf(i);
      const text = this.cache.get(no) ?? "";
      const row = document.createElement("div");
      row.className = "lv-row";
      const gutter = document.createElement("span");
      gutter.className = "lv-no";
      gutter.textContent = `${no + 1}`;
      const body = document.createElement("span");
      body.className = "lv-text";
      body.textContent = text || " ";
      body.title = text;
      row.append(gutter, body);
      frag.append(row);
    }
    this.el.rowsEl.style.transform = `translateY(${from * LINE_HEIGHT}px)`;
    this.el.rowsEl.innerHTML = "";
    this.el.rowsEl.append(frag);

    const total = this.virtualCount();
    this.el.statusEl.textContent = this.matchBuf.active
      ? `命中 ${this.matchBuf.length} 行 · 显示第 ${from + 1}–${to} 条`
      : `显示第 ${from + 1}–${to} 行 / 共 ${total} 行`;
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
      this.matchBuf.replace(res.matches);
      // 末批事件可能先到并已完成收尾
      if (this.filterFinishedId === requestId) return;
      this.filterFinishedId = requestId;
      if (res.cancelled) {
        this.el.statusEl.textContent = "过滤已中止";
        return;
      }
      this.deps.onMessage(
        res.truncated
          ? `过滤命中已达上限，仅保留前 ${res.matches.length} 行`
          : `过滤命中 ${res.matches.length} 行`,
      );
      await this.loadWindow();
      this.drawMinimap();
    } catch (e) {
      if (requestId !== this.filterRequestId) return;
      this.el.statusEl.textContent = `过滤失败：${String(e).split("\n")[0]}`;
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

  /** 中止正在进行的过滤（切换标签 / 关闭时调用） */
  async cancel(): Promise<void> {
    try {
      await invoke("cancel_large_task", {});
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
      await invoke("set_large_encoding", { id: info.id, encoding: next });
      info.encoding = next;
      this.cache.clear();
      this.updateMeta();
      await this.loadWindow();
      this.deps.onMessage(`已按 ${next} 重新解释（只读视图，不写盘）`);
    } catch (e) {
      this.el.statusEl.textContent = `切换编码失败：${String(e).split("\n")[0]}`;
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
