/**
 * 路径 → 预览种类：md / html / 其他（null）。
 * main.ts 与预览宿主共用，抽成独立小模块避免相互 import。
 */

import type { PreviewKind } from "./types";

export function pathKindOf(path: string | null): PreviewKind {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return null;
}
