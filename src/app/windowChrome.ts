/**
 * 窗口 chrome：无边框窗口的自定义标题栏（最小化/最大化/关闭）、
 * 边缘缩放热区、退出前清理。
 *
 * 退出清理走 Tauri 的 onCloseRequested 而非 webview 的 beforeunload
 * ——后者在 Tauri 关窗时不一定触发，草稿是防抖写的，直接退出会丢内容。
 */

import { getCurrentWindow } from "@tauri-apps/api/window";

/** startResizeDragging 的方向参数（@tauri-apps/api 未导出该类型，本地声明） */
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export interface WindowChromeDeps {
  /** 关闭前清理：flush 会话与草稿、停止子进程、释放大文件会话 */
  onBeforeExit: () => Promise<void>;
}

export class WindowChrome {
  private readonly appWindow = getCurrentWindow();
  private exiting = false;

  constructor(private deps: WindowChromeDeps) {
    document
      .getElementById("win-min")
      ?.addEventListener("click", () => void this.appWindow.minimize());
    document
      .getElementById("win-max")
      ?.addEventListener("click", () => void this.appWindow.toggleMaximize());
    document
      .getElementById("win-close")
      ?.addEventListener("click", () => void this.appWindow.close());

    // 注：双击标题栏最大化由 Tauri data-tauri-drag-region 内置处理（drag.js），无需自建

    // 无边框窗口缩放热区：左右下边缘 + 四角
    document.querySelectorAll<HTMLElement>(".resize-zone").forEach((zone) => {
      zone.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const dir = zone.dataset.resize as ResizeDirection | undefined;
        if (dir) void this.appWindow.startResizeDragging(dir);
      });
    });

    void this.appWindow.onCloseRequested(async (event) => {
      if (this.exiting) return;
      // 先拦截关闭，清理完成后再强制销毁（不再触发关闭请求，避免循环）
      event.preventDefault();
      this.exiting = true;
      try {
        await this.deps.onBeforeExit();
      } finally {
        await this.appWindow.destroy();
      }
    });
  }

  /** 关闭窗口（菜单「退出」/ Ctrl+Q） */
  close(): void {
    void this.appWindow.close();
  }
}
