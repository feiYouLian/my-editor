import { replaceSvg } from "../../core/html";

/**
 * Mermaid 图表渲染（懒加载）。
 *
 * 管线只输出占位块（`<div class="md-mermaid" data-mermaid="源码">`），
 * 预览/导出时再把占位块替换成 SVG：
 * - 首次真正遇到图表才 import mermaid（不看不装）；
 * - `securityLevel: "strict"` + `htmlLabels: false`：标签走纯 `<text>`，
 *   既避免 foreignObject 被消毒器剥掉，也不允许图表里执行脚本；
 * - 渲染失败降级为源码代码块并说明原因，不让整篇预览失败。
 */

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let apiPromise: Promise<MermaidApi> | null = null;
/** 渲染序号：同一篇文档多次渲染时 id 不能重复 */
let renderSeq = 0;

/**
 * 已渲染图表缓存（源码 → 消毒后的 SVG）。
 * 编辑 Markdown 时每次停顿都会整篇重渲染，图表源码不变时不必重跑 mermaid。
 */
const SVG_CACHE_LIMIT = 32;
const svgCache = new Map<string, string>();

function cacheSvg(source: string, svg: string): void {
  svgCache.delete(source);
  svgCache.set(source, svg);
  while (svgCache.size > SVG_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value;
    if (oldest === undefined) break;
    svgCache.delete(oldest);
  }
}

function loadMermaid(): Promise<MermaidApi> {
  if (!apiPromise) {
    apiPromise = import("mermaid")
      .then((mod) => {
        const api = (mod as unknown as { default: MermaidApi }).default;
        api.initialize({
          startOnLoad: false,
          // 严格模式：图表内的 HTML/脚本一律不执行
          securityLevel: "strict",
          // 纯 SVG 文本标签（foreignObject 会被 DOMPurify 去掉）
          htmlLabels: false,
          theme: "default",
          fontFamily: "inherit",
        });
        return api;
      })
      .catch((e: unknown) => {
        apiPromise = null; // 允许下次重试
        throw e;
      });
  }
  return apiPromise;
}

/**
 * 把 root 内的 Mermaid 占位块替换为 SVG。
 * @param sanitize 传入预览用的消毒函数：SVG 同样要过一遍（标签文字来自用户文档）
 */
export async function hydrateMermaid(
  root: HTMLElement,
  sanitize: (html: string) => string,
): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>(".md-mermaid")];
  if (blocks.length === 0) return;

  // 先命中缓存（同一源码在本篇里重复出现时只复用第一次，避免 SVG id 冲突）
  const seen = new Set<string>();
  const pending: { block: HTMLElement; source: string }[] = [];
  for (const block of blocks) {
    // 已渲染 / 已失败的块在增量渲染中被复用：不要重复跑 mermaid
    if (block.classList.contains("rendered") || block.classList.contains("failed")) continue;
    // 源码在子节点里（消毒后仍保留）；属性形式会被 DOMPurify 丢掉，见 markdownPipeline
    const source = block.querySelector(".md-mermaid-src")?.textContent ?? "";
    if (!source.trim()) continue;
    if (!seen.has(source)) {
      seen.add(source);
      const cached = svgCache.get(source);
      if (cached) {
        replaceSvg(block, cached);
        block.classList.add("rendered");
        continue;
      }
    }
    pending.push({ block, source });
  }
  if (pending.length === 0) return;

  let api: MermaidApi;
  try {
    api = await loadMermaid();
  } catch (e) {
    const reason = `Mermaid 组件加载失败：${String(e instanceof Error ? e.message : e).split("\n")[0]}`;
    for (const item of pending) fail(item.block, item.source, reason);
    return;
  }
  for (const { block, source } of pending) {
    try {
      renderSeq += 1;
      const { svg } = await api.render(`md-mermaid-${Date.now()}-${renderSeq}`, source);
      const safe = sanitize(svg);
      replaceSvg(block, safe);
      block.classList.add("rendered");
      cacheSvg(source, safe);
    } catch (e) {
      fail(block, source, String(e instanceof Error ? e.message : e).split("\n")[0]);
    }
  }
}

/** 失败降级：展示源码 + 原因（保留"能看到图定义"的可读性） */
function fail(block: HTMLElement, source: string, reason: string): void {
  block.classList.add("failed");
  block.innerHTML = "";
  const note = document.createElement("div");
  note.className = "md-mermaid-error";
  note.textContent = `Mermaid 渲染失败：${reason}`;
  const pre = document.createElement("pre");
  pre.textContent = source;
  block.append(note, pre);
}
