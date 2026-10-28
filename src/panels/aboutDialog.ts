/**
 * 关于对话框：版本、技术栈、配置目录（可复制）与快捷键速查入口。
 *
 * 版本优先取 Tauri 运行时（core:app 权限），失败时回退 package.json 的默认值；
 * 目录通过后端 `app_config_dir` 命令读取，避免前端猜测路径。
 */

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

export interface AboutDeps {
  onShowShortcuts: () => void;
}

export async function showAboutDialog(deps: AboutDeps): Promise<void> {
  // 并行取版本与配置目录；任一失败都不阻塞对话框出现
  const [versionRes, dirRes] = await Promise.allSettled([
    getVersion(),
    invoke<string>("app_config_dir"),
  ]);
  const version = versionRes.status === "fulfilled" ? versionRes.value : "0.1.0";
  const configDir = dirRes.status === "fulfilled" ? dirRes.value : "";

  if (document.querySelector(".dialog-backdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "dialog about-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "关于");

  const title = document.createElement("div");
  title.className = "about-title";
  title.textContent = "my-editor";
  const sub = document.createElement("div");
  sub.className = "about-sub";
  sub.textContent = "轻量级定制文本编辑器";
  dialog.append(title, sub);

  const row = (label: string, value: string, copyable = false): HTMLElement => {
    const line = document.createElement("div");
    line.className = "about-row";
    const key = document.createElement("span");
    key.className = "about-label";
    key.textContent = label;
    const val = document.createElement("code");
    val.textContent = value || "—";
    if (copyable && value) {
      val.title = "点击复制";
      val.classList.add("copyable");
      val.addEventListener("click", () => {
        void navigator.clipboard.writeText(value).then(
          () => {
            val.textContent = `${value}（已复制）`;
            window.setTimeout(() => {
              val.textContent = value;
            }, 1200);
          },
          () => {
            // 剪贴板不可用时保持原文本
          },
        );
      });
    }
    line.append(key, val);
    return line;
  };

  dialog.append(
    row("版本", version),
    row("技术栈", "Tauri 2 · CodeMirror 6 · TypeScript"),
    row("配置目录", configDir, true),
  );

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const shortcutsBtn = document.createElement("button");
  shortcutsBtn.type = "button";
  shortcutsBtn.textContent = "快捷键速查";
  // 备份 / 迁移设置时最常做的一件事：打开目录自己拷，比做一套导入导出更直接
  const openDirBtn = document.createElement("button");
  openDirBtn.type = "button";
  openDirBtn.textContent = "打开配置目录";
  openDirBtn.disabled = !configDir;
  openDirBtn.addEventListener("click", () => {
    void invoke("reveal_config_dir").catch(() => {
      // 便利入口：失败时不弹框，用户仍可点「配置目录」复制路径
    });
  });
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "primary";
  closeBtn.textContent = "关闭";
  actions.append(openDirBtn, shortcutsBtn, closeBtn);
  dialog.append(actions);

  backdrop.append(dialog);
  document.body.append(backdrop);

  const done = (): void => backdrop.remove();
  closeBtn.addEventListener("click", done);
  shortcutsBtn.addEventListener("click", () => {
    done();
    deps.onShowShortcuts();
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) done();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done();
  });
  closeBtn.focus();
}
