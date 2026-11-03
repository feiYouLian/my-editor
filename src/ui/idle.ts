/**
 * 把「防抖结束后要做的重活」推迟到浏览器空闲时段。
 *
 * 定时器只保证"用户停手多久后执行"，并不保证那一帧有空；
 * 排版 / 全量扫描这类工作若正好撞上滚动或输入帧，就会表现为卡一下。
 * requestIdleCallback 让浏览器在不忙时再执行；timeout 保证持续交互时也会落地。
 * 环境不支持时退回 setTimeout(0)，行为等价于原实现。
 *
 * 返回值用于取消：重复排程或关闭面板时必须调用，避免过期任务继续跑。
 */
export function runWhenIdle(run: () => void, timeoutMs = 500): () => void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(
      () => {
        run();
      },
      { timeout: timeoutMs },
    );
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 0);
  return () => clearTimeout(handle);
}
