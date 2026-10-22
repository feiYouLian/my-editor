import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * 批量另存为编码对话框（命令面板入口）：
 * 选文件 → 选输出目录 → 选目标编码与换行符 → 批量转存新副本。
 * 非破坏式：只写入输出目录，原文件不动；同名目标已存在时跳过并在结果里列出原因。
 */

export interface BatchFailure {
  path: string;
  error: string;
}

export interface BatchReport {
  written: string[];
  failures: BatchFailure[];
}

/** 把对话框选取的路径登记到 Rust 路径守卫（批量转码的作用域校验依赖它） */
async function registerPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await invoke("register_paths", { paths });
  } catch (e) {
    console.warn("[batch] 路径登记失败", e);
  }
}

const ENCODINGS = ["UTF-8", "GBK", "GB18030", "UTF-16 LE", "UTF-16 BE", "Big5"];

const NEWLINES: { value: string; label: string }[] = [
  { value: "KEEP", label: "保持原样" },
  { value: "LF", label: "LF（Unix）" },
  { value: "CRLF", label: "CRLF（Windows）" },
  { value: "CR", label: "CR（老式 Mac）" },
];

export class BatchEncodingPanel {
  private backdrop: HTMLElement | null = null;
  private files: string[] = [];
  private fileListEl!: HTMLElement;
  private outDirEl!: HTMLInputElement;
  private encodingEl!: HTMLSelectElement;
  private newlineEl!: HTMLSelectElement;
  private resultEl!: HTMLElement;
  private runBtn!: HTMLButtonElement;

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
    title.textContent = "批量另存为编码";

    // ---- 文件列表 ----
    this.fileListEl = document.createElement("div");
    this.fileListEl.className = "batch-files";
    const fileActions = document.createElement("div");
    fileActions.className = "cron-presets";
    const addBtn = this.smallButton("添加文件…", () => void this.addFiles());
    const clearBtn = this.smallButton("清空", () => {
      this.files = [];
      this.renderFiles();
    });
    const removeAllHint = document.createElement("span");
    removeAllHint.className = "dialog-text";
    removeAllHint.textContent = "支持多选；每行右侧 × 可移除";
    fileActions.append(addBtn, clearBtn, removeAllHint);

    // ---- 输出目录 ----
    const outRow = document.createElement("div");
    outRow.className = "dialog-fields";
    const outLabel = document.createElement("label");
    outLabel.textContent = "输出目录";
    this.outDirEl = document.createElement("input");
    this.outDirEl.className = "dialog-input";
    this.outDirEl.readOnly = true;
    this.outDirEl.placeholder = "选择输出目录…";
    const pickBtn = this.smallButton("选择…", () => void this.pickOutDir());
    outRow.append(outLabel, this.outDirEl, pickBtn);

    // ---- 目标编码 / 换行符 ----
    const encRow = document.createElement("div");
    encRow.className = "dialog-fields";
    const encLabel = document.createElement("label");
    encLabel.textContent = "目标编码";
    this.encodingEl = document.createElement("select");
    this.encodingEl.className = "dialog-input";
    for (const enc of ENCODINGS) {
      const opt = document.createElement("option");
      opt.value = enc;
      opt.textContent = enc;
      this.encodingEl.append(opt);
    }
    const nlLabel = document.createElement("label");
    nlLabel.textContent = "换行符";
    this.newlineEl = document.createElement("select");
    this.newlineEl.className = "dialog-input";
    for (const nl of NEWLINES) {
      const opt = document.createElement("option");
      opt.value = nl.value;
      opt.textContent = nl.label;
      this.newlineEl.append(opt);
    }
    encRow.append(encLabel, this.encodingEl, nlLabel, this.newlineEl);

    // ---- 说明与结果 ----
    const hint = document.createElement("p");
    hint.className = "dialog-text";
    hint.textContent =
      "源编码自动探测；原文件不会被修改。输出目录中已存在同名文件时跳过，不覆盖。";
    this.resultEl = document.createElement("div");
    this.resultEl.className = "batch-result";

