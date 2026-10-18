/**
 * 通用文本输入对话框。
 * 为什么不用 window.prompt：Tauri 运行时只 patch 了 alert/confirm
 * （路由到 dialog 插件），prompt 未接管、webview 原生行为不可靠，
 * 故用自绘模态（复用列编辑器的 .dialog 样式）。
 */

export function promptText(message: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");

    const title = document.createElement("h3");
    title.textContent = message;
    dialog.append(title);

    const input = document.createElement("input");
    input.className = "dialog-input";
    input.value = initial;
    dialog.append(input);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "primary";
    okBtn.textContent = "确定";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    actions.append(cancelBtn, okBtn);
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const done = (value: string | null) => {
      backdrop.remove();
      resolve(value);
    };

    okBtn.addEventListener("click", () => done(input.value));
    cancelBtn.addEventListener("click", () => done(null));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(null);
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
      if (e.key === "Enter") {
        e.preventDefault();
        done(input.value);
      }
    });

    input.focus();
    input.select();
  });
}

/**
 * 关闭未保存文件的三选确认（VS Code 风格）：
 * 保存 / 不保存 / 取消。
 */
export function confirmCloseDirty(name: string): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");

    const title = document.createElement("h3");
    title.textContent = `「${name}」有未保存的更改`;
    dialog.append(title);

    const text = document.createElement("p");
    text.className = "dialog-text";
    text.textContent = "是否在关闭前保存更改？";
    dialog.append(text);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary";
    saveBtn.textContent = "保存";
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "danger";
    discardBtn.textContent = "不保存";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    actions.append(cancelBtn, discardBtn, saveBtn);
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const done = (value: "save" | "discard" | "cancel") => {
      backdrop.remove();
      resolve(value);
    };

    saveBtn.addEventListener("click", () => done("save"));
    discardBtn.addEventListener("click", () => done("discard"));
    cancelBtn.addEventListener("click", () => done("cancel"));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done("cancel");
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done("cancel");
    });

    saveBtn.focus();
  });
}
