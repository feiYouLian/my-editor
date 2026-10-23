/**
 * 差异视图共享类型：对齐行、差异块、载荷、场景动作与采用语义。
 * 由 panels/diffPanel.ts 转发导出，保持既有导入路径可用。
 */

export interface DiffRow {
  kind: "equal" | "change" | "del" | "ins";
  oldNo: number | null;
  newNo: number | null;
  left: string;
  right: string;
}

export interface HunkRef {
  row: number;
  oldStart: number;
  newStart: number;
}

export interface DiffPayload {
  leftLabel: string;
  rightLabel: string;
  rows: DiffRow[];
  hunks: HunkRef[];
  added: number;
  removed: number;
  identical: boolean;
  /** 行尾差异（CRLF / LF）是否已被忽略 */
  newlineNormalized: boolean;
  patch: string;
}

/** 场景相关动作（由调用方决定语义，如「还原改动」「采用左侧」） */
export interface DiffAction {
  label: string;
  title?: string;
  run: () => void | Promise<void>;
}

/**
 * 差异块级「采用某一侧」。
 * side 为要采用的一侧；另一侧视为文档基线，采用后写回编辑器内容（由调用方实现）。
 */
export interface HunkAdopt {
  side: "left" | "right";
  /** 当前是否可执行（如标签有未保存改动时禁用） */
  enabled: () => boolean;
  /** 不可用时的解释（作为按钮 title） */
  title?: string;
  run: (hunkIndex: number) => void;
}

/**
 * 一次差异会话：采用差异块后可重新计算并刷新面板。
 * 由调用方（main.ts / app/diffService.ts）构造，DiffPanel 只消费。
 */
export interface DiffSession {
  /** 重新计算差异（采用后左侧基线可能已变，必须重新调用） */
  load: () => Promise<DiffPayload>;
  actions: DiffAction[];
  /** 可采用的差异块动作；返回 null 表示当前场景不提供 */
  adopt: () => HunkAdopt | null;
  /** 合并结果是否保留结尾换行：按编辑器内容 / 磁盘基线判断 */
  trailingFrom: "content" | "saved";
}
