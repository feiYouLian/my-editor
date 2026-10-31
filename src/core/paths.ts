/**
 * 路径工具（零依赖，纯函数）。
 * Windows 盘符 / UNC / 正斜杠混用是本项目的高频输入，统一在此处理。
 */

/** 磁盘根（如 "D:" / "\\server\share"）与根之后的各级 */
export function splitAbsolutePath(path: string): { base: string; parts: string[] } {
  const p = path.replace(/\//g, "\\");
  const drive = /^([A-Za-z]:)(?:\\(.*))?$/.exec(p);
  if (drive) {
    return { base: drive[1], parts: drive[2] ? drive[2].split("\\").filter(Boolean) : [] };
  }
  if (p.startsWith("\\\\")) {
    const segs = p.slice(2).split("\\").filter(Boolean);
    return { base: `\\\\${segs.slice(0, 2).join("\\")}`, parts: segs.slice(2) };
  }
  return { base: "", parts: p.split("\\").filter(Boolean) };
}

/** 取父目录；无分隔符时返回原路径 */
export function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (idx > 0) return path.slice(0, idx);
  // POSIX 根目录下的文件：父目录是 "/"（Windows 盘符根如 "C:\\a" 仍走 idx>0）
  return idx === 0 && path.startsWith("/") ? "/" : path;
}

/**
 * 拼接展示/传递用路径：统一用 `/` 作为分隔符。
 * Windows 的 Path / Tauri IPC 都接受正斜杠；macOS/Linux 则不能被强转成反斜杠。
 */
export function joinVirtualPath(dir: string, rel: string): string {
  if (!dir) return rel.replace(/\\/g, "/");
  const base = dir.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const tail = rel.replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return `${base}/${tail}`;
}

/** 取最后一段（文件名或末级目录名） */
export function basenameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** 去掉末尾扩展名（不含点） */
export function stripExtension(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 仅用于比较的归一化：统一 `/`、去末尾分隔符、转小写（Windows 大小写不敏感） */
function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * child 是否就是 parent 或在 parent 之下（比较时忽略大小写与分隔符）。
 * 用于「不能把目录移动进它自己」这类判断。
 */
export function isSameOrInsidePath(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (!p) return false;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * 去掉被其它项包含的子路径（批量删除/移动时父目录已覆盖子项，重复操作会报「路径不存在」）。
 * 保持输入顺序；大小写与分隔符不敏感；重复项只保留第一个。
 */
export function topmostPaths(paths: string[]): string[] {
  const kept: { raw: string; key: string }[] = [];
  for (const path of paths) {
    const key = normalizeForCompare(path);
    if (!key) continue;
    // 已有同级项或上层目录：当前项被覆盖，跳过
    if (kept.some((item) => item.key === key || key.startsWith(`${item.key}/`))) continue;
    // 输入顺序可能由深到浅：把已被当前项覆盖的旧项剔除
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].key.startsWith(`${key}/`)) kept.splice(i, 1);
    }
    kept.push({ raw: path, key });
  }
  return kept.map((item) => item.raw);
}

/**
 * 相对工作区根目录的层级；文件不在工作区内（或根未知）时返回 null。
 * 大小写不敏感（Windows），但返回的层级保留原始路径的大小写。
 */
export function workspaceRelativeParts(
  path: string,
  workspaceRoot: string | null,
): string[] | null {
  if (!workspaceRoot) return null;
  const norm = (s: string) => s.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const root = norm(workspaceRoot);
  const target = norm(path);
  if (target === root) return [];
  if (!target.startsWith(`${root}\\`)) return null;
  const rootLen = workspaceRoot.replace(/[\\/]+$/, "").length;
  return path.slice(rootLen + 1).split(/[\\/]/).filter(Boolean);
}
