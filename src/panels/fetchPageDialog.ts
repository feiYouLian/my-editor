/**
 * 从网址抓取网页对话框：URL / 保存目录 / 文件名建议 / 抓取。
 *
 * 抓取前把目录登记进 PathGuard（选目录对话框选中的路径应用此前未见过），
 * 目标已存在时先确认覆盖；实际下载与落盘在 Rust `fetch_url`。
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmAction } from "../ui/dialogs";
import { basenameOf } from "../core/paths";

/** 文件名建议防抖 */
const SUGGEST_DEBOUNCE_MS = 300;

export interface FetchPageDeps {
  onFetched: (path: string) => void;
  showMessage: (text: string) => void;
}

interface FetchResult {
  path: string;
  bytes: number;
  contentType: string;
  finalUrl: string;
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name.replace(/^[\\/]+/, "")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class FetchPageDialog {
  private backdrop: HTMLElement | null = null;
  private urlInput!: HTMLInputElement;
  private dirInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private fetchBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private busy = false;
  private nameTouched = false;
  private suggestTimer: number | null = null;
  /** 建议结果代号：丢弃过期的 IPC 返回 */
  private generation = 0;

  constructor(private deps: FetchPageDeps) {}

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(defaultDir: string): void {
    if (this.isOpen) return;
    this.nameTouched = false;

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "dialog fetch-dialog";
    dialog.setAttribute("role", "dialog");

    const title = document.createElement("h3");
    title.textContent = "从网址抓取网页";

    // 网址
    const urlRow = document.createElement("div");
    urlRow.className = "dialog-fields";
    const urlLabel = document.createElement("label");
    urlLabel.textContent = "网址";
    this.urlInput = document.createElement("input");
    this.urlInput.className = "dialog-input";
    this.urlInput.placeholder = "https://example.com/docs/index.html";
    this.urlInput.spellcheck = false;
    this.urlInput.addEventListener("input", () => this.scheduleSuggestion());
    urlRow.append(urlLabel, this.urlInput);

    // 保存目录
    const dirRow = document.createElement("div");
    dirRow.className = "dialog-fields";
    const dirLabel = document.createElement("label");
    dirLabel.textContent = "保存目录";
    this.dirInput = document.createElement("input");
    this.dirInput.className = "dialog-input";
    this.dirInput.value = defaultDir;
    this.dirInput.readOnly = true;
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.textContent = "选择…";
    pickBtn.addEventListener("click", () => void this.pickDirectory());
    dirRow.append(dirLabel, this.dirInput, pickBtn);

    // 文件名
    const nameRow = document.createElement("div");
    nameRow.className = "dialog-fields";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "文件名";
    this.nameInput = document.createElement("input");
    this.nameInput.className = "dialog-input";
    this.nameInput.placeholder = "page.html";
    this.nameInput.spellcheck = false;
    this.nameInput.addEventListener("input", () => {
      this.nameTouched = true;
    });
    nameRow.append(nameLabel, this.nameInput);

    const hint = document.createElement("p");
    hint.className = "fetch-hint";
    hint.textContent =
      "默认拦截内网 / 本机地址；内网文档站可在 config.json 设置 fetch.allowPrivateNetwork: true";

    this.errorEl = document.createElement("p");
    this.errorEl.className = "dialog-error hidden";

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    this.fetchBtn = document.createElement("button");
    this.fetchBtn.type = "button";
    this.fetchBtn.className = "primary";
    this.fetchBtn.textContent = "抓取";
    this.fetchBtn.addEventListener("click", () => void this.submit());
    this.cancelBtn = document.createElement("button");
    this.cancelBtn.type = "button";
    this.cancelBtn.textContent = "取消";
    this.cancelBtn.addEventListener("click", () => this.close());
    actions.append(this.fetchBtn, this.cancelBtn);

    dialog.append(title, urlRow, dirRow, nameRow, hint, this.errorEl, actions);
    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      if (e.key === "Enter" && e.target !== this.fetchBtn) {
        e.preventDefault();
        void this.submit();
      }
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;
    this.urlInput.focus();
  }

  close(): void {
    if (this.busy) return;
    if (this.suggestTimer !== null) {
      window.clearTimeout(this.suggestTimer);
      this.suggestTimer = null;
    }
    this.generation++;
    this.backdrop?.remove();
    this.backdrop = null;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.fetchBtn.disabled = busy;
    this.cancelBtn.disabled = busy;
    this.fetchBtn.textContent = busy ? "抓取中…" : "抓取";
  }

  private setError(text: string): void {
    this.errorEl.textContent = text;
    this.errorEl.classList.toggle("hidden", !text);
  }

  private scheduleSuggestion(): void {
    if (this.nameTouched) return;
    if (this.suggestTimer !== null) window.clearTimeout(this.suggestTimer);
    this.suggestTimer = window.setTimeout(() => {
      this.suggestTimer = null;
      void this.suggestFilename();
    }, SUGGEST_DEBOUNCE_MS);
  }

  /** 文件名建议走 Rust（与落盘侧净化规则单一来源） */
  private async suggestFilename(): Promise<void> {
    const url = this.urlInput.value.trim();
    if (!url || this.nameTouched) return;
    const gen = ++this.generation;
    try {
      const name = await invoke<string>("suggest_fetch_filename", { url });
      if (gen === this.generation && !this.nameTouched) this.nameInput.value = name;
    } catch {
      // 建议失败不影响手输
    }
  }

  private async pickDirectory(): Promise<void> {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    this.dirInput.value = selected;
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const url = this.urlInput.value.trim();
    const dir = this.dirInput.value.trim();
    let name = this.nameInput.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      this.setError("请输入 http:// 或 https:// 开头的网址");
      return;
    }
    if (!dir) {
      this.setError("请先选择保存目录");
      return;
    }
    if (!name) {
      await this.suggestFilename();
      name = this.nameInput.value.trim() || "page.html";
    }

    const target = joinPath(dir, name);
    this.setBusy(true);
    this.setError("");
    try {
      // 选目录对话框选中的路径应用此前未见过：先登记，否则 ensure_file_scope 会拒绝
      await invoke("register_paths", { paths: [dir] });
      let exists = false;
      try {
        await invoke("probe_file", { path: target });
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        const ok = await confirmAction(`「${name}」已存在，是否覆盖？`, "覆盖");
        if (!ok) return;
      }
      const result = await invoke<FetchResult>("fetch_url", {
        url,
        target,
        overwrite: exists,
      });
      this.deps.onFetched(result.path);
      this.deps.showMessage(
        `已抓取 ${basenameOf(result.path)}（${formatBytes(result.bytes)}）`,
      );
      this.busy = false;
      this.close();
    } catch (e) {
      this.setError(String(e).split("\n")[0] || "抓取失败");
    } finally {
      this.setBusy(false);
    }
  }
}
