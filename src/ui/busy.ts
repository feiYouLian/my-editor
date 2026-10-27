/**
 * 长任务指示的全局注册点。
 *
 * 为什么不用依赖注入：需要显示进度的模块分散在 panels / app 两层，
 * 逐个加 `showBusy` 依赖会污染 5 个 deps 接口；这里用一次性注册，
 * 调用方只关心"包一层"。
 *
 * 计数在 statusBar 内部（可嵌套）：批量操作里再触发一次单文件保存也不会闪烁。
 */

interface BusyApi {
  show: (text: string) => void;
  hide: () => void;
}

let api: BusyApi | null = null;

/** 由 main.ts 在状态栏创建后调用一次 */
export function initBusy(next: BusyApi): void {
  api = next;
}

/** 包住一个长任务：结束后一定隐藏（异常也隐藏） */
export async function withBusy<T>(text: string, task: () => Promise<T>): Promise<T> {
  api?.show(text);
  try {
    return await task();
  } finally {
    api?.hide();
  }
}
