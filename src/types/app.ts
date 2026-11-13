/** 与 Rust 侧 FileContent / SaveResult 对应的前端类型 */
export interface FileContent {
  path: string;
  name: string;
  size: number;
  content: string;
  encoding: string;
  newline: string;
  has_bom: boolean;
  /** 编码置信度："bom" | "high" | "low" | "user" */
  encoding_confidence: string;
  /** 候选编码（状态栏「重新打开为」菜单） */
  encoding_candidates: string[];
  /** 只读：大文件或日志文件命中只读守卫时为 true */
  readonly: boolean;
  /** 只读原因（非只读时为空串） */
  readonly_reason: string;
}

export interface SaveResult {
  path: string;
  size: number;
}

/** Git 状态（渲染层与 app 层共用；放这里避免 ui → panels 的类型依赖） */
export interface GitFileEntry {
  path: string;
  relative: string;
  status: string;
  orig_relative: string | null;
}

export interface GitStatus {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  error: string;
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  refs: string;
  subject: string;
}
