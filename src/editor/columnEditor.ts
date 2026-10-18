import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * 列编辑器（Alt+C，设计文档 3.1）：
 * 对选区覆盖的每一行，在选区锚点列插入内容。
 * - 固定文本 / 递增数字（起始值·步长·位数补零）/ 日期
 * 典型场景：百行批量加 INSERT INTO 前缀、去行尾逗号、生成序号。
 * 列选择本身由 @codemirror/view 的 rectangularSelection 提供（spike 结论）。
 */

type ColumnMode = "text" | "number" | "date";

interface ColumnInsert {
  pos: number;
  text: string;
}

/** 收集每行插入点：矩形选区天然每行一个 range；普通多行选区按锚点列展开 */
function collectInsertions(
  state: EditorState,
  textFor: (index: number) => string,
): ColumnInsert[] {
  const insertions: ColumnInsert[] = [];
  const seenLines = new Set<number>();
  let index = 0;

  for (const range of state.selection.ranges) {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const fromLine = state.doc.lineAt(from);
    const toLine = state.doc.lineAt(to);
    const col = from - fromLine.from;
    for (let ln = fromLine.number; ln <= toLine.number; ln++) {
      if (seenLines.has(ln)) continue;
      seenLines.add(ln);
      const line = state.doc.line(ln);
      insertions.push({
        pos: Math.min(line.from + col, line.to),
        text: textFor(index++),
      });
    }
  }
  return insertions;
}

/** 执行列插入（单个事务，倒序应用避免偏移失效） */
export function applyColumnText(view: EditorView, textFor: (index: number) => string): void {
  const insertions = collectInsertions(view.state, textFor);
  if (insertions.length === 0) return;
  insertions.sort((a, b) => b.pos - a.pos);
  view.dispatch({
    changes: insertions.map((i) => ({ from: i.pos, insert: i.text })),
  });
}

function formatDate(fmt: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return fmt
    .replace("YYYY", String(now.getFullYear()))
    .replace("MM", pad(now.getMonth() + 1))
    .replace("DD", pad(now.getDate()))
    .replace("HH", pad(now.getHours()))
    .replace("mm", pad(now.getMinutes()))
    .replace("ss", pad(now.getSeconds()));
}

/** 打开列编辑器对话框 */
export function openColumnEditor(view: EditorView): void {
  // 避免重复打开
  if (document.querySelector(".dialog-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "列编辑器");

  const title = document.createElement("h3");
  title.textContent = "列编辑器";
  dialog.append(title);

  // ---- 模式选择 ----
  const modeRow = document.createElement("div");
  modeRow.className = "dialog-row";
  const modes: { value: ColumnMode; label: string }[] = [
    { value: "text", label: "固定文本" },
    { value: "number", label: "递增数字" },
    { value: "date", label: "日期" },
  ];
  for (const m of modes) {
    const label = document.createElement("label");
    label.className = "dialog-radio";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "column-mode";
    radio.value = m.value;
    radio.checked = m.value === "text";
    label.append(radio, document.createTextNode(m.label));
    modeRow.append(label);
  }
  dialog.append(modeRow);

  // ---- 各模式字段 ----
  const textPanel = fieldRow("插入文本", input("col-text", "例如：INSERT INTO t VALUES ("));
  const numberPanel = document.createElement("div");
  numberPanel.className = "dialog-fields";
  numberPanel.append(
    fieldRow("起始值", input("col-start", "1", "number")),
    fieldRow("步长", input("col-step", "1", "number")),
    fieldRow("位数（补零）", input("col-digits", "1", "number")),
  );
  const datePanel = fieldRow("格式", dateFormatSelect());
  datePanel.classList.add("dialog-fields");

  const panels: Record<ColumnMode, HTMLElement> = {
    text: textPanel,
    number: numberPanel,
    date: datePanel,
  };
  dialog.append(textPanel, numberPanel, datePanel);

  const syncPanels = () => {
    const mode = currentMode();
    (Object.keys(panels) as ColumnMode[]).forEach((k) => {
      panels[k].classList.toggle("hidden", k !== mode);
    });
  };
  const currentMode = (): ColumnMode => {
    const checked = dialog.querySelector<HTMLInputElement>("input[name=column-mode]:checked");
    return (checked?.value as ColumnMode) ?? "text";
  };
  modeRow.addEventListener("change", syncPanels);
  syncPanels();

  // ---- 按钮 ----
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const okBtn = button("确定", "primary");
  const cancelBtn = button("取消");
  actions.append(cancelBtn, okBtn);
  dialog.append(actions);
  backdrop.append(dialog);
  document.body.append(backdrop);

  const close = () => backdrop.remove();

  const confirm = () => {
    const mode = currentMode();
    if (mode === "text") {
      const text = val("col-text");
      applyColumnText(view, () => text);
    } else if (mode === "number") {
      const start = num("col-start", 1);
      const step = num("col-step", 1);
      const digits = Math.max(1, num("col-digits", 1));
      applyColumnText(view, (i) => String(start + i * step).padStart(digits, "0"));
    } else {
      const fmt = val("col-date-format") || "YYYY-MM-DD";
      const now = new Date();
      applyColumnText(view, () => formatDate(fmt, now));
    }
    close();
  };

  okBtn.addEventListener("click", confirm);
  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  });

  (document.getElementById("col-text") as HTMLInputElement | null)?.focus();
}

// ---- DOM 小工具 ----

function input(id: string, placeholder = "", type = "text"): HTMLElement {
  const el = document.createElement("input");
  el.id = id;
  el.type = type;
  el.placeholder = placeholder;
  el.className = "dialog-input";
  return el;
}

function fieldRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "dialog-fields";
  const l = document.createElement("label");
  l.textContent = label;
  l.htmlFor = control.id;
  row.append(l, control);
  return row;
}

function dateFormatSelect(): HTMLElement {
  const select = document.createElement("select");
  select.id = "col-date-format";
  select.className = "dialog-input";
  for (const fmt of ["YYYY-MM-DD", "YYYY-MM-DD HH:mm:ss", "YYYYMMDD"]) {
    const opt = document.createElement("option");
    opt.value = fmt;
    opt.textContent = fmt;
    select.append(opt);
  }
  return select;
}

function button(text: string, variant: "primary" | "normal" = "normal"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = text;
  if (variant === "primary") btn.classList.add("primary");
  return btn;
}

function val(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
}

function num(id: string, fallback: number): number {
  const n = Number.parseInt(val(id), 10);
  return Number.isFinite(n) ? n : fallback;
}
