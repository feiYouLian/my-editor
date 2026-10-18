/** 与 Rust 侧 FileContent / SaveResult 对应的前端类型 */
export interface FileContent {
  path: string;
  name: string;
  size: number;
  content: string;
  encoding: string;
  newline: string;
  has_bom: boolean;
  /** 只读：大文件或日志文件命中只读守卫时为 true */
  readonly: boolean;
  /** 只读原因（非只读时为空串） */
  readonly_reason: string;
}

export interface SaveResult {
  path: string;
  size: number;
}
