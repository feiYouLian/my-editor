/**
 * 设置中心 ▸ 文件与会话页：打开方式、会话恢复 / 草稿、大文件阈值、终端 shell。
 *
 * 与「编辑器与布局」页的分工：本页只放"文件生命周期与列表交互"相关项，
 * 不重复编辑器显示与增强开关。
 */

import { getConfig } from "../config/settings";
import { checkRow, numberRow, section, textRow } from "../ui/formControls";
import { saveSettings, type SettingsTabContext } from "./shared";

export function renderFiles(main: HTMLElement, _ctx: SettingsTabContext): void {
  const cfg = getConfig();

  const openSection = section(
    "打开方式",
    "侧栏列表（文件树 / 搜索结果 / 大纲 / 源代码管理 / 正在打开的文件）的打开手势；目录展开与双击设置无关，始终单击。",
  );
  openSection.body.append(
    checkRow("双击打开（单击仅选中）", cfg.files.openWithDoubleClick, (value) => {
      saveSettings({ files: { ...getConfig().files, openWithDoubleClick: value } });
    }),
  );
  main.append(openSection.el);

  const sessionSection = section("会话与草稿", "启动恢复与未保存内容的本地兜底。");
  sessionSection.body.append(
    checkRow("启动时恢复上次打开的文件", cfg.session.restoreOnStartup, (value) => {
      saveSettings({ session: { ...getConfig().session, restoreOnStartup: value } });
    }),
    checkRow("自动把未保存内容写成草稿", cfg.session.draftAutosave, (value) => {
      saveSettings({ session: { ...getConfig().session, draftAutosave: value } });
    }),
    numberRow("草稿写入防抖（ms）", cfg.session.draftDebounceMs, 200, 10000, (value) => {
      saveSettings({ session: { ...getConfig().session, draftDebounceMs: value } });
    }),
    numberRow("草稿保留天数（0 = 不清理）", cfg.session.draftRetentionDays, 0, 365, (value) => {
      saveSettings({ session: { ...getConfig().session, draftRetentionDays: value } });
    }),
  );
  main.append(sessionSection.el);

  const largeSection = section("大文件", "达到阈值或命中日志扩展名时，以只读虚拟视图打开。");
  largeSection.body.append(
    numberRow(
      "只读阈值（MB）",
      Math.round(cfg.largeFileThreshold / 1024 / 1024),
      1,
      2048,
      (value) => saveSettings({ largeFileThreshold: value * 1024 * 1024 }),
    ),
    textRow(
      "日志扩展名（逗号分隔）",
      cfg.largeFile.logExtensions.join(", "),
      ".log, .out",
      (value) => {
        const list = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        saveSettings({ largeFile: { ...getConfig().largeFile, logExtensions: list } });
      },
    ),
  );
  main.append(largeSection.el);

  const searchSection = section("工作区搜索", "侧栏搜索与 Ctrl+P 快速打开都会跳过这些目录。");
  searchSection.body.append(
    textRow(
      "忽略目录（逗号分隔）",
      cfg.ignoreDirs.join(", "),
      "node_modules, .git, dist",
      (value) => {
        const list = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        saveSettings({ ignoreDirs: list });
      },
    ),
    checkRow("保留替换历史（可在侧栏撤销）", cfg.globalReplace.backup, (value) => {
      saveSettings({ globalReplace: { ...getConfig().globalReplace, backup: value } });
    }),
  );
  main.append(searchSection.el);

  const terminalSection = section("终端", "Shell 在下次新建终端时生效。");
  terminalSection.body.append(
    textRow(
      "Shell 命令（空 = 自动检测）",
      cfg.terminal.shell,
      "如 pwsh / powershell / bash",
      (value) => {
        saveSettings({ terminal: { ...getConfig().terminal, shell: value } });
      },
    ),
  );
  main.append(terminalSection.el);
}
