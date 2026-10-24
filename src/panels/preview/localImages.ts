/**
 * 预览的本地图片内联：把 Markdown 中的相对/绝对路径图片读成 data URL。
 * 带大小检查与 LRU 缓存（同一图片在多次重渲染时复用）。
 */

import { invoke } from "@tauri-apps/api/core";
import { dirnameOf } from "../../core/paths";

/** 相对路径图片内联上限：超过则跳过，避免预览一次性读入大图 */
const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** 已内联图片缓存：同一图片在多次重渲染时复用；超出上限按插入顺序淘汰。
 *  data URL 的 base64 约为原始字节的 4/3，且字符串在 JS 堆与 DOM 属性各存一份，
 *  故上限同时受单张体积与条数约束（最坏约 8 × 4MB × 4/3 ≈ 43MB）。 */
const imageCache = new Map<string, Promise<string | null>>();
const IMAGE_CACHE_LIMIT = 8;

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

/** 读取本地图片为 data URL（带大小检查与缓存） */
function loadLocalImage(path: string): Promise<string | null> {
  const cached = imageCache.get(path);
  if (cached) return cached;
  const task = (async () => {
    try {
      const probe = await invoke<{ size: number }>("probe_file", { path });
      if (probe.size > INLINE_IMAGE_MAX_BYTES) return null;
      const img = await invoke<{ data_url: string }>("read_image_file", { path });
      return img.data_url;
    } catch {
      // 文件不存在 / 非图片格式：保留原地址，由浏览器显示失败占位
      return null;
    }
  })();
  imageCache.set(path, task);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    imageCache.delete(oldest);
  }
  return task;
}

/**
 * 把预览 DOM 中的本地图片内联为 data URL；未保存文档（无路径）跳过。
 * 必须在 DOMPurify 之前调用：盘符路径会被消毒器当作未知协议而移除 src。
 */
export async function inlineLocalImages(
  root: HTMLElement,
  mdPath: string | null,
): Promise<void> {
  if (!mdPath) return;
  const baseDir = dirnameOf(mdPath);
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(async (img) => {
      const resolved = resolveLocalImage(img.getAttribute("src") ?? "", baseDir);
      if (!resolved) return;
      const dataUrl = await loadLocalImage(resolved);
      if (dataUrl) img.setAttribute("src", dataUrl);
    }),
  );
}
