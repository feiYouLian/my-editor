/**
 * 设置中心 ▸ 主题页：应用界面主题 + 编辑器语法主题。
 */

import {
  getConfig,
  type EditorThemeSetting,
  type ThemeSetting,
} from "../config/settings";
import { radioGroup, section } from "../ui/formControls";
import {
  EDITOR_THEME_OPTIONS,
  saveSettings,
  THEME_OPTIONS,
  type SettingsTabContext,
} from "./shared";

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

  const editorSection = section("编辑器主题", "代码区语法配色，独立于应用界面主题。");
  editorSection.body.append(
    radioGroup<EditorThemeSetting>(
      "编辑器语法主题",
      EDITOR_THEME_OPTIONS,
      cfg.editorTheme,
      (value) => {
        saveSettings({ editorTheme: value });
        ctx.callbacks.onMessage("编辑器主题已切换");
      },
    ),
  );
  const note = document.createElement("div");
  note.className = "settings-note";
  note.textContent = "Markdown / HTML 预览固定为浅色文档样式（纸张感），不随主题切换。";
  editorSection.body.append(note);
  main.append(editorSection.el);
}
