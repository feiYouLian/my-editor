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
  return idx > 0 ? path.slice(0, idx) : path;
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
