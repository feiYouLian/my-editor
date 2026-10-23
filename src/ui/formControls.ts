/**
 * 设置中心小控件工厂：分区 / 单选组 / 复选行 / 数字行 / 下拉行 / 滑杆行。
 * 纯 DOM 构建，零业务依赖——原内嵌在 panels/settingsPanel.ts 的类外函数，
 * 供 settings/ 三个分类页共用。
 */

/** 带标题与描述的分区；返回外壳与内容容器 */
export function section(
  title: string,
  desc?: string,
): { el: HTMLElement; body: HTMLElement } {
  const el = document.createElement("div");
  el.className = "settings-section";
  const h = document.createElement("div");
  h.className = "settings-section-title";
  h.textContent = title;
  el.append(h);
  if (desc) {
    const d = document.createElement("div");
    d.className = "settings-section-desc";
    d.textContent = desc;
    el.append(d);
  }
  const body = document.createElement("div");
  body.className = "settings-section-body";
  el.append(body);
  return { el, body };
}

export function radioGroup<T extends string>(
  label: string,
  options: { value: T; label: string }[],
  current: T,
  onChange: (value: T) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";
  const labelEl = document.createElement("span");
  labelEl.className = "settings-row-label";
  labelEl.textContent = label;
  row.append(labelEl);
  const group = document.createElement("div");
  group.className = "settings-radios";
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `settings-radio${opt.value === current ? " active" : ""}`;
    btn.textContent = opt.label;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(opt.value === current));
    btn.addEventListener("click", () => {
      group.querySelectorAll(".settings-radio").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-checked", "true");
      onChange(opt.value);
    });
    group.append(btn);
  }
  row.append(group);
  return row;
}

export function checkRow(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const row = document.createElement("label");
  row.className = "settings-row settings-row-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const text = document.createElement("span");
  text.textContent = label;
  row.append(input, text);
  return row;
}

export function numberRow(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (value: number) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";
  const labelEl = document.createElement("span");
  labelEl.className = "settings-row-label";
  labelEl.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.className = "settings-number";
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.addEventListener("change", () => {
    const n = Math.min(max, Math.max(min, Number(input.value) || min));
    input.value = String(n);
    onChange(n);
  });
  row.append(labelEl, input);
  return row;
}

export function selectRow<T extends string>(
  label: string,
  options: { value: T; label: string }[],
  current: T,
  onChange: (value: T) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";
  const labelEl = document.createElement("span");
  labelEl.className = "settings-row-label";
  labelEl.textContent = label;
  const select = document.createElement("select");
  select.className = "settings-select";
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === current) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", () => onChange(select.value as T));
  row.append(labelEl, select);
  return row;
}

/**
 * 滑杆行（百分比 15–85，右侧实时显示数值）。
 * input 事件只改界面与即时预览，change 事件才落盘——
 * 拖动过程中每像素都写 config.json 没有意义。
 */
export function sliderRow(
  label: string,
  /** 0–1 的比例值 */
  ratio: number,
  onInput: (ratio: number) => void,
  onCommit: (ratio: number) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-row";
  const labelEl = document.createElement("span");
  labelEl.className = "settings-row-label";
  labelEl.textContent = label;
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "settings-slider";
  slider.min = "15";
  slider.max = "85";
  slider.value = String(Math.round(ratio * 100));
  const value = document.createElement("span");
  value.className = "settings-slider-value";
  value.textContent = `${slider.value}%`;
  slider.addEventListener("input", () => {
    value.textContent = `${slider.value}%`;
    onInput(Number(slider.value) / 100);
  });
  slider.addEventListener("change", () => {
    onCommit(Number(slider.value) / 100);
  });
  row.append(labelEl, slider, value);
  return row;
}
