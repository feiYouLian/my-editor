/**
 * 预览共享类型：宿主需要的最小标签信息、预览种类与模式。
 * 放在子目录的 types.ts，避免 preview.ts ↔ 子模块互相 import 类型。
 */

export type PreviewMode = "edit" | "preview" | "split";
export type PreviewKind = "md" | "html" | null;

/** 预览宿主需要的最小标签信息（Tab 结构满足该接口） */
export interface PreviewTab {
  id: string;
  kind: "text" | "image";
  path: string | null;
  name: string;
  content: string;
  size: number;
  dataUrl?: string;
}
