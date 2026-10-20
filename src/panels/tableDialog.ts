import { buildMarkdownTable } from "../editor/markdownTools";

/**
 * Markdown 表格生成对话框：输入列数与数据行数，实时预览后插入。
 * 复用通用 .dialog 样式。
 */

const MAX_COLS = 12;
const MAX_ROWS = 50;

export class MarkdownTableDialog {
  private backdrop: HTMLElement | null = null;
  private colsInput!: HTMLInputElement;
  private rowsInput!: HTMLInputElement;
  private preview!: HTMLPreElement;

  constructor(private onInsert: (cols: number, rows: number) => void) {}

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
    title.textContent = "插入 Markdown 表格";
    dialog.append(title);

    const colsRow = document.createElement("div");
    colsRow.className = "dialog-fields";
    const colsLabel = document.createElement("label");
    colsLabel.textContent = `列数（1-${MAX_COLS}）`;
    this.colsInput = document.createElement("input");
    this.colsInput.className = "dialog-input";
    this.colsInput.type = "number";
    this.colsInput.min = "1";
    this.colsInput.max = String(MAX_COLS);
    this.colsInput.value = "3";
    this.colsInput.addEventListener("input", () => this.refreshPreview());
    colsRow.append(colsLabel, this.colsInput);

    const rowsRow = document.createElement("div");
    rowsRow.className = "dialog-fields";
    const rowsLabel = document.createElement("label");
    rowsLabel.textContent = `数据行数（0-${MAX_ROWS}）`;
    this.rowsInput = document.createElement("input");
    this.rowsInput.className = "dialog-input";
    this.rowsInput.type = "number";
    this.rowsInput.min = "0";
    this.rowsInput.max = String(MAX_ROWS);
    this.rowsInput.value = "2";
    this.rowsInput.addEventListener("input", () => this.refreshPreview());
    rowsRow.append(rowsLabel, this.rowsInput);

    const previewLabel = document.createElement("p");
    previewLabel.className = "dialog-text";
    previewLabel.textContent = "预览";
    this.preview = document.createElement("pre");
    this.preview.className = "table-preview";

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => this.close());
    const insertBtn = document.createElement("button");
    insertBtn.type = "button";
    insertBtn.className = "primary";
    insertBtn.textContent = "插入";
    insertBtn.addEventListener("click", () => {
      this.onInsert(this.readCols(), this.readRows());
      this.close();
    });
    actions.append(cancelBtn, insertBtn);

    dialog.append(colsRow, rowsRow, previewLabel, this.preview, actions);
    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      if (e.key === "Enter") {
        e.preventDefault();
        this.onInsert(this.readCols(), this.readRows());
        this.close();
      }
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;

    this.refreshPreview();
    this.colsInput.focus();
  }

  private readCols(): number {
    return Number(this.colsInput.value);
  }

  private readRows(): number {
    return Number(this.rowsInput.value);
  }

  private refreshPreview(): void {
    const cols = this.readCols();
    const rows = this.readRows();
    if (!Number.isInteger(cols) || cols < 1 || cols > MAX_COLS) {
      this.preview.textContent = `列数需为 1-${MAX_COLS} 的整数`;
      return;
    }
    if (!Number.isInteger(rows) || rows < 0 || rows > MAX_ROWS) {
      this.preview.textContent = `数据行数需为 0-${MAX_ROWS} 的整数`;
      return;
    }
    this.preview.textContent = buildMarkdownTable(cols, rows);
  }
}
