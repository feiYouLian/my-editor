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
  matches: number[];
  truncated: boolean;
  cancelled: boolean;
  scanned: number;
}

/** 流式过滤批次（后端按 200ms / 1000 条分批推送） */
export interface FilterBatch {
  id: string;
  requestId: number;
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
