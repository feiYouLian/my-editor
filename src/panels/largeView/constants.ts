/**
 * 大文件视图常量：固定行高是虚拟化的前提；长行横向裁剪并用 tooltip 呈现全文。
 */

/** 固定行高（px）：虚拟化滚动计算的基准 */
export const LINE_HEIGHT = 18;

/** 视口上下预拉取的行数 */
export const DEFAULT_PADDING_LINES = 200;

/** 缩略图密度桶数 */
export const MINIMAP_BUCKETS = 240;

/** 缩略图宽度（px）：与编辑器内 minimap（editor/minimap.ts）保持一致 */
export const MINIMAP_WIDTH = 80;

/** 编码切换候选：虚拟视图按字节扫行，只支持单字节家族；UTF-16 的换行/字符都是双字节，切过去会错位。
 *  须与 Rust encoding.rs 的 CANDIDATES 保持一致（去掉 UTF-16 LE/BE）。 */
export const ENCODINGS = [
  "UTF-8",
  "GBK",
  "GB18030",
  "Big5",
  "Windows-1252",
  "Shift_JIS",
  "EUC-KR",
  "Windows-1251",
];
