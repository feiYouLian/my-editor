/**
 * 预览的本地图片内联：把 Markdown 中的相对/绝对路径图片读成 data URL。
 * 带大小检查与 LRU 缓存（同一图片在多次重渲染时复用）。
 */

import { invoke } from "@tauri-apps/api/core";
import { dirnameOf } from "../../core/paths";

/** 相对路径图片内联上限：超过则跳过，避免预览一次性读入大图 */
const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** 导出用上限：导出是一次性动作，放宽到 10MB，避免预览预算导致导出件静默丢图 */
export const EXPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 已内联图片缓存：按原始字节预算淘汰。
 *  纯条数上限会让「图片多但每张不大」的文档每轮重渲染都回读（一轮渲染会请求全文所有图），
 *  而大图又会把总内存撑爆；故以字节为主、条数为兜底。
 *  data URL 约为原始字节的 4/3，16MB 预算对应约 21MB 字符串。 */
interface ImageCacheEntry {
  task: Promise<string | null>;
  /** 原始字节数：probe 后回填，超限/失败为 0 */
  bytes: number;
}
const imageCache = new Map<string, ImageCacheEntry>();
/** 原始字节预算 */
const IMAGE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
/** 条数兜底：大量小图与超限占位不能把 Map 撑大 */
const IMAGE_CACHE_MAX_ITEMS = 32;

/** 按插入序淘汰，直到总量与条数都在预算内；至少保留最新一条 */
function evictImages(): void {
  let total = 0;
  for (const entry of imageCache.values()) total += entry.bytes;
  while (
    (total > IMAGE_CACHE_MAX_BYTES || imageCache.size > IMAGE_CACHE_MAX_ITEMS) &&
    imageCache.size > 1
  ) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    const entry = imageCache.get(oldest);
    imageCache.delete(oldest);
    total -= entry?.bytes ?? 0;
  }
}

/**
 * 把 Markdown 中的本地图片地址解析为绝对路径：
 * 远程 / 内联地址返回 null；file:// 与盘符 / UNC 绝对路径直接归一化；
 * 其余按文档所在目录解析（支持 %20 等转义与正斜杠）。
 */
export function resolveLocalImage(src: string, baseDir: string): string | null {
  const raw = src.trim();
  if (!raw) return null;
  if (/^(?:https?:|data:|blob:|mailto:|tel:|javascript:)/i.test(raw)) return null;
  if (raw.startsWith("//")) return null;

  if (/^file:\/\//i.test(raw)) {
    let p = raw.replace(/^file:\/\//i, "");
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1);
    try {
      p = decodeURI(p);
    } catch {
      // 保留原样
    }
    return p.replace(/\//g, "\\");
  }
  if (/^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\\\")) {
    try {
      return decodeURI(raw).replace(/\//g, "\\");
    } catch {
      return raw.replace(/\//g, "\\");
    }
  }

  const clean = raw.split(/[?#]/)[0];
  if (!clean) return null;
  let rel = clean.replace(/^\.\//, "").replace(/\//g, "\\");
  try {
    rel = decodeURI(rel);
  } catch {
    // 保留原样
  }
  return `${baseDir}\\${rel}`;
}

/** 读取本地图片为 data URL（带大小检查与缓存）。maxBytes 参与缓存键：
 *  预览按 4MB 判定出的 null 不能污染导出按 10MB 发起的调用 */
function loadLocalImage(path: string, maxBytes: number): Promise<string | null> {
  const key = `${maxBytes}:${path}`;
  const cached = imageCache.get(key);
  if (cached) return cached.task;
  const entry: ImageCacheEntry = { task: Promise.resolve(null), bytes: 0 };
  entry.task = (async () => {
    try {
      const probe = await invoke<{ size: number }>("probe_file", { path });
      if (probe.size > maxBytes) return null;
      entry.bytes = probe.size;
      evictImages();
      const img = await invoke<{ data_url: string }>("read_image_file", { path });
      return img.data_url;
    } catch {
      // 文件不存在 / 非图片格式：保留原地址，由浏览器显示失败占位
      return null;
    }
  })();
  imageCache.set(key, entry);
  evictImages();
  return entry.task;
}

/**
 * 把预览 DOM 中的本地图片内联为 data URL；未保存文档（无路径）跳过。
 * 必须在 DOMPurify 之前调用：盘符路径会被消毒器当作未知协议而移除 src。
 * maxBytes 缺省用预览预算；导出传 EXPORT_IMAGE_MAX_BYTES 以放宽到 10MB。
 */
export async function inlineLocalImages(
  root: HTMLElement,
  mdPath: string | null,
  maxBytes = INLINE_IMAGE_MAX_BYTES,
): Promise<void> {
  if (!mdPath) return;
  const baseDir = dirnameOf(mdPath);
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(async (img) => {
      const resolved = resolveLocalImage(img.getAttribute("src") ?? "", baseDir);
      if (!resolved) return;
      const dataUrl = await loadLocalImage(resolved, maxBytes);
      if (dataUrl) img.setAttribute("src", dataUrl);
    }),
  );
}
