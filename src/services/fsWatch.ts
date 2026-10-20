import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 外部修改监听服务（对接 Rust watch.rs）。
 * 登记后由 Rust 侧持续监听文件所在目录，内容变化时推送事件；
 * 自身保存引起的写入由 Rust 侧在登记后的静默窗口内过滤。
 */

export interface FileChanged {
  path: string;
}

/** 登记需要监听的文件（打开 / 保存 / 关闭标签后调用，传空数组即停止监听） */
export async function watchFiles(paths: string[]): Promise<void> {
  await invoke("watch_files", { paths });
}

/** 订阅外部修改事件，返回取消订阅函数 */
export function onFileChanged(cb: (path: string) => void): Promise<UnlistenFn> {
  return listen<FileChanged>("file://changed", (e) => cb(e.payload.path));
}
