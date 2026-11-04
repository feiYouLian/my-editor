/**
 * 设置中心 ▸ 文件与会话页：打开方式、会话恢复 / 草稿、大文件阈值、终端 shell。
 *
 * 与「编辑器与布局」页的分工：本页只放"文件生命周期与列表交互"相关项，
 * 不重复编辑器显示与增强开关。
 */

import {
  applyFileAssociation,
  clearLegacyAssociations,
  fileAssociationStatus,
  getConfig,
  getWorkspaceOverrides,
  scanLegacyAssociations,
  updateSettings,
} from "../config/settings";
import { firstLine } from "../core/errors";
import { basenameOf } from "../core/paths";
import { confirmAction } from "../ui/dialogs";
import { buttonRow, checkRow, numberRow, section, selectRow, textRow } from "../ui/formControls";
import {
  saveExternal,
  saveSettings,
  workspaceOverrideHooks,
  type SettingsTabContext,
} from "./shared";

export function renderFiles(main: HTMLElement, ctx: SettingsTabContext): void {
  const cfg = getConfig();

  const openSection = section(
    "打开方式",
    "侧栏列表（文件树 / 搜索结果 / 大纲 / 源代码管理 / 正在打开的文件）的打开手势；目录展开与双击设置无关，始终单击。",
  );
  openSection.body.append(
    checkRow("双击打开（单击仅选中）", cfg.files.openWithDoubleClick, (value) => {
      saveSettings({ files: { ...getConfig().files, openWithDoubleClick: value } });
    }),
    checkRow(
      "按文件记忆编码（自动检测不可靠时优先用上次的选择）",
      cfg.files.encodeMemory,
      (value) => {
        saveSettings({ files: { ...getConfig().files, encodeMemory: value } });
      },
    ),
    checkRow("记住文件树展开状态（关闭后重启只恢复根目录）", cfg.workspace.rememberExpanded, (value) => {
      saveSettings({ workspace: { ...getConfig().workspace, rememberExpanded: value } });
    }),
    checkRow("文件树随外部变化自动刷新（仅监听已展开目录）", cfg.workspace.watchTree, (value) => {
      saveSettings({ workspace: { ...getConfig().workspace, watchTree: value } });
    }),
  );
  main.append(openSection.el);

  // 系统集成：开关只登记「打开方式」候选，绝不改写 `.ext` 默认值（见 commands/association.rs）
  const integrationSection = section(
    "Windows 系统集成",
    "把 my-editor 登记为文本类文件的「打开方式」候选。",
  );
  const associationRow = checkRow(
    "在「打开方式」中显示 my-editor",
    cfg.system.fileAssociation,
    (value) => {
      const previous = getConfig().system.fileAssociation;
      // 顺序：先改系统、再落配置；任一步失败都把系统状态恢复到与配置一致
      void (async () => {
        try {
          await applyFileAssociation(value);
          await updateSettings({ system: { ...getConfig().system, fileAssociation: value } });
          ctx.callbacks.onMessage(
            value
              ? "已登记到「打开方式」候选（系统默认程序未改动）"
              : "已从「打开方式」撤销 my-editor",
          );
        } catch (e) {
          console.error("[settings] 文件关联切换失败", e);
          ctx.callbacks.onMessage(`文件关联切换失败：${firstLine(e)}`);
          await applyFileAssociation(previous).catch(() => {});
        }
        ctx.rerender();
      })();
    },
  );
  const associationStatusEl = document.createElement("div");
  associationStatusEl.className = "settings-section-desc";
  associationStatusEl.textContent = "正在读取系统状态…";
  integrationSection.body.append(associationRow, associationStatusEl);
  main.append(integrationSection.el);

  // 旧版安装器写下的默认关联：只在检测到时出现「一键恢复」，不自动改
  void scanLegacyAssociations()
    .then((legacy) => {
      if (legacy.length === 0 || !integrationSection.el.isConnected) return;
      const restorable = legacy.filter(
        (item) => item.backup !== null && item.backup !== "",
      ).length;
      integrationSection.body.append(
        buttonRow(`旧版默认关联（${legacy.length} 个扩展名）`, [
          {
            text: "一键恢复",
            title:
              restorable > 0
                ? `其中 ${restorable} 个恢复到安装前的默认程序，其余 ${legacy.length - restorable} 个去掉默认关联`
                : "没有安装前的备份，将去掉这些扩展名的默认关联",
            onClick: () => {
              const message =
                restorable > 0
                  ? `恢复 ${restorable} 个扩展名的原默认程序，并去掉其余 ${legacy.length - restorable} 个的默认关联？`
                  : `去掉 ${legacy.length} 个扩展名的默认关联？（之后双击由系统询问用什么打开）`;
              void confirmAction(message, "恢复").then((ok) => {
                if (!ok) return;
                saveExternal(async () => {
                  const outcome = await clearLegacyAssociations();
                  ctx.callbacks.onMessage(
                    `已恢复 ${outcome.restored} 个扩展名的原默认程序，` +
                      `${outcome.cleared} 个已去掉默认关联`,
                  );
                  ctx.rerender();
                });
              });
            },
          },
        ]),
      );
    })
    .catch(() => {});

  // 以注册表为准校正开关：config 只是意图，真实状态可能被系统 / 其它工具改动
  void fileAssociationStatus()
    .then((status) => {
      const input = associationRow.querySelector<HTMLInputElement>("input");
      if (input) {
        input.checked = status.registered;
        input.disabled = !status.supported;
      }
      if (!status.supported) {
        associationStatusEl.textContent = "仅 Windows 支持";
        return;
      }
      associationStatusEl.textContent = status.registered
        ? `已登记 ${status.extensions} 种扩展名：${status.executable}`
        : "未登记";
    })
    .catch((e: unknown) => {
      associationStatusEl.textContent = `读取系统状态失败：${firstLine(e)}`;
    });

  // 工作区覆盖：只影响当前工作区，存于应用配置目录（不写进用户仓库）
  const hooks = workspaceOverrideHooks();
  const wsRoot = hooks?.getRoot() ?? null;
  const overrides = getWorkspaceOverrides();
  const wsSection = section(
    "工作区覆盖（仅当前工作区）",
    wsRoot
      ? `只对「${basenameOf(wsRoot)}」生效，不与其它项目混用；留空 / 0 = 跟随全局` +
        `（缩进 ${cfg.tabSize}，忽略目录 ${cfg.ignoreDirs.join(", ")}）。`
      : "未打开工作区：先「打开目录」，再为该项目单独设置缩进与忽略目录（不影响全局）。",
  );
  if (wsRoot && hooks) {
    wsSection.body.append(
      numberRow("缩进宽度（0 = 跟随全局）", overrides.tabSize ?? 0, 0, 16, (value) => {
        saveExternal(async () => {
          await hooks.apply({ tabSize: value === 0 ? null : value });
          ctx.rerender();
        });
      }),
      textRow(
        "忽略目录（逗号分隔，留空 = 跟随全局）",
        (overrides.ignoreDirs ?? []).join(", "),
        cfg.ignoreDirs.join(", "),
        (value) => {
          const list = value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          saveExternal(async () => {
            await hooks.apply({ ignoreDirs: list.length > 0 ? list : null });
            ctx.rerender();
          });
        },
      ),
    );
  }
  main.append(wsSection.el);

  const fetchSection = section(
    "网页抓取",
    "默认拒绝内网 / 本机地址；需要抓取公司内网文档站时再打开。",
  );
  fetchSection.body.append(
    checkRow("允许访问内网 / 本机地址", cfg.fetch.allowPrivateNetwork, (value) => {
      saveSettings({ fetch: { ...getConfig().fetch, allowPrivateNetwork: value } });
    }),
  );
  main.append(fetchSection.el);

  const gitSection = section(
    "Git",
    "只读模式只允许查看：状态、差异、历史、Blame、分支列表；暂存 / 提交 / 放弃 / 拉取 / 推送 / 切分支 / 建删分支都会被拒绝（前端拦一次，后端按 config.json 再拦一次）。",
  );
  gitSection.body.append(
    checkRow("Git 只读模式（保护正在使用的仓库）", cfg.git.readOnly, (value) => {
      saveSettings({ git: { ...getConfig().git, readOnly: value } });
      // 面板在切换后由 GitHost 刷新时读取新配置（提交按钮据此禁用）
      ctx.callbacks.onMessage(value ? "Git 已切换为只读：只能查看" : "Git 已恢复可写");
    }),
  );
  main.append(gitSection.el);

  const saveSection = section(
    "保存时清理",
    "默认关闭：开启后每次保存都会改动磁盘内容（编辑器内的对应改动不进撤销栈）。",
  );
  saveSection.body.append(
    checkRow("删除行尾空白", cfg.files.trimTrailingWhitespaceOnSave, (value) => {
      saveSettings({ files: { ...getConfig().files, trimTrailingWhitespaceOnSave: value } });
    }),
    checkRow("补最终换行（文件末尾无换行时）", cfg.files.ensureFinalNewlineOnSave, (value) => {
      saveSettings({ files: { ...getConfig().files, ensureFinalNewlineOnSave: value } });
    }),
    checkRow("保存成功后给一条轻提示", cfg.files.notifyOnSave, (value) => {
      saveSettings({ files: { ...getConfig().files, notifyOnSave: value } });
    }),
  );
  main.append(saveSection.el);

  const sessionSection = section(
    "会话与草稿",
    "启动时恢复上次打开的文件、标签顺序与选中的标签；未保存内容始终自动写成草稿，下次启动自动恢复。",
  );
  sessionSection.body.append(
    checkRow("启动时恢复上次打开的文件", cfg.session.restoreOnStartup, (value) => {
      saveSettings({ session: { ...getConfig().session, restoreOnStartup: value } });
    }),
    checkRow(
      "关闭前提示未保存（关掉后直接写草稿并关闭）",
      cfg.session.confirmOnClose,
      (value) => {
        saveSettings({ session: { ...getConfig().session, confirmOnClose: value } });
      },
    ),
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

  const searchSection = section(
    "工作区搜索",
    "侧栏搜索、文件树过滤与 Ctrl+P 快速打开都会跳过这些目录；当前工作区若有覆盖，以覆盖项为准。",
  );
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

  const terminalSection = section(
    "终端",
    "Shell 在下次新建终端时生效；只支持列表内的内置 shell（后端会拒绝其它程序名）。",
  );
  // 只暴露后端支持的 shell：自由填程序名等于给脚本一个任意进程启动器
  const shellOptions: { value: string; label: string }[] = [
    { value: "", label: "自动检测" },
    { value: "pwsh", label: "PowerShell 7（pwsh）" },
    { value: "powershell", label: "Windows PowerShell" },
    { value: "cmd", label: "cmd.exe" },
    { value: "bash", label: "bash" },
    { value: "zsh", label: "zsh" },
    { value: "fish", label: "fish" },
    { value: "sh", label: "sh" },
  ];
  if (cfg.terminal.shell && !shellOptions.some((o) => o.value === cfg.terminal.shell)) {
    shellOptions.push({ value: cfg.terminal.shell, label: `${cfg.terminal.shell}（自定义）` });
  }
  terminalSection.body.append(
    selectRow("Shell（空 = 自动检测）", shellOptions, cfg.terminal.shell, (value) => {
      saveSettings({ terminal: { ...getConfig().terminal, shell: value } });
    }),
  );
  main.append(terminalSection.el);
}
