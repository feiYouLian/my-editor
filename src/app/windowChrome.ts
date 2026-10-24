/**
 * 窗口 chrome：无边框窗口的自定义标题栏（最小化/最大化/关闭）、
 * 边缘缩放热区、退出前清理。
 *
 * 退出清理走 Tauri 的 onCloseRequested 而非 webview 的 beforeunload
 * ——后者在 Tauri 关窗时不一定触发，草稿是防抖写的，直接退出会丢内容。
 *
 * 两条硬约束（踩过的坑）：
 * 1. 监听 close-requested 后 Tauri 会 prevent_close，窗口只能由 `destroy()` 关闭，
 *    因此 capabilities 必须放行 `core:window:allow-destroy`，否则点了关闭窗口一直挂着。
 * 2. 清理逻辑不可无限等待：`stop_run` / `terminal_close` 等要结束子进程，
 *    卡住时会让窗口永远关不掉。这里做超时兜底，超时后照样销毁窗口。
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

/** 退出清理最长等待时间（毫秒）；超时后强制关窗，避免卡死 */
const EXIT_TIMEOUT_MS = 2500;

export interface WindowChromeDeps {
  /** 关闭前清理：flush 会话与草稿、停止子进程、释放大文件会话 */
  onBeforeExit: () => Promise<void>;
  /** 清理超时时间，默认 2500ms；调试/测试可覆盖 */
  exitTimeoutMs?: number;
}

/** 给清理流程加超时：无论底层是否卡死，窗口都必须能关掉 */
function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class WindowChrome {
  private readonly appWindow = getCurrentWindow();
  private readonly maxBtn: HTMLButtonElement | null;
  private exiting = false;
  private lastMaximized: boolean | null = null;

  constructor(private deps: WindowChromeDeps) {
    this.maxBtn = document.getElementById("win-max") as HTMLButtonElement | null;

    document
      .getElementById("win-min")
      ?.addEventListener("click", () => void this.minimize());
    this.maxBtn?.addEventListener("click", () => void this.toggleMaximize());
    document
      .getElementById("win-close")
      ?.addEventListener("click", () => void this.requestClose());

    // 注：双击标题栏最大化由 Tauri data-tauri-drag-region 内置处理（drag.js），无需自建

    // 无边框窗口缩放热区：左右下边缘 + 四角
    document.querySelectorAll<HTMLElement>(".resize-zone").forEach((zone) => {
      zone.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const dir = zone.dataset.resize as ResizeDirection | undefined;
        if (dir) void this.appWindow.startResizeDragging(dir);
      });
    });

    // 最大化图标随窗口状态切换（点击最大化、双击标题栏、系统还原都要同步）
    void this.syncMaximized();
    void this.appWindow
      .onResized(() => void this.syncMaximized())
      .catch((e) => console.error("[window] 订阅尺寸变化失败", e));

    void this.appWindow
      .onCloseRequested((event) => {
        event.preventDefault();
        void this.exit();
      })
      .catch((e) => console.error("[window] 订阅关闭请求失败", e));
  }

  /** 关闭窗口（菜单「退出」/ Ctrl+Q / 标题栏关闭按钮） */
  close(): void {
    void this.requestClose();
  }

  private async requestClose(): Promise<void> {
    try {
      await this.appWindow.close();
    } catch (e) {
      // close 被拒绝时直接走退出流程，至少不丢清理
      console.error("[window] 请求关闭失败", e);
      await this.exit();
    }
  }

  private async minimize(): Promise<void> {
    try {
      await this.appWindow.minimize();
    } catch (e) {
      console.error("[window] 最小化失败", e);
    }
  }

  private async toggleMaximize(): Promise<void> {
    try {
      await this.appWindow.toggleMaximize();
      await this.syncMaximized();
    } catch (e) {
      console.error("[window] 最大化/还原失败", e);
    }
  }

  /** 最大化状态的按钮外观：标题、字形、状态类 */
  private async syncMaximized(): Promise<void> {
    const btn = this.maxBtn;
    if (!btn) return;
    let maximized: boolean;
    try {
      maximized = await this.appWindow.isMaximized();
    } catch (e) {
      console.error("[window] 读取最大化状态失败", e);
      return;
    }
    if (maximized === this.lastMaximized) return;
    this.lastMaximized = maximized;
    btn.textContent = maximized ? "\u2750" : "\u25A1";
    // 只改 aria-label，不设置 title：title 会触发原生 tooltip，
    // 最大化时按钮正好在鼠标下，会紧接着弹出一段文字挡住界面
    btn.setAttribute("aria-label", maximized ? "还原" : "最大化");
    btn.classList.toggle("is-maximized", maximized);
  }

  /** 清理 + 销毁窗口；清理失败或超时也照样关窗 */
  private async exit(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    try {
      await withTimeout(
        this.deps.onBeforeExit(),
        this.deps.exitTimeoutMs ?? EXIT_TIMEOUT_MS,
        "退出清理",
      );
    } catch (e) {
      console.error("[exit] 退出清理未完成，强制关闭窗口", e);
    }
    try {
      await this.appWindow.destroy();
    } catch (e) {
      // destroy 被拒绝（权限/运行时异常）：放开重入，让用户能再试一次
      this.exiting = false;
      console.error("[window] 销毁窗口失败，窗口未关闭", e);
    }
  }
}
