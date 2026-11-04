/**
 * 纯格式化工具（零依赖）：体积、补零等跨模块共用的纯函数集中在这里，
 * 避免同一语义多处实现后漂移。
 */

/** 人类可读的体积（B / KB / MB / GB） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 两位补零（时间戳 / cron 展示） */
export const pad2 = (n: number | string): string => String(n).padStart(2, "0");
