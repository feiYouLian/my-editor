/**
 * 更新检查（G3 骨架）。
 *
 * 当前只做到「检查 → 确认 → 下载安装 → 提示重启」；
 * endpoint / 公钥 / 签名证书由发布方在 `tauri.conf.json` 与构建环境中配置。
 * 未配置时友好失败，不影响主流程。
 */

import { check } from "@tauri-apps/plugin-updater";
import { confirmAction, showErrorDialog } from "../ui/dialogs";
import { logError, openLogsDir } from "./diagnostics";

type Message = (text: string, duration?: number) => void;

export async function checkForUpdates(showMessage: Message): Promise<void> {
  try {
    showMessage("正在检查更新…");
    const update = await check();
    if (!update) {
      showMessage("当前已是最新版本");
      return;
    }
    const detail = [
      `新版本：${update.version}`,
      update.date ? `发布时间：${update.date}` : "",
      update.body ? `\n${update.body.slice(0, 800)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const ok = await confirmAction(
      `发现新版本 ${update.version}，是否下载并安装？\n\n${detail}`,
      "下载并安装",
    );
    if (!ok) return;

    showMessage("正在下载更新…");
    let total = 0;
    let downloaded = 0;
    let lastPercent = -1;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        return;
      }
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (total > 0) {
          const percent = Math.floor((downloaded / total) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            showMessage(`正在下载更新… ${percent}%`);
          }
        }
      }
    });
    showMessage("更新已安装，请重启应用后生效", 8000);
  } catch (e) {
    logError("检查更新失败", e);
    const detail = String(e instanceof Error ? e.message : e);
    showErrorDialog("检查更新失败", detail, [
      {
        label: "打开日志目录",
        run: () => void openLogsDir().catch(() => {}),
      },
    ]);
  }
}
