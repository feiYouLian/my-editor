/** 与 Rust 侧 FileContent / SaveResult 对应的前端类型 */
export interface FileContent {
  path: string;
  name: string;
  size: number;
  content: string;
  encoding: string;
  newline: string;
  has_bom: boolean;
}

export interface SaveResult {
  path: string;
  size: number;
}
