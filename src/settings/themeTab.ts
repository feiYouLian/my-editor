/**
 * 设置中心 ▸ 主题页：应用界面主题 + 编辑器语法主题（内置三种 + 用户自定义主题文件）。
 */

import {
  getConfig,
  getUserThemes,
  reapplyConfig,
  setUserThemes,
  type EditorThemeSetting,
  type ThemeSetting,
} from "../config/settings";
import { customThemeName, themeValue } from "../config/userThemes";
import { loadUserThemes, openThemesDir } from "../services/userAssets";
import { buttonRow, radioGroup, section, selectRow } from "../ui/formControls";
import {
  EDITOR_THEME_OPTIONS,
  saveSettings,
  THEME_OPTIONS,
  type SettingsTabContext,
} from "./shared";

/** 主题文件重读的统一入口：刷新载入态 → 重绘编辑器 → 反馈给用户 */
async function reloadThemes(ctx: SettingsTabContext): Promise<void> {
  const result = await loadUserThemes();
  setUserThemes(result.themes);
  reapplyConfig();
  ctx.rerender();
  if (result.errors.length > 0) {
    // 坏文件必须说清是哪个、为什么——否则用户只看到「主题列表里没有它」
    const first = result.errors[0];
    const more = result.errors.length > 1 ? `（另有 ${result.errors.length - 1} 个问题）` : "";
    ctx.callbacks.onMessage(`主题文件有问题：${first}${more}`);
    result.errors.forEach((e) => console.warn("[theme]", e));
    return;
  }
  ctx.callbacks.onMessage(
    result.themes.length > 0
      ? `已读取 ${result.themes.length} 个自定义主题`
      : "主题目录里没有 .json 文件，点「打开主题目录」可生成示例",
  );
}

export function renderTheme(main: HTMLElement, ctx: SettingsTabContext): void {
  const cfg = getConfig();

  const uiSection = section(
    "应用主题",
    "应用界面配色；「跟随系统」随系统深浅色偏好自动切换。",
  );
  uiSection.body.append(
    radioGroup<ThemeSetting>("界面主题", THEME_OPTIONS, cfg.theme, (value) => {
      saveSettings({ theme: value });
      ctx.callbacks.onMessage(
        `界面主题已切换为 ${THEME_OPTIONS.find((o) => o.value === value)?.label}`,
      );
    }),
  );
  main.append(uiSection.el);

  const editorSection = section(
    "编辑器主题",
    "代码区语法配色，独立于应用界面主题；自定义主题放在配置目录的 themes/ 下。",
  );

  const themes = getUserThemes();
  const options: { value: EditorThemeSetting; label: string }[] = [
    ...EDITOR_THEME_OPTIONS,
    ...themes.map((t) => ({
      value: themeValue(t.name) as EditorThemeSetting,
      label: `自定义：${t.name}`,
    })),
  ];
  // 配置里指向一个已不存在的主题文件时，也要在列表里显示真实取值，
  // 否则下拉框会显示成第一项（界面在说谎）
  const configuredName = customThemeName(cfg.editorTheme);
  if (configuredName && !themes.some((t) => t.name === configuredName)) {
    options.push({
      value: cfg.editorTheme,
      label: `自定义：${configuredName}（文件未找到，已回退深色）`,
    });
  }

  editorSection.body.append(
    selectRow<EditorThemeSetting>("编辑器语法主题", options, cfg.editorTheme, (value) => {
      saveSettings({ editorTheme: value });
      ctx.callbacks.onMessage(`编辑器主题已切换为「${value}」`);
    }),
  );

  editorSection.body.append(
    buttonRow("自定义主题", [
      {
        text: "打开主题目录",
        title: "在文件管理器中打开 themes 目录（首次会生成一个示例主题）",
        onClick: () => {
          void openThemesDir()
            .then((dir) => ctx.callbacks.onMessage(`已打开主题目录：${dir}`))
            .catch((e: unknown) => {
              const reason = e instanceof Error ? e.message : String(e);
              ctx.callbacks.onMessage(`打开主题目录失败：${reason.split("\n")[0]}`);
            });
        },
      },
      { text: "重新读取主题", title: "改完主题文件后点这里，无需重启", onClick: () => void reloadThemes(ctx) },
    ]),
  );

  const note = document.createElement("div");
  note.className = "settings-note";
  note.textContent =
    "主题文件格式：{ \"dark\": true, \"ui\": { \"background\": \"#0f172a\", … }, " +
    "\"syntax\": { \"keyword\": \"#c792ea\", \"string\": \"#c3e88d\", … } }。" +
    "ui 可省略；syntax 至少给一个键，可用键见 docs/USER-GUIDE.md。";
  editorSection.body.append(note);

  const previewNote = document.createElement("div");
  previewNote.className = "settings-note";
  previewNote.textContent = "Markdown / HTML 预览固定为浅色文档样式（纸张感），不随主题切换。";
  editorSection.body.append(previewNote);
  main.append(editorSection.el);
}
