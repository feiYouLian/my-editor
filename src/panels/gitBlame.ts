import { firstLine } from "../core/errors";

/**
 * Git Blame 对话框：逐行显示提交、作者、日期与内容。
 * 基于磁盘版本（未保存改动可能导致行号偏移）；点击行跳回编辑器对应位置。
 */

/** 行高（与 CSS .git-blame-row 一致）：虚拟化按固定行高定位窗口 */
const ROW_H = 22;
/** 上下各多渲染的行数：滚动时不至于露白 */
const OVERSCAN = 20;
/** 可视高度未知（未挂载 / 测试环境）时的最小渲染行数 */
const MIN_ROWS = 20;

export interface BlameLine {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  authorTime: number;
  summary: string;
  content: string;
}

export interface BlameReport {
  lines: BlameLine[];
  truncated: boolean;
}

export class GitBlameDialog {
  private backdrop: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private seq = 0;

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(
    title: string,
    load: () => Promise<BlameReport>,
    onOpenLine: (line: number) => void,
    dirty: boolean,
  ): void {
    if (this.isOpen) return;
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "dialog git-blame-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Git Blame");

    const head = document.createElement("div");
    head.className = "git-history-head";
    const heading = document.createElement("h3");
    heading.textContent = `Git Blame · ${title}`;
    heading.title = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "gs-head-btn";
    close.textContent = "✕";
    close.title = "关闭";
    close.addEventListener("click", () => this.close());
    head.append(heading, close);

    const note = document.createElement("div");
    note.className = "git-blame-note";
    note.textContent = dirty
      ? "当前文件有未保存改动；Blame 基于磁盘版本，行号可能与编辑器偏移。点击行会跳转并保留编辑内容。"
      : "点击任意行可跳转到编辑器对应位置。";

    const columns = document.createElement("div");
    columns.className = "git-blame-columns";
    for (const label of ["行", "提交", "作者", "日期", "内容"]) {
      const span = document.createElement("span");
      span.textContent = label;
      columns.append(span);
    }

    const list = document.createElement("div");
    list.className = "git-blame-list";

    dialog.append(head, note, columns, list);
    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;
    this.listEl = list;
    this.seq += 1;
    const seq = this.seq;

    void load()
      .then((report) => {
        if (seq !== this.seq || !this.listEl) return;
        this.render(report, onOpenLine);
      })
      .catch((e) => {
        if (seq !== this.seq || !this.listEl) return;
        const err = document.createElement("div");
        err.className = "git-empty";
        err.textContent = `读取 Blame 失败：${firstLine(e)}`;
        this.listEl.append(err);
      });
  }

  private render(report: BlameReport, onOpenLine: (line: number) => void): void {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    if (report.lines.length === 0) {
      const empty = document.createElement("div");
      empty.className = "git-empty";
      empty.textContent = "没有可显示的 Blame（文件可能未跟踪或尚无提交）";
      this.listEl.append(empty);
      return;
    }
    const total = report.lines.length;
    // 虚拟化：spacer 撑出总高度，行窗口按滚动位置摆放——DOM 里只有可见的几十行，
    // 千条级 Blame 滚动不掉帧（行高固定，与 CSS .git-blame-row 一致）
    const spacer = document.createElement("div");
    spacer.className = "git-blame-spacer";
    spacer.style.height = `${total * ROW_H}px`;
    const window = document.createElement("div");
    window.className = "git-blame-window";
    spacer.append(window);
    this.listEl.append(spacer);

    const paint = (): void => {
      const list = this.listEl;
      if (!list) return;
      const visible = Math.max(MIN_ROWS, Math.ceil(list.clientHeight / ROW_H));
      const start = Math.max(0, Math.floor(list.scrollTop / ROW_H) - OVERSCAN);
      const end = Math.min(total, start + visible + OVERSCAN * 2);
      const rows: HTMLElement[] = [];
      for (let i = start; i < end; i++) {
        rows.push(this.rowFor(report.lines[i], onOpenLine));
      }
      window.replaceChildren(...rows);
      window.style.transform = `translateY(${start * ROW_H}px)`;
    };
    this.listEl.addEventListener("scroll", paint, { passive: true });
    paint();

    if (report.truncated) {
      const hint = document.createElement("div");
      hint.className = "git-blame-truncated";
      hint.textContent = "文件行数过多，仅显示前 10000 行";
      this.listEl.append(hint);
    }
  }

  private rowFor(line: BlameLine, onOpenLine: (line: number) => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "git-blame-row";
    row.title = `${line.author} · ${formatTime(line.authorTime)}\n${line.summary}\n${line.hash}`;

    const no = document.createElement("span");
    no.className = "git-blame-no";
    no.textContent = String(line.line);

    const hash = document.createElement("span");
    hash.className = "git-blame-hash";
    hash.textContent = /^0+$/.test(line.hash) ? "未提交" : line.shortHash;
    const author = document.createElement("span");
    author.className = "git-blame-author";
    author.textContent = line.author || "未知作者";
    author.title = line.author;
    const date = document.createElement("span");
    date.className = "git-blame-date";
    date.textContent = formatTime(line.authorTime);
    const content = document.createElement("span");
    content.className = "git-blame-content";
    content.textContent = line.content || " ";
    content.title = line.content;

    row.append(no, hash, author, date, content);
    row.addEventListener("click", () => {
      this.close();
      onOpenLine(line.line);
    });
    return row;
  }

  close(): void {
    this.seq += 1;
    this.backdrop?.remove();
    this.backdrop = null;
    this.listEl = null;
  }
}

function formatTime(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString();
}
