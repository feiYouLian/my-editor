import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatSize } from "../core/format";

export interface LargeFileInfo {
  id: string;
  path: string;
  name: string;
  size: number;
  encoding: string;
  newline: string;
  totalLines: number;
  indexedBytes: number;
  complete: boolean;
}

interface LineWindow {
  start: number;
  lineNos: number[];
  lines: string[];
  truncatedLines: number;
}

interface FilterResult {
  matches: number[];
  truncated: boolean;
  cancelled: boolean;
  scanned: number;
}

/** 流式过滤批次（后端按 200ms / 1000 条分批推送） */
interface FilterBatch {
  id: string;
  requestId: number;
  matches: number[];
  scanned: number;
  total: number;
  truncated: boolean;
  done: boolean;
  cancelled: boolean;
}

interface IndexReady {
  id: string;
  totalLines: number;
  newline: string;
}

export interface LargeViewDeps {
  onMessage: (text: string) => void;
  /** 逃生门：改用编辑器打开 */
  onOpenInEditor: (info: LargeFileInfo) => void;
}

/** 固定行高是虚拟化的前提；长行横向裁剪并用 tooltip 呈现全文 */
const LINE_HEIGHT = 18;
const DEFAULT_PADDING_LINES = 200;
const MINIMAP_BUCKETS = 240;
const CACHE_LIMIT = 5000;
const ENCODINGS = ["UTF-8", "GBK", "GB18030", "UTF-16 LE", "UTF-16 BE", "Big5"];

/**
 * 大文件只读虚拟视图：只渲染视口 ±PADDING_LINES 的行，
 * 行内容按窗口从后端拉取；支持整文件过滤与缩略图密度。
 */
export class LargeView {
  private info: LargeFileInfo | null = null;
  private matches: number[] | null = null;
  private density: number[] = [];
  private cache = new Map<number, string>();
  private caseOn = false;
  private regexOn = false;
  private loading = false;
  private paddingLines = DEFAULT_PADDING_LINES;
  private rafId = 0;
  private unlisteners: Array<() => void> = [];

  private scrollEl!: HTMLDivElement;
  private spacerEl!: HTMLDivElement;
  private rowsEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private metaEl!: HTMLSpanElement;
  private indexEl!: HTMLSpanElement;
  private canvas!: HTMLCanvasElement;
  private filterInput!: HTMLInputElement;
  private filterBtn!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;
  private caseBtn!: HTMLButtonElement;
  private regexBtn!: HTMLButtonElement;
  private encodingSelect!: HTMLSelectElement;
  private editorBtn!: HTMLButtonElement;

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
    this.host.innerHTML = "";

    // ---- 工具条 ----
    const bar = document.createElement("div");
    bar.className = "lv-bar";

    const title = document.createElement("span");
    title.className = "lv-title";
    this.metaEl = document.createElement("span");
    this.metaEl.className = "lv-meta";

    this.filterInput = document.createElement("input");
    this.filterInput.className = "lv-filter";
    this.filterInput.placeholder = "过滤行（留空显示全部）";
    this.filterInput.spellcheck = false;
    this.caseBtn = this.toggle("Aa", "区分大小写");
    this.regexBtn = this.toggle(".*", "使用正则表达式");
    this.filterBtn = document.createElement("button");
    this.filterBtn.type = "button";
    this.filterBtn.className = "lv-btn";
    this.filterBtn.textContent = "过滤";
    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button";
    this.clearBtn.className = "lv-btn";
    this.clearBtn.textContent = "清除";

