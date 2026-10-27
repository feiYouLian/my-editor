/**
 * 设置中心 ▸ 页面布局页：侧栏、双栏预览、编辑器显示项、状态栏字段。
 */

import type { ColumnModifier, StatusBarFieldEntry } from "../config/settings";
import { getConfig } from "../config/settings";
import {
  checkRow,
  numberRow,
  radioGroup,
  section,
  selectRow,
  sliderRow,
  textRow,
} from "../ui/formControls";
import {
  COLUMN_MODIFIERS,
  editorEnhancements,
  layout,
  saveSettings,
  STATUS_FIELD_LABELS,
  VIEW_MODE_OPTIONS,
  withAllFields,
  type SettingsTabContext,
  type ViewMode,
} from "./shared";

export function renderLayout(main: HTMLElement, ctx: SettingsTabContext): void {
  const cfg = getConfig();

  const sidebarSection = section("侧栏");
  sidebarSection.body.append(
    checkRow("显示侧栏（文件树 / 搜索）", cfg.layout.sidebarVisible, (value) => {
      ctx.callbacks.onSidebarVisible(value);
      saveSettings({ layout: { ...layout(), sidebarVisible: value } });
    }),
  );
  main.append(sidebarSection.el);

  const previewSection = section("双栏预览", "Markdown / HTML 编辑与预览的分栏方式。");
  previewSection.body.append(
    radioGroup<ViewMode>(
      "默认视图模式",
      VIEW_MODE_OPTIONS,
      cfg.layout.defaultViewMode,
      (value) => {
        ctx.callbacks.onViewMode(value);
        saveSettings({ layout: { ...layout(), defaultViewMode: value } });
      },
    ),
    // 拖动时只改界面，松手才落盘（见 ui/formControls.sliderRow）
    sliderRow(
      "默认分栏比例",
      cfg.layout.splitRatio,
      (ratio) => ctx.callbacks.onSplitRatio(ratio),
      (ratio) => saveSettings({ layout: { ...layout(), splitRatio: ratio } }),
    ),
  );
  main.append(previewSection.el);

  const editorSection = section(
    "编辑器",
    "显示项与缩进行为，即时生效。多光标：Ctrl+点击；列选择：Alt+拖选（VS Code 用 Alt+点击，在本项目是列选择）。",
  );
  editorSection.body.append(
    checkRow("显示行号", cfg.layout.showLineNumbers, (value) => {
      saveSettings({ layout: { ...layout(), showLineNumbers: value } });
    }),
    checkRow("高亮当前行", cfg.layout.showActiveLine, (value) => {
      saveSettings({ layout: { ...layout(), showActiveLine: value } });
    }),
    checkRow("Minimap 缩略图（编辑器右侧）", cfg.layout.minimap, (value) => {
      saveSettings({ layout: { ...layout(), minimap: value } });
    }),
    checkRow("缩进参考线", cfg.editorEnhancements.indentGuides, (value) => {
      saveSettings({ editorEnhancements: { ...editorEnhancements(), indentGuides: value } });
    }),
    checkRow("显示空白字符", cfg.editorEnhancements.showWhitespace, (value) => {
      saveSettings({ editorEnhancements: { ...editorEnhancements(), showWhitespace: value } });
    }),
    checkRow("括号匹配高亮", cfg.editorEnhancements.bracketMatching, (value) => {
      saveSettings({
        editorEnhancements: { ...editorEnhancements(), bracketMatching: value },
      });
    }),
    checkRow(
      "彩虹括号（括号对按嵌套深度着色区分）",
      cfg.editorEnhancements.rainbowBrackets,
      (value) => {
        saveSettings({
          editorEnhancements: { ...editorEnhancements(), rainbowBrackets: value },
        });
      },
    ),
    checkRow("自动闭合括号 / 引号", cfg.editorEnhancements.autoCloseBrackets, (value) => {
      saveSettings({ editorEnhancements: { ...editorEnhancements(), autoCloseBrackets: value } });
    }),
    checkRow("输入时自动缩进", cfg.editorEnhancements.autoIndent, (value) => {
      saveSettings({ editorEnhancements: { ...editorEnhancements(), autoIndent: value } });
    }),
    checkRow(
      "单词补全（Ctrl+Space / Alt+/，仅从本文档取词）",
      cfg.editorEnhancements.wordCompletion,
      (value) => {
        saveSettings({ editorEnhancements: { ...editorEnhancements(), wordCompletion: value } });
      },
    ),
    checkRow("自动换行（长行按编辑区宽度折行）", cfg.editorEnhancements.wordWrap, (value) => {
      saveSettings({ editorEnhancements: { ...editorEnhancements(), wordWrap: value } });
    }),
    checkRow("代码折叠（Ctrl+Shift+[ / ]）", cfg.editorEnhancements.codeFolding, (value) => {
      saveSettings({ editorEnhancements: { ...editorEnhancements(), codeFolding: value } });
    }),
    checkRow("启用列选择", cfg.editorEnhancements.columnSelection, (value) => {
      saveSettings({
        editorEnhancements: { ...editorEnhancements(), columnSelection: value },
      });
    }),
    selectRow<ColumnModifier>(
      "列选择修饰键",
      COLUMN_MODIFIERS.map((m) => ({
        value: m,
        label: m === "Meta" ? "Meta（Win 徽标键）" : m,
      })),
      cfg.editorEnhancements.columnSelectionModifier,
      (value) => {
        saveSettings({
          editorEnhancements: { ...editorEnhancements(), columnSelectionModifier: value },
        });
      },
    ),
    numberRow("字号（px）", cfg.layout.editorFontSize, 10, 24, (value) => {
      saveSettings({ layout: { ...layout(), editorFontSize: value } });
    }),
    numberRow("Tab 宽度", cfg.tabSize, 1, 8, (value) => {
      saveSettings({ tabSize: value });
    }),
    checkRow("Tab 插入空格（否则插入制表符）", cfg.insertSpaces, (value) => {
      saveSettings({ insertSpaces: value });
    }),
    checkRow(
      "按文件检测缩进（覆盖上面的全局宽度，状态栏可改）",
      cfg.editorEnhancements.detectIndent,
      (value) => {
        saveSettings({ editorEnhancements: { ...editorEnhancements(), detectIndent: value } });
      },
    ),
    textRow(
      "列标尺（逗号分隔的列号，留空关闭）",
      (cfg.editorEnhancements.rulers ?? []).join(", "),
      "例如 80, 120",
      (value) => {
        const rulers = value
          .split(/[,，\s]+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
          .map((n) => Math.floor(n))
          .slice(0, 6);
        saveSettings({ editorEnhancements: { ...editorEnhancements(), rulers } });
      },
    ),
    checkRow("保存时自动格式化（大文件跳过）", cfg.formatOnSave, (value) => {
      saveSettings({ formatOnSave: value });
    }),
  );
  main.append(editorSection.el);

  renderStatusFields(main, cfg.layout.statusBarFields);

  const reservedSection = section("预留", "以下能力已设计、暂未实现，标记为预留。");
  const note = document.createElement("div");
  note.className = "settings-note";
  note.textContent = "面板停靠（查找 / 输出 / 预览停靠到右侧或底部）、自定义主题导入：排期 v2。";
  reservedSection.body.append(note);
  main.append(reservedSection.el);
}

/** 状态栏字段：显隐 + 排序（数组顺序即展示顺序） */
function renderStatusFields(main: HTMLElement, configured: StatusBarFieldEntry[]): void {
  const statusSection = section("状态栏字段", "勾选显示 / 隐藏，用上下箭头调整顺序。");
  const fields = withAllFields(configured);
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
        saveSettings({ layout: { ...layout(), statusBarFields: next } });
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
        saveSettings({ layout: { ...layout(), statusBarFields: next } });
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
        saveSettings({ layout: { ...layout(), statusBarFields: next } });
        renderFields(next);
      });
      row.append(down);

      list.append(row);
    });
  };
  renderFields(fields);
  main.append(statusSection.el);
}
