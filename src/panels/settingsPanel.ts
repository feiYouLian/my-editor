/**
 * 设置中心（B7，见设计文档第 15 章）。
 * 统一入口：菜单 设置 ▸ 设置… / 命令面板「打开设置…」/ Ctrl+,
 * 三类配置：主题 / 快捷键 / 页面布局。
 * 所有改动即时生效并写回 config.json（Rust 侧原子替换），无需重启。
 */

import {
  getConfig,
  updateSettings,
  type EditorThemeSetting,
  type ThemeSetting,
  type ColumnModifier,
  type StatusBarFieldEntry,
} from "../config/settings";
import {
  formatKey,
  findKeyConflict,
  isReservedKey,
  keyCommands,
  resolveKey,
  isOverridden,
  setKeyOverride,
  suspendKeyDispatch,
  eventToKeyNotation,
  eventKeyName,
  normalizeNotation,
  type KeyCommand,
} from "../config/keybindings";
import { confirmAction } from "../ui/dialogs";

export interface SettingsPanelCallbacks {
  /** 侧栏显隐切换（立即应用到界面） */
  onSidebarVisible: (visible: boolean) => void;
  /** 双栏默认分栏比例（立即应用到界面） */
  onSplitRatio: (ratio: number) => void;
  /** 默认视图模式（应用到当前可预览标签） */
  onViewMode: (mode: "edit" | "preview" | "split") => void;
  /** 状态栏消息 */
  onMessage: (text: string) => void;
}

type Category = "theme" | "keybindings" | "layout";

const CATEGORY_LABELS: { id: Category; label: string }[] = [
  { id: "theme", label: "主题" },
  { id: "keybindings", label: "快捷键" },
  { id: "layout", label: "页面布局" },
];

const THEME_OPTIONS: { value: ThemeSetting; label: string }[] = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "high-contrast", label: "高对比度" },
  { value: "system", label: "跟随系统" },
];

const EDITOR_THEME_OPTIONS: { value: EditorThemeSetting; label: string }[] = [
  { value: "dark", label: "深色（one-dark）" },
  { value: "light", label: "浅色" },
  { value: "high-contrast", label: "高对比度" },
];

const VIEW_MODE_OPTIONS: { value: "edit" | "preview" | "split"; label: string }[] = [
  { value: "edit", label: "编辑" },
  { value: "preview", label: "预览" },
  { value: "split", label: "双栏" },
];

const COLUMN_MODIFIERS: ColumnModifier[] = ["Alt", "Control", "Shift", "Meta"];

const STATUS_FIELD_LABELS: Record<string, string> = {
  path: "文件路径",
  readonly: "只读标记",
  size: "文件大小",
  encoding: "编码",
  newline: "换行符",
  language: "语言",
  whitespace: "空白字符开关",
  cursor: "光标位置",
  lines: "总行数",
  dirty: "未保存标记",
};