    this.encodingSelect = document.createElement("select");
    this.encodingSelect.className = "lv-select";
    this.encodingSelect.title = "重新解释编码";
    for (const name of ENCODINGS) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      this.encodingSelect.append(opt);
    }

    this.editorBtn = document.createElement("button");
    this.editorBtn.type = "button";
    this.editorBtn.className = "lv-btn";
    this.editorBtn.textContent = "以编辑器打开";
    this.editorBtn.title = "改用可编辑的编辑器打开（大文件会占用较多内存）";

    this.indexEl = document.createElement("span");
    this.indexEl.className = "lv-index";

    bar.append(
      title,
      this.metaEl,
      this.filterInput,
      this.caseBtn,
      this.regexBtn,
      this.filterBtn,
      this.clearBtn,
      this.encodingSelect,
      this.editorBtn,
      this.indexEl,
    );
    title.textContent = "日志视图";

    // ---- 主体：缩略图 + 虚拟列表 ----
    const body = document.createElement("div");
    body.className = "lv-body";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "lv-minimap";
    this.canvas.width = 64;
    this.canvas.title = "缩略图：点击跳转，红线为过滤命中位置";

    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "lv-scroll";
    this.spacerEl = document.createElement("div");
    this.spacerEl.className = "lv-spacer";
    this.rowsEl = document.createElement("div");
    this.rowsEl.className = "lv-rows";
    this.spacerEl.append(this.rowsEl);
    this.scrollEl.append(this.spacerEl);

    body.append(this.canvas, this.scrollEl);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "lv-status";

    this.host.append(bar, body, this.statusEl);

    // ---- 事件 ----
    this.scrollEl.addEventListener("scroll", () => this.scheduleLoad());
    this.filterBtn.addEventListener("click", () => void this.runFilter());
    this.clearBtn.addEventListener("click", () => void this.clearFilter());
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.runFilter();
      }
    });
    this.encodingSelect.addEventListener("change", () => void this.changeEncoding());
    this.editorBtn.addEventListener("click", () => {
      if (this.info) this.deps.onOpenInEditor(this.info);
    });
    this.canvas.addEventListener("click", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
      const total = this.virtualCount();
      this.scrollEl.scrollTop = ratio * total * LINE_HEIGHT - this.scrollEl.clientHeight / 2;
      this.scheduleLoad();
    });
  }

  private toggle(label: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lv-toggle";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", () => {
      if (b === this.caseBtn) this.caseOn = !this.caseOn;
      else this.regexOn = !this.regexOn;
      b.classList.toggle("active", b === this.caseBtn ? this.caseOn : this.regexOn);
    });
    return b;
  }

  // ---- 生命周期 ----

  async open(info: LargeFileInfo, paddingLines = DEFAULT_PADDING_LINES): Promise<void> {
    void this.cancel();
    this.info = info;
    this.filterRequestId++;
    this.filterFinishedId = -1;
    this.paddingLines = Math.max(0, paddingLines);
    this.matches = null;
    this.density = [];
    this.cache.clear();
    this.host.classList.remove("hidden");
    this.encodingSelect.value = ENCODINGS.includes(info.encoding) ? info.encoding : "UTF-8";
    this.filterInput.value = "";
    this.updateMeta();
    this.updateIndexHint();
    this.scrollEl.scrollTop = 0;

    await this.ensureListeners();
    void this.loadDensity();
    await this.loadWindow();
  }

  close(): void {
    this.info = null;
    this.filterRequestId++;
    this.filterFinishedId = -1;
    this.matches = null;
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
          const pct = e.payload.total ? Math.round((e.payload.scanned / e.payload.total) * 100) : 0;
          this.indexEl.textContent = `索引建立中 ${pct}%`;
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
        this.indexEl.textContent = "";
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
          const pct = e.payload.total ? Math.round((e.payload.scanned / e.payload.total) * 100) : 0;
          this.statusEl.textContent = `过滤中 ${pct}%（已命中 ${e.payload.matches} 行）`;
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
    if (p.matches.length > 0) {
      if (!this.matches) this.matches = [];
      this.matches.push(...p.matches);
      if (this.matches.length > 50000) this.matches.length = 50000;
    }
    if (!p.done) {
      this.statusEl.textContent = `过滤中…（已命中 ${this.matches?.length ?? 0} 行）`;
      // 用户停在顶部时优先刷新首批结果，节流避免每批都读盘
      const now = performance.now();
      if (p.matches.length > 0 && this.scrollEl.scrollTop <= 1 && now - this.lastStreamRefresh > 200) {
        this.lastStreamRefresh = now;
        void this.loadWindow();
      }
      return;
    }
    if (this.filterFinishedId === p.requestId) return;
    this.filterFinishedId = p.requestId;
    if (p.cancelled) {
      this.statusEl.textContent = "过滤已中止";
      return;
    }
    this.deps.onMessage(
      p.truncated
        ? `过滤命中已达上限，仅保留前 ${this.matches?.length ?? 0} 行`
        : `过滤命中 ${this.matches?.length ?? 0} 行`,
    );
    void this.loadWindow();
    this.drawMinimap();
  }

  private updateMeta(): void {
    const info = this.info;
    if (!info) return;
    this.metaEl.textContent = `${info.name} · ${formatSize(info.size)} · ${info.totalLines} 行 · ${info.encoding} · ${info.newline}`;
    this.metaEl.title = info.path;
  }

  private updateIndexHint(): void {
    const info = this.info;
    if (!info) return;
    if (info.complete) {
      this.indexEl.textContent = "";
      return;
    }
    const pct = info.size ? Math.round((info.indexedBytes / info.size) * 100) : 0;
    this.indexEl.textContent = `索引建立中 ${pct}%`;
  }

  // ---- 虚拟化 ----

  /** 当前可滚动的条目数：过滤模式为命中数，否则为总行数 */
  private virtualCount(): number {
    if (this.matches) return this.matches.length;
    return this.info?.totalLines ?? 0;
  }

  /** 虚拟条目下标 → 原始行号 */
  private lineOf(index: number): number {
    if (this.matches) return this.matches[index] ?? 0;
    return index;
  }

  private resizeSpacer(): void {
    this.spacerEl.style.height = `${this.virtualCount() * LINE_HEIGHT}px`;
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
      this.rowsEl.innerHTML = "";
      this.statusEl.textContent = this.matches ? "没有匹配的行" : "空文件";
      return;
    }

    const firstVisible = Math.floor(this.scrollEl.scrollTop / LINE_HEIGHT);
    const visibleCount = Math.ceil(this.scrollEl.clientHeight / LINE_HEIGHT) + 1;

    if (this.matches) {
      const from = Math.max(0, firstVisible - 40);
      const to = Math.min(this.matches.length, firstVisible + visibleCount + 40);
      const missing = this.matches.slice(from, to).filter((ln) => !this.cache.has(ln));
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

  private remember(win: LineWindow): void {
    win.lineNos.forEach((no, i) => {
      // 先删再设：让 Map 插入顺序反映最近使用，供下面按序淘汰
      this.cache.delete(no);
      this.cache.set(no, win.lines[i] ?? "");
    });
    // 按插入序淘汰最旧条目。整表 clear 会让滚动/过滤来回时反复回读，掉帧明显
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchRange(start: number, count: number): Promise<void> {
    const info = this.info;
    if (!info || count <= 0) return;
    try {
      const win = await invoke<LineWindow>("read_large_lines", { id: info.id, start, count });
      this.remember(win);
    } catch (e) {
      this.statusEl.textContent = `读取失败：${String(e).split("\n")[0]}`;
    }
  }

  /** 批量读取缺失行：合并为连续区间后一次 invoke 读一段。
   *  逐行 invoke 在命中集大时会并发几十次 IPC，且缓存超限整表清空，
   *  造成反复回读与掉帧。 */
  private async fetchLines(lines: number[]): Promise<void> {
    const info = this.info;
    if (!info || lines.length === 0) return;
    const sorted = [...new Set(lines)].sort((a, b) => a - b);
    const runs: [number, number][] = []; // [起始行, 行数]
    for (const ln of sorted) {
      const last = runs[runs.length - 1];
      if (last && ln <= last[0] + last[1]) {
        last[1] = ln - last[0] + 1;
      } else {
        runs.push([ln, 1]);
      }
    }
    try {
      for (const [start, count] of runs) {
        const win = await invoke<LineWindow>("read_large_lines", { id: info.id, start, count });
        this.remember(win);
      }
    } catch (e) {
      this.statusEl.textContent = `读取失败：${String(e).split("\n")[0]}`;
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
    this.rowsEl.style.transform = `translateY(${from * LINE_HEIGHT}px)`;
    this.rowsEl.innerHTML = "";
    this.rowsEl.append(frag);

    const total = this.virtualCount();
    this.statusEl.textContent = this.matches
      ? `命中 ${this.matches.length} 行 · 显示第 ${from + 1}–${to} 条`
      : `显示第 ${from + 1}–${to} 行 / 共 ${total} 行`;
  }

  // ---- 过滤 ----

  private async runFilter(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const query = this.filterInput.value;
    if (!query) {
      await this.clearFilter();
      return;
    }
    const requestId = ++this.filterRequestId;
    this.filterFinishedId = -1;
    this.lastStreamRefresh = 0;
    // 先切到空结果集：批次到达即可增量渲染，不用等整文件扫完
    this.matches = [];
    this.cache.clear();
    this.scrollEl.scrollTop = 0;
    this.resizeSpacer();
    this.statusEl.textContent = "过滤中…";
    try {
      const res = await invoke<FilterResult>("filter_large_file", {
        id: info.id,
        query,
        caseSensitive: this.caseOn,
        useRegex: this.regexOn,
        requestId,
      });
      if (requestId !== this.filterRequestId) return;
      this.matches = res.matches;
      // 末批事件可能先到并已完成收尾
      if (this.filterFinishedId === requestId) return;
      this.filterFinishedId = requestId;
      if (res.cancelled) {
        this.statusEl.textContent = "过滤已中止";
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
      this.statusEl.textContent = `过滤失败：${String(e).split("\n")[0]}`;
    }
  }

  private async clearFilter(): Promise<void> {
    // 丢弃仍在推送的批次，并中止后端仍在校验的扫描
    this.filterRequestId++;
    this.filterFinishedId = -1;
    void this.cancel();
    this.matches = null;
    this.cache.clear();
    this.scrollEl.scrollTop = 0;
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
    const next = this.encodingSelect.value;
    if (next === info.encoding) return;
    try {
      await invoke("set_large_encoding", { id: info.id, encoding: next });
      info.encoding = next;
      this.cache.clear();
      this.updateMeta();
      await this.loadWindow();
      this.deps.onMessage(`已按 ${next} 重新解释（只读视图，不写盘）`);
    } catch (e) {
      this.statusEl.textContent = `切换编码失败：${String(e).split("\n")[0]}`;
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
    const height = Math.max(120, this.scrollEl.clientHeight);
    const width = 64;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.height = `${height}px`;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const buckets = this.density.length;
    const max = Math.max(1, ...this.density);
    for (let i = 0; i < buckets; i += 1) {
      const y = (i / buckets) * height;
      const h = Math.max(1, height / buckets);
      const ratio = this.density[i] / max;
      ctx.fillStyle = `rgba(150, 162, 184, ${0.12 + 0.5 * ratio})`;
      ctx.fillRect(0, y, Math.max(1, 12 + 46 * ratio), h);
    }

    const total = this.virtualCount();
    if (this.matches && total > 0) {
      ctx.fillStyle = "rgba(217, 90, 80, 0.95)";
      const step = this.matches.length > 4000 ? Math.ceil(this.matches.length / 4000) : 1;
      for (let i = 0; i < this.matches.length; i += step) {
        const y = (this.matches[i] / total) * height;
        ctx.fillRect(0, y, width, 1);
      }
    }

    if (total > 0) {
      const viewH = Math.max(3, (this.scrollEl.clientHeight / (total * LINE_HEIGHT)) * height);
      const top = (this.scrollEl.scrollTop / (total * LINE_HEIGHT)) * height;
      ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
      ctx.fillRect(0, Math.max(0, Math.min(height - viewH, top)), width, viewH);
    }
  }
}
