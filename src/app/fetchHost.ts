/**
 * 网页抓取编排：计算默认保存目录（当前文件目录 → 工作区根 → 应用配置目录），
 * 打开对话框，抓取成功后走统一「打开文件」流程。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../store/tabs";
import { dirnameOf } from "../core/paths";
import { FetchPageDialog } from "../panels/fetchPageDialog";

export interface FetchHostDeps {
  getActiveTab: () => Tab | null;
  getWorkspaceRoot: () => string | null;
  /** 打开文件（含大文件分流 / HTML 预览） */
  onOpenFile: (path: string) => void;
  showMessage: (text: string) => void;
}

export class FetchHost {
  private readonly dialog: FetchPageDialog;

  constructor(private deps: FetchHostDeps) {
    this.dialog = new FetchPageDialog({
      onFetched: (path) => deps.onOpenFile(path),
      showMessage: deps.showMessage,
    });
  }

  /** 菜单 / 命令 / 快捷键入口 */
  open(): void {
    void this.openAsync();
  }

  private async openAsync(): Promise<void> {
    let dir = this.defaultDir();
    if (!dir) {
      // 无当前文件也无工作区：退回应用配置目录（app_config_dir 保证存在）
      try {
        dir = await invoke<string>("app_config_dir");
      } catch {
        dir = "";
      }
    }
    this.dialog.open(dir);
  }

  private defaultDir(): string {
    const tab = this.deps.getActiveTab();
    if (tab?.path) {
      const dir = dirnameOf(tab.path);
      if (dir && dir !== tab.path) return dir;
    }
    return this.deps.getWorkspaceRoot() ?? "";
  }
}