    // ---- 动作 ----
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "关闭";
    cancelBtn.addEventListener("click", () => this.close());
    this.runBtn = document.createElement("button");
    this.runBtn.type = "button";
    this.runBtn.className = "primary";
    this.runBtn.textContent = "开始转换";
    this.runBtn.addEventListener("click", () => void this.run());
    actions.append(cancelBtn, this.runBtn);

    dialog.append(title, this.fileListEl, fileActions, outRow, encRow, hint, this.resultEl, actions);
    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;
    this.renderFiles();
  }

  private smallButton(label: string, run: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "df-btn df-btn-wide";
    btn.textContent = label;
    btn.addEventListener("click", run);
    return btn;
  }

  private async addFiles(): Promise<void> {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "所有文件", extensions: ["*"] }],
    });
    if (!selected) return;
    const list = typeof selected === "string" ? [selected] : selected;
    await registerPaths(list);
    for (const path of list) {
      if (!this.files.includes(path)) this.files.push(path);
    }
    this.renderFiles();
  }

  private async pickOutDir(): Promise<void> {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    await registerPaths([dir]);
    this.outDirEl.value = dir;
  }

  private renderFiles(): void {
    this.fileListEl.innerHTML = "";
    if (this.files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dialog-text";
      empty.textContent = "尚未添加文件";
      this.fileListEl.append(empty);
      return;
    }
    this.files.forEach((path, index) => {
      const row = document.createElement("div");
      row.className = "batch-row";
      row.title = path;

      const name = document.createElement("span");
      name.className = "batch-row-name";
      name.textContent = path.split(/[\\/]/).pop() ?? path;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "batch-row-remove";
      remove.textContent = "×";
      remove.title = "移除";
      remove.addEventListener("click", () => {
        this.files.splice(index, 1);
        this.renderFiles();
      });

      row.append(name, remove);
      this.fileListEl.append(row);
    });
  }

  private async run(): Promise<void> {
    if (this.files.length === 0) {
      this.setResult("请先添加要转换的文件", true);
      return;
    }
    const outDir = this.outDirEl.value;
    if (!outDir) {
      this.setResult("请先选择输出目录", true);
      return;
    }
    this.runBtn.disabled = true;
    this.setResult("转换中…", false);
    try {
      const report = await invoke<BatchReport>("batch_save_encoding", {
        files: this.files,
        encoding: this.encodingEl.value,
        newline: this.newlineEl.value,
        outDir,
      });
      const lines = [`成功 ${report.written.length} 个，失败 ${report.failures.length} 个`];
      for (const fail of report.failures.slice(0, 10)) {
        const name = fail.path.split(/[\\/]/).pop() ?? fail.path;
        lines.push(`· ${name}：${fail.error}`);
      }
      if (report.failures.length > 10) {
        lines.push(`· …其余 ${report.failures.length - 10} 条见控制台`);
        console.warn("[batch] 转换失败明细", report.failures);
      }
      this.setResult(lines, report.failures.length > 0);
      // 只移除成功的条目：失败文件保留在列表里，用户可修正后重试
      // （原来「有成功就清空全部」会让失败项也消失，无从针对性重试）
      if (report.written.length > 0) {
        const done = new Set(report.written);
        this.files = this.files.filter((f) => !done.has(f));
      }
      this.renderFiles();
    } catch (e) {
      this.setResult(`转换失败：${String(e).split("\n")[0]}`, true);
    } finally {
      this.runBtn.disabled = false;
    }
  }

  private setResult(lines: string | string[], isError: boolean): void {
    this.resultEl.innerHTML = "";
    this.resultEl.classList.toggle("batch-error", isError);
    const list = Array.isArray(lines) ? lines : [lines];
    for (const line of list) {
      const row = document.createElement("div");
      row.textContent = line;
      this.resultEl.append(row);
    }
  }
}
