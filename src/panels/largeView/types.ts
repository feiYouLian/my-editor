/**
 * 大文件视图共享类型：文件信息、行窗口、过滤批次与结果。
 */

export interface LargeFileInfo {
  id: string;
  path: string;
  name: string;
  size: number;
  encoding: string;
  newline: string;
  totalLines: number;
  indexedBytes: number;
  complete: boolean;
}

export interface LineWindow {
  start: number;
  lineNos: number[];
  lines: string[];
  truncatedLines: number;
}

export interface FilterResult {
  /** IPC 原始类型：JSON 反序列化产物，进入 LargeView 后转存 MatchBuffer */
  matches: number[];
  truncated: boolean;
  cancelled: boolean;
  scanned: number;
}

/** 流式过滤批次（后端按 200ms / 1000 条分批推送） */
export interface FilterBatch {
  id: string;
  requestId: number;
  /** IPC 原始类型：JSON 反序列化产物，进入 LargeView 后转存 MatchBuffer */
  matches: number[];
  scanned: number;
  total: number;
  truncated: boolean;
  done: boolean;
  cancelled: boolean;
}

export interface IndexReady {
  id: string;
  totalLines: number;
  newline: string;
}

/** `refresh_large_file` 的返回：跟随文件尾部时轮询用 */
export interface LargeRefresh {
  info: LargeFileInfo;
  /** 是否读到了新内容 */
  grew: boolean;
  /** 文件被截断/轮转，需重新打开（续扫不成立） */
  resetRequired: boolean;
}
