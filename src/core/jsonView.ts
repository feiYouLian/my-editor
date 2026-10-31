/**
 * JSON 只读视图的纯逻辑：类型判定、节点摘要、带体积上限的解析。
 *
 * 大 JSON 的两个坑：
 * 1. `JSON.parse` 几十 MB 会把内存和主线程拖垮 → 超过上限直接拒绝并说明；
 * 2. 单个数组/对象节点成千上万项 → 每层只渲染前 N 项，剩余用「显示更多」按需展开。
 */

/** 允许解析的最大体积（字符数，约等于字节数） */
export const JSON_VIEW_MAX_CHARS = 8 * 1024 * 1024;
/** 每个节点首屏最多渲染的子项数 */
export const JSON_CHILD_LIMIT = 200;
/** 摘要里字符串的最大展示长度 */
const PREVIEW_CHARS = 60;

export type JsonViewKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export function kindOf(value: unknown): JsonViewKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "null";
  }
}

/** 容器节点的子项数（非容器返回 0） */
export function childCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value as object).length;
  return 0;
}

/** 一行摘要：容器给「{…} 12 项」，标量给值本身（字符串加引号并截断） */
export function previewOf(value: unknown): string {
  const kind = kindOf(value);
  switch (kind) {
    case "object":
      return `{…} ${childCount(value)} 项`;
    case "array":
      return `[…] ${childCount(value)} 项`;
    case "string": {
      const text = String(value);
      return `"${text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text}"`;
    }
    case "boolean":
      return String(value);
    case "null":
      return "null";
    case "number":
      return String(value);
  }
}

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * 解析 JSON 文本。
 * 失败时返回可读原因（`JSON.parse` 的英文报错保留后半段，前面补中文说明）。
 */
export function parseJsonForView(text: string): JsonParseResult {
  if (text.length > JSON_VIEW_MAX_CHARS) {
    const mb = (text.length / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `JSON 体积 ${mb} MB，超过只读视图上限 ${JSON_VIEW_MAX_CHARS / 1024 / 1024} MB；请用「以编辑器打开」或命令行 jq 处理`,
    };
  }
  if (text.trim() === "") return { ok: false, error: "内容为空" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // 去掉各引擎前缀（Node/WebView 都是 "… in JSON at position N"），保留位置信息
    return { ok: false, error: `JSON 解析失败：${raw}` };
  }
}
