/**
 * 「另存为指定编码」对话框：选择目标编码后走系统保存对话框。
 * 换行符与 BOM 沿用当前标签设置，只有编码按所选改写。
 */

export class SaveEncodingDialog {
  private backdrop: HTMLElement | null = null;

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
  }

  /**
   * @param encodings 可选编码（来自当前文件的候选编码）
   * @param current 当前编码（默认选中）
   * @param onConfirm 选择编码并确认后的回调
   */
  open(
    encodings: string[],
    current: string,
    onConfirm: (encoding: string) => void,
    context = "",
  ): void {
    if (this.isOpen) return;

    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");

    const title = document.createElement("h3");
    title.textContent = "另存为指定编码";
    dialog.append(title);

    const hint = document.createElement("p");
    hint.className = "dialog-text";
    hint.textContent = context
      ? `${context}；内容按所选编码写入新文件，换行符与 BOM 沿用当前设置。`
      : "内容按所选编码写入新文件，换行符与 BOM 沿用当前设置。";
    dialog.append(hint);

    const row = document.createElement("div");
    row.className = "dialog-fields";
    const label = document.createElement("label");
    label.textContent = "目标编码";
    const select = document.createElement("select");
    select.className = "dialog-input";
    for (const enc of encodings) {
      const opt = document.createElement("option");
      opt.value = enc;
      opt.textContent = enc;
      select.append(opt);
    }
    select.value = encodings.includes(current) ? current : (encodings[0] ?? "UTF-8");
    row.append(label, select);
    dialog.append(row);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => this.close());
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "primary";
    okBtn.textContent = "选择路径并保存";
    const confirm = () => {
      const encoding = select.value;
      this.close();
      onConfirm(encoding);
    };
    okBtn.addEventListener("click", confirm);
    actions.append(cancelBtn, okBtn);
    dialog.append(actions);

    backdrop.append(dialog);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    });
    document.body.append(backdrop);
    this.backdrop = backdrop;
    select.focus();
  }
}
