/**
 * 通用文本输入对话框。
 * 为什么不用 window.prompt：Tauri 运行时只 patch 了 alert/confirm
 * （路由到 dialog 插件），prompt 未接管、webview 原生行为不可靠，
 * 故用自绘模态（复用列编辑器的 .dialog 样式）。
 */

/** 退场动画时长：与 CSS 的 .dialog-backdrop 过渡保持一致 */
const DIALOG_MOTION_MS = 120;

/**
 * 关闭对话框：先淡出再移除 DOM。
 * 回调/resolve 必须**立即**执行（调用方可能紧接着开下一个对话框），
 * 只把 DOM 移除延后；用 dataset 防止 Esc + 点击遮罩重复触发。
 */
function dismiss(backdrop: HTMLElement): void {
  if (backdrop.dataset.closing === "1") return;
  backdrop.dataset.closing = "1";
  backdrop.classList.add("motion-leave");
  window.setTimeout(() => backdrop.remove(), DIALOG_MOTION_MS);
}

/**
 * Tab 焦点陷阱：模态内循环。
 * 不做的话按 Tab 会跑到模态背后的编辑器里，用户完全失去上下文。
 */
function trapFocus(dialog: HTMLElement): void {
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]',
      ),
    ].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = active !== null && dialog.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

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
  trapFocus(dialog);

    const done = (value: string | null) => {
      dismiss(backdrop);
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
 * 通用确认对话框（确定/取消），返回是否确认。
 * 为什么不用 window.confirm：Tauri 运行时的 confirm 由 dialog 插件接管，
 * 异步回调不阻塞后续代码，确认结果会晚于副作用发生。
 */
export function confirmAction(message: string, confirmLabel = "确定"): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");

    const title = document.createElement("h3");
    title.textContent = message;
    dialog.append(title);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "danger";
    okBtn.textContent = confirmLabel;
    actions.append(cancelBtn, okBtn);
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);
  trapFocus(dialog);

    const done = (ok: boolean) => {
      dismiss(backdrop);
      resolve(ok);
    };

    okBtn.addEventListener("click", () => done(true));
    cancelBtn.addEventListener("click", () => done(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(false);
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(false);
    });

    okBtn.focus();
  });
}

/**
 * 错误详情对话框：标题 + 可滚动、可复制的原始输出（如 git stderr）。
 *
 * 为什么不直接复用状态栏消息：git 的失败原因常常是多行
 * （如 `fetch first` + `Updates were rejected`），瞬时消息只能看到首行，
 * 排查时无法复制。模态默认保留焦点，「复制详细信息」优先。
 */
export interface DialogAction {
  label: string;
  /** 点击后先关闭对话框再执行（避免动作里弹新框时被自己的遮罩挡住） */
  run: () => void;
}

export function showErrorDialog(title: string, detail = "", extraActions: DialogAction[] = []): void {
  // 失败可能密集触发（如连点刷新）：同一时刻只保留一个模态。
  // 排除正在淡出的那一层，否则"关掉一个立刻又失败"会被吞掉。
  if (document.querySelector(".dialog-backdrop:not(.motion-leave)")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "dialog error-dialog";
  dialog.setAttribute("role", "alertdialog");

  const heading = document.createElement("h3");
  heading.textContent = title;
  dialog.append(heading);

  const pre = document.createElement("pre");
  pre.className = "dialog-pre";
  pre.textContent = detail.trim() || "（未返回详细信息）";
  dialog.append(pre);

  const actions = document.createElement("div");
  actions.className = "dialog-actions";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "复制详细信息";
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(detail.trim()).then(
      () => (copyBtn.textContent = "已复制"),
      () => (copyBtn.textContent = "复制失败"),
    );
  });

  // 失败后的"下一步"直接给在框里（如保存失败的「另存为」「重新载入」），
  // 否则用户得自己去找入口 —— 这正是 H1 反馈里最扎人的一点
  for (const action of extraActions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      done();
      action.run();
    });
    actions.append(btn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "primary";
  closeBtn.textContent = "关闭";
  actions.append(copyBtn, closeBtn);
  dialog.append(actions);
  backdrop.append(dialog);
  document.body.append(backdrop);
  trapFocus(dialog);

  const done = (): void => {
    document.removeEventListener("keydown", onKey);
    dismiss(backdrop);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" && e.key !== "Enter") return;
    // 只在最上层响应：错误框可能与设置/确认框同时存在，一次 Esc 只关一个
    const layers = document.querySelectorAll(".dialog-backdrop");
    if (layers.length > 0 && layers[layers.length - 1] !== backdrop) return;
    e.preventDefault();
    done();
  };

  closeBtn.addEventListener("click", done);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) done();
  });
  document.addEventListener("keydown", onKey);
  closeBtn.focus();
}

/**
 * 关闭未保存文件的三选确认：
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
  trapFocus(dialog);

    const done = (value: "save" | "discard" | "cancel") => {
      dismiss(backdrop);
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

/**
 * 退出前的未保存确认（三选）。
 * 与 confirmCloseDirty 的区别：这里一次处理多个文件，且必须能"取消整个退出"。
 */
export function confirmExitDirty(
  names: string[],
  opts: { draftAutosave?: boolean } = {},
): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");

    const title = document.createElement("h3");
    title.textContent =
      names.length === 1 ? `「${names[0]}」有未保存的更改` : `${names.length} 个文件有未保存的更改`;
    dialog.append(title);

    const list = document.createElement("p");
    list.className = "dialog-text";
    const shown = names.slice(0, 5).join("、");
    const scope =
      names.length > 5 ? `${shown} 等 ${names.length} 个文件` : `${shown}`;
    // 「不保存退出」的后果必须写明：否则用户只看到三个按钮，不知道哪个会丢内容
    const consequence = opts.draftAutosave
      ? "选择「不保存退出」会丢弃这些修改（已自动写入草稿，下次启动可恢复）。"
      : "选择「不保存退出」将永久丢失这些修改（草稿自动保存已关闭）。";
    list.textContent = `${scope}尚未保存。${consequence}`;
    dialog.append(list);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary";
    saveBtn.textContent = "保存全部并退出";
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "danger";
    discardBtn.textContent = "不保存退出";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    actions.append(cancelBtn, discardBtn, saveBtn);
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);
  trapFocus(dialog);

    const done = (value: "save" | "discard" | "cancel") => {
      dismiss(backdrop);
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

    // 默认聚焦"保存"：误按 Enter 的最坏结果是多保存一次，而不是丢内容
    saveBtn.focus();
  });
}
