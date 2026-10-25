/**
 * 窗口拖放宿主：拖入文件直接打开，拖入目录询问设为工作区。
 *
 * 事件来自 Tauri webview（tauri.conf.json 未关闭 dragDrop）。
 * 本模块只负责事件接线与"文件/目录"分流判定，具体动作由 main.ts 注入，
 * 避免 app 模块互相依赖。
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface DropHostDeps {
  /** 处理拖入的真实路径（已按顺序，目录在前调用方自行处理） */
  onPaths: (paths: string[]) => Promise<void>;
  /** 拖入 / 离开窗口（用于编辑区高亮） */
  onHover: (active: boolean) => void;
  showMessage: (text: string) => void;
}

export class DropHost {
  private unlisten: (() => void) | null = null;

  constructor(private deps: DropHostDeps) {}

  /** 注册拖放监听（幂等）；失败只提示一次，不影响其它功能 */
  async mount(): Promise<void> {
    if (this.unlisten) return;
    try {
      this.unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          this.deps.onHover(true);
          return;
        }
        if (payload.type === "leave") {
          this.deps.onHover(false);
          return;
        }
        if (payload.type === "drop") {
          this.deps.onHover(false);
          const paths = payload.paths ?? [];
          if (paths.length === 0) return;
          void this.deps.onPaths(paths);
        }
      });
    } catch (e) {
      console.warn("[drop] 注册失败", e);
      this.deps.showMessage("当前环境不支持拖放打开（仍可用 Ctrl+O）");
    }
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }
}