/** 状态栏字段：补齐新版本新增字段（旧配置缺省时插入默认位置） */
function withAllFields(fields: StatusBarFieldEntry[]): StatusBarFieldEntry[] {
  const known = new Set(fields.map((f) => f.id));
  const merged = [...fields];
  for (const id of Object.keys(STATUS_FIELD_LABELS)) {
    if (!known.has(id)) merged.push({ id, visible: true });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 小控件
// ---------------------------------------------------------------------------

function section(title: string, desc?: string): { el: HTMLElement; body: HTMLElement } {
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

/** 列编辑器默认键（CM6 记法） */
const DEFAULT_COLUMN_EDITOR_KEY = "Alt+c";

function radioGroup<T extends string>(
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

function checkRow(
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

function numberRow(
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

function selectRow<T extends string>(
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

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

export class SettingsPanel {
  private backdrop: HTMLElement | null = null;
  private category: Category = "theme";
  /** 录制中的清理函数（快捷键重绑定） */
  private stopRecording: (() => void) | null = null;

  constructor(private readonly callbacks: SettingsPanelCallbacks) {}

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(category: Category = this.category): void {
    if (this.backdrop) {
      this.switchCategory(category);
      return;
    }
    this.category = category;

    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "settings-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "设置");

    // 头部
    const head = document.createElement("div");
    head.className = "settings-head";
    const title = document.createElement("h3");
    title.textContent = "设置";
    head.append(title);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.textContent = "×";
    closeBtn.title = "关闭（Esc）";
    head.append(closeBtn);
    dialog.append(head);

    // 左侧分类导航
    const body = document.createElement("div");
    body.className = "settings-body";
    const nav = document.createElement("nav");
    nav.className = "settings-nav";
    for (const cat of CATEGORY_LABELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `settings-nav-item${cat.id === this.category ? " active" : ""}`;
      btn.dataset.cat = cat.id;
      btn.textContent = cat.label;
      btn.addEventListener("click", () => this.switchCategory(cat.id));
      nav.append(btn);
    }
    body.append(nav);

    const main = document.createElement("div");
    main.className = "settings-main";
    body.append(main);
    dialog.append(body);

    // 底部
    const foot = document.createElement("div");
    foot.className = "settings-foot";
    const hint = document.createElement("span");
    hint.className = "settings-hint";
    hint.textContent = "所有改动即时生效并自动保存到 config.json";
    foot.append(hint);
    const closeFooter = document.createElement("button");
    closeFooter.type = "button";
    closeFooter.className = "primary";
    closeFooter.textContent = "关闭";
    foot.append(closeFooter);
    dialog.append(foot);

    backdrop.append(dialog);
    document.body.append(backdrop);
    this.backdrop = backdrop;

    const done = () => this.close();
    closeBtn.addEventListener("click", done);
    closeFooter.addEventListener("click", done);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.stopRecording) done();
    });

    this.renderCategory(main);
  }

  close(): void {
    this.stopRecording?.();
    this.backdrop?.remove();
    this.backdrop = null;
  }

  toggle(): void {
    if (this.backdrop) this.close();
    else this.open();
  }

  private switchCategory(cat: Category): void {
    this.category = cat;
    if (!this.backdrop) return;
    this.backdrop.querySelectorAll(".settings-nav-item").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.cat === cat);
    });
    const main = this.backdrop.querySelector<HTMLElement>(".settings-main");
    if (main) this.renderCategory(main);
  }

  private renderCategory(main: HTMLElement): void {
    this.stopRecording?.();
    main.innerHTML = "";
    main.scrollTop = 0;
    if (this.category === "theme") this.renderTheme(main);
    else if (this.category === "keybindings") this.renderKeybindings(main);
    else this.renderLayout(main);
  }

  // ---- 主题 ----

  private renderTheme(main: HTMLElement): void {
    const cfg = getConfig();

    const uiSection = section(
      "应用主题",
      "应用界面配色；「跟随系统」随系统深浅色偏好自动切换。",
    );
    uiSection.body.append(
      radioGroup<ThemeSetting>("界面主题", THEME_OPTIONS, cfg.theme, (value) => {
        void updateSettings({ theme: value });
        this.callbacks.onMessage(`界面主题已切换为 ${THEME_OPTIONS.find((o) => o.value === value)?.label}`);
      }),
    );
    main.append(uiSection.el);

    const editorSection = section(
      "编辑器主题",
      "代码区语法配色，独立于应用界面主题。",
    );
    editorSection.body.append(
      radioGroup<EditorThemeSetting>(
        "编辑器语法主题",
        EDITOR_THEME_OPTIONS,
        cfg.editorTheme,
        (value) => {
          void updateSettings({ editorTheme: value });
          this.callbacks.onMessage("编辑器主题已切换");
        },
      ),
    );
    const note = document.createElement("div");
    note.className = "settings-note";
    note.textContent = "Markdown / HTML 预览固定为浅色文档样式（纸张感），不随主题切换。";
    editorSection.body.append(note);
    main.append(editorSection.el);
  }

  // ---- 快捷键 ----

  private renderKeybindings(main: HTMLElement): void {
    const head = document.createElement("div");
    head.className = "settings-kb-head";
    const filter = document.createElement("input");
    filter.type = "text";
    filter.className = "settings-kb-filter";
    filter.placeholder = "过滤命令…";
    head.append(filter);
    const resetAll = document.createElement("button");
    resetAll.type = "button";
    resetAll.textContent = "全部恢复默认";
    resetAll.addEventListener("click", () => {
      void confirmAction("确定要将所有快捷键恢复为默认值吗？自定义绑定将丢失。", "恢复默认").then(
        (ok) => {
          if (!ok) return;
          void updateSettings({
            keybindings: [],
            // 列编辑器键走 editorEnhancements，一并复位
            editorEnhancements: {
              ...getConfig().editorEnhancements,
              columnEditorKey: DEFAULT_COLUMN_EDITOR_KEY,
            },
          });
          this.renderCategory(main);
          this.callbacks.onMessage("快捷键已全部恢复默认");
        },
      );
    });
    head.append(resetAll);
    main.append(head);

    const list = document.createElement("div");
    list.className = "settings-kb-list";
    main.append(list);

    const renderList = (query: string): void => {
      list.innerHTML = "";
      const q = query.trim().toLowerCase();
      const groups = new Map<string, KeyCommand[]>();
      for (const cmd of keyCommands()) {
        if (q && !cmd.title.toLowerCase().includes(q) && !cmd.id.includes(q)) continue;
        const arr = groups.get(cmd.section) ?? [];
        arr.push(cmd);
        groups.set(cmd.section, arr);
      }
      if (groups.size === 0) {
        const empty = document.createElement("div");
        empty.className = "settings-kb-empty";
        empty.textContent = "无匹配命令";
        list.append(empty);
        return;
      }
      for (const [sectionName, cmds] of groups) {
        const groupEl = document.createElement("div");
        groupEl.className = "settings-kb-group";
        const title = document.createElement("div");
        title.className = "settings-kb-group-title";
        title.textContent = sectionName;
        groupEl.append(title);
        for (const cmd of cmds) {
          groupEl.append(this.renderKeyRow(cmd, main));
        }
        list.append(groupEl);
      }
    };

    filter.addEventListener("input", () => renderList(filter.value));
    renderList("");
  }

  private renderKeyRow(cmd: KeyCommand, main: HTMLElement): HTMLElement {
    const cfg = getConfig();
    const row = document.createElement("div");
    row.className = "settings-kb-row";

    const name = document.createElement("span");
    name.className = "settings-kb-name";
    name.textContent = cmd.title;
    row.append(name);

    const keyCell = document.createElement(cmd.fixed ? "span" : "button");
    keyCell.className = "settings-kb-key";
    if (cmd.fixed) {
      // 列编辑器键特殊：走 editorEnhancements.columnEditorKey 重绑
      if (cmd.id === "edit.columnEditor") {
        keyCell.textContent = formatKey(
          normalizeNotation(cfg.editorEnhancements.columnEditorKey),
        );
      } else {
        keyCell.textContent = formatKey(cmd.defaultKey);
      }
      const badge = document.createElement("span");
      badge.className = "settings-kb-badge";
      badge.textContent = cmd.id === "edit.columnEditor" ? "可改绑" : "内置";
      keyCell.append(badge);
    } else {
      keyCell.textContent = formatKey(resolveKey(cmd, cfg));
      keyCell.title = "点击重绑定（Esc 清除绑定）";
      (keyCell as HTMLElement).addEventListener("click", () => {
        this.recordKey(cmd, keyCell as HTMLElement, main);
      });
    }
    row.append(keyCell);

    const action = document.createElement("span");
    action.className = "settings-kb-action";
    const special = cmd.id === "edit.columnEditor";
    const overridden = special
      ? cfg.editorEnhancements.columnEditorKey !== DEFAULT_COLUMN_EDITOR_KEY
      : isOverridden(cmd, cfg);
    if (overridden) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "settings-kb-reset";
      reset.textContent = "恢复默认";
      reset.addEventListener("click", () => {
        if (special) {
          void updateSettings({
            editorEnhancements: {
              ...cfg.editorEnhancements,
              columnEditorKey: DEFAULT_COLUMN_EDITOR_KEY,
            },
          });
        } else {
          void updateSettings({ keybindings: setKeyOverride(cfg, cmd.id, "") });
        }
        this.renderCategory(main);
      });
      action.append(reset);
    } else if (!cmd.fixed) {
      const hint = document.createElement("span");
      hint.className = "settings-kb-default-hint";
      hint.textContent = resolveKey(cmd, cfg) ? "默认" : "未绑定";
      action.append(hint);
    }
    row.append(action);
    return row;
  }

  /** 录制新键位：挂起全局派发 → 捕获一次组合键 → 冲突检测 → 写回 */
  private recordKey(cmd: KeyCommand, cell: HTMLElement, main: HTMLElement): void {
    this.stopRecording?.();
    const original = cell.textContent;
    cell.textContent = "按下新键位…（Esc 清除）";
    cell.classList.add("recording");
    suspendKeyDispatch(true);

    const finish = (): void => {
      window.removeEventListener("keydown", onKey, true);
      suspendKeyDispatch(false);
      cell.classList.remove("recording");
      this.stopRecording = null;
    };

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      // 纯修饰键：继续等待完整组合
      if (!eventKeyName(e)) return;
      // Esc 无修饰：清除绑定
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        finish();
        if (cmd.id === "edit.columnEditor") {
          void updateSettings({
            editorEnhancements: {
              ...getConfig().editorEnhancements,
              columnEditorKey: DEFAULT_COLUMN_EDITOR_KEY,
            },
          });
        } else {
          void updateSettings({ keybindings: setKeyOverride(getConfig(), cmd.id, "") });
        }
        this.renderCategory(main);
        this.callbacks.onMessage(`「${cmd.title}」绑定已清除`);
        return;
      }
      const notation = eventToKeyNotation(e);
      if (!notation) return;
      finish();

      if (isReservedKey(notation, getConfig())) {
        this.callbacks.onMessage(`${formatKey(notation)} 被编辑器/系统占用，无法绑定`);
        cell.textContent = original;
        return;
      }
      const conflict = findKeyConflict(notation, getConfig(), cmd.id);
      const apply = (): void => {
        if (cmd.id === "edit.columnEditor") {
          // 记法 → CM6 keymap 记法（字母主键小写）
          const parts = notation.split("-");
          const key = parts.pop()!;
          const cm6Key = /^[A-Z]$/.test(key) ? key.toLowerCase() : key;
          void updateSettings({
            editorEnhancements: {
              ...getConfig().editorEnhancements,
              columnEditorKey: [...parts, cm6Key].join("-"),
            },
          });
        } else {
          void updateSettings({ keybindings: setKeyOverride(getConfig(), cmd.id, notation) });
        }
        this.renderCategory(main);
        this.callbacks.onMessage(`「${cmd.title}」已绑定到 ${formatKey(notation)}`);
      };
      if (conflict) {
        void confirmAction(
          `${formatKey(notation)} 已绑定到「${conflict.title}」，确定改绑到「${cmd.title}」吗？`,
          "改绑",
        ).then((ok) => {
          if (ok) apply();
          else this.renderCategory(main);
        });
      } else {
        apply();
      }
    };

    this.stopRecording = finish;
    window.addEventListener("keydown", onKey, true);
    cell.focus();
  }

  // ---- 页面布局 ----

  private renderLayout(main: HTMLElement): void {
    const cfg = getConfig();

    const sidebarSection = section("侧栏");
    sidebarSection.body.append(
      checkRow("显示侧栏（文件树 / 搜索）", cfg.layout.sidebarVisible, (value) => {
        this.callbacks.onSidebarVisible(value);
        void updateSettings({ layout: { ...cfg.layout, sidebarVisible: value } });
      }),
    );
    main.append(sidebarSection.el);

    const previewSection = section("双栏预览", "Markdown / HTML 编辑与预览的分栏方式。");
    previewSection.body.append(
      radioGroup<"edit" | "preview" | "split">(
        "默认视图模式",
        VIEW_MODE_OPTIONS,
        cfg.layout.defaultViewMode,
        (value) => {
          this.callbacks.onViewMode(value);
          void updateSettings({ layout: { ...getConfig().layout, defaultViewMode: value } });
        },
      ),
    );
    const ratioRow = document.createElement("div");
    ratioRow.className = "settings-row";
    const ratioLabel = document.createElement("span");
    ratioLabel.className = "settings-row-label";
    ratioLabel.textContent = "默认分栏比例";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "settings-slider";
    slider.min = "15";
    slider.max = "85";
    slider.value = String(Math.round(cfg.layout.splitRatio * 100));
    const ratioValue = document.createElement("span");
    ratioValue.className = "settings-slider-value";
    ratioValue.textContent = `${slider.value}%`;
    slider.addEventListener("input", () => {
      ratioValue.textContent = `${slider.value}%`;
      const ratio = Number(slider.value) / 100;
      this.callbacks.onSplitRatio(ratio);
    });
    slider.addEventListener("change", () => {
      void updateSettings({ layout: { ...getConfig().layout, splitRatio: Number(slider.value) / 100 } });
    });
    ratioRow.append(ratioLabel, slider, ratioValue);
    previewSection.body.append(ratioRow);
    main.append(previewSection.el);

    const editorSection = section("编辑器", "显示项与缩进行为，即时生效。");
    editorSection.body.append(
      checkRow("显示行号", cfg.layout.showLineNumbers, (value) => {
        void updateSettings({ layout: { ...getConfig().layout, showLineNumbers: value } });
      }),
      checkRow("高亮当前行", cfg.layout.showActiveLine, (value) => {
        void updateSettings({ layout: { ...getConfig().layout, showActiveLine: value } });
      }),
      checkRow("缩进参考线", cfg.editorEnhancements.indentGuides, (value) => {
        void updateSettings({
          editorEnhancements: { ...getConfig().editorEnhancements, indentGuides: value },
        });
      }),
      checkRow("显示空白字符", cfg.editorEnhancements.showWhitespace, (value) => {
        void updateSettings({
          editorEnhancements: { ...getConfig().editorEnhancements, showWhitespace: value },
        });
      }),
      checkRow("括号匹配高亮", cfg.editorEnhancements.bracketMatching, (value) => {
        void updateSettings({
          editorEnhancements: { ...getConfig().editorEnhancements, bracketMatching: value },
        });
      }),
      checkRow("彩虹括号（括号对按嵌套深度着色区分）", cfg.editorEnhancements.rainbowBrackets, (value) => {
        void updateSettings({
          editorEnhancements: { ...getConfig().editorEnhancements, rainbowBrackets: value },
        });
      }),
      checkRow("启用列选择", cfg.editorEnhancements.columnSelection, (value) => {
        void updateSettings({
          editorEnhancements: { ...getConfig().editorEnhancements, columnSelection: value },
        });
      }),
      selectRow<ColumnModifier>(
        "列选择修饰键",
        COLUMN_MODIFIERS.map((m) => ({ value: m, label: m === "Meta" ? "Meta（Win 徽标键）" : m })),
        cfg.editorEnhancements.columnSelectionModifier,
        (value) => {
          void updateSettings({
            editorEnhancements: {
              ...getConfig().editorEnhancements,
              columnSelectionModifier: value,
            },
          });
        },
      ),
      numberRow("字号（px）", cfg.layout.editorFontSize, 10, 24, (value) => {
        void updateSettings({ layout: { ...getConfig().layout, editorFontSize: value } });
      }),
      numberRow("Tab 宽度", cfg.tabSize, 1, 8, (value) => {
        void updateSettings({ tabSize: value });
      }),
      checkRow("Tab 插入空格（否则插入制表符）", cfg.insertSpaces, (value) => {
        void updateSettings({ insertSpaces: value });
      }),
    );
    main.append(editorSection.el);

    // 状态栏字段：显隐 + 排序
    const statusSection = section("状态栏字段", "勾选显示 / 隐藏，用上下箭头调整顺序。");
    const fields = withAllFields(cfg.layout.statusBarFields);
    const list = document.createElement("div");
    list.className = "settings-status-fields";
    statusSection.body.append(list);

    const renderFields = (items: StatusBarFieldEntry[]): void => {
      list.innerHTML = "";
      items.forEach((field, i) => {
        const row = document.createElement("div");
        row.className = "settings-status-field";

        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = field.visible;
        check.addEventListener("change", () => {
          const next = items.map((f, j) => (j === i ? { ...f, visible: check.checked } : f));
          void updateSettings({ layout: { ...getConfig().layout, statusBarFields: next } });
        });
        row.append(check);

        const label = document.createElement("span");
        label.textContent = STATUS_FIELD_LABELS[field.id] ?? field.id;
        row.append(label);

        const spacer = document.createElement("span");
        spacer.style.flex = "1";
        row.append(spacer);

        const up = document.createElement("button");
        up.type = "button";
        up.className = "settings-status-move";
        up.textContent = "↑";
        up.title = "上移";
        up.disabled = i === 0;
        up.addEventListener("click", () => {
          const next = [...items];
          [next[i - 1], next[i]] = [next[i], next[i - 1]];
          void updateSettings({ layout: { ...getConfig().layout, statusBarFields: next } });
          renderFields(next);
        });
        row.append(up);

        const down = document.createElement("button");
        down.type = "button";
        down.className = "settings-status-move";
        down.textContent = "↓";
        down.title = "下移";
        down.disabled = i === items.length - 1;
        down.addEventListener("click", () => {
          const next = [...items];
          [next[i + 1], next[i]] = [next[i], next[i + 1]];
          void updateSettings({ layout: { ...getConfig().layout, statusBarFields: next } });
          renderFields(next);
        });
        row.append(down);

        list.append(row);
      });
    };
    renderFields(fields);
    main.append(statusSection.el);

    const reservedSection = section("预留", "以下能力已设计、暂未实现，标记为预留。");
    const note = document.createElement("div");
    note.className = "settings-note";
    note.textContent = "面板停靠（查找 / 输出 / 预览停靠到右侧或底部）、Minimap、自定义主题导入：排期 v2。";
    reservedSection.body.append(note);
    main.append(reservedSection.el);
  }
}
