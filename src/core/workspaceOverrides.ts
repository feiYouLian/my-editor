/**
 * per-workspace 配置覆盖：形状与归一化规则（零依赖纯函数）。
 *
 * 存放位置由 Rust 决定（`<配置目录>/workspaces/<hash>.json`），
 * 本模块只负责"什么算有效覆盖"，前后端校验口径保持一致。
 */

export interface WorkspaceOverrides {
  /** 来源根目录（仅便于人工排查；由宿主写入） */
  root?: string;
  /** 缩进宽度；null / 缺省 = 用全局 */
  tabSize?: number | null;
  /** 忽略目录；null / 空数组 = 用全局 */
  ignoreDirs?: string[] | null;
}

/** 缩进允许范围（与 Rust 校验、设置页滑杆一致） */
export const TAB_SIZE_MIN = 1;
export const TAB_SIZE_MAX = 16;
/** 忽略目录条数上限（与 Rust 校验一致） */
export const MAX_IGNORE_DIRS = 200;

/** 是否配置了任何覆盖项（决定设置页是否提示"已被工作区覆盖"） */
export function hasOverride(overrides: WorkspaceOverrides | null | undefined): boolean {
  if (!overrides) return false;
  return overrides.tabSize != null || (overrides.ignoreDirs?.length ?? 0) > 0;
}

/**
 * 归一化：去空白、去重、丢弃越界值。
 * 返回的新对象可直接落盘：只保留真正生效的字段（避免写出 `tabSize: null` 这类噪声）。
 */
export function normalizeOverrides(overrides: WorkspaceOverrides | null | undefined): WorkspaceOverrides {
  const out: WorkspaceOverrides = {};
  if (!overrides) return out;
  if (overrides.root) out.root = overrides.root;

  const size = overrides.tabSize;
  if (typeof size === "number" && Number.isInteger(size) && size >= TAB_SIZE_MIN && size <= TAB_SIZE_MAX) {
    out.tabSize = size;
  }

  const dirs = overrides.ignoreDirs;
  if (Array.isArray(dirs)) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of dirs) {
      const name = String(raw).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      list.push(name);
      if (list.length >= MAX_IGNORE_DIRS) break;
    }
    if (list.length > 0) out.ignoreDirs = list;
  }
  return out;
}
