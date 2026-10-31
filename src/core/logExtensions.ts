/** 日志扩展名归一：小写、自动补点、去空项（与 Rust file.rs 口径一致） */
export function normalizeLogExtensions(list: string[]): string[] {
  return list
    .map((e) => {
      const v = e.trim().toLowerCase();
      if (!v) return "";
      return v.startsWith(".") ? v : `.${v}`;
    })
    .filter(Boolean);
}
