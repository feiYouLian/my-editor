/**
 * 最近工作区：localStorage 记录最近打开过的目录（上限 8 条），
 * 首屏欢迎页列出并可直接切换。不依赖后端，跨会话保留。
 *
 * 与「最近打开的文件」分开存：工作区切换是重操作（重载覆盖配置、重读 Git），
 * 混在一个列表里会让误点代价变高。
 */

const KEY = "my-editor.recentWorkspaces";
const MAX = 8;

/** 路径比较键：分隔符与大小写不敏感（Windows 同一目录只留一条） */
function keyOf(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 读取最近工作区（最近的在前） */
export function loadRecentWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== "string" || !item) continue;
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out.slice(0, MAX);
  } catch {
    return [];
  }
}

function persist(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // localStorage 不可用时静默降级：只是没有"最近"记忆
  }
}

/** 记录一次工作区切换（去重后前置） */
export function pushRecentWorkspace(path: string): void {
  if (!path) return;
  const key = keyOf(path);
  const rest = loadRecentWorkspaces().filter((item) => keyOf(item) !== key);
  persist([path, ...rest]);
}

/** 移除一条（目录已被删除/改名时清掉，避免反复失败） */
export function removeRecentWorkspace(path: string): void {
  const key = keyOf(path);
  persist(loadRecentWorkspaces().filter((item) => keyOf(item) !== key));
}
