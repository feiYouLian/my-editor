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
  let api: MermaidApi;
  try {
    api = await loadMermaid();
  } catch (e) {
    failAll(blocks, `Mermaid 组件加载失败：${String(e instanceof Error ? e.message : e).split("\n")[0]}`);
    return;
  }
  for (const block of blocks) {
    const source = block.dataset.mermaid ?? "";
    if (!source.trim()) continue;
    try {
      renderSeq += 1;
      const { svg } = await api.render(`md-mermaid-${Date.now()}-${renderSeq}`, source);
      block.innerHTML = sanitize(svg);
      block.classList.add("rendered");
    } catch (e) {
      fail(block, source, String(e instanceof Error ? e.message : e).split("\n")[0]);
    }
  }
}

function failAll(blocks: HTMLElement[], reason: string): void {
  for (const block of blocks) fail(block, block.dataset.mermaid ?? "", reason);
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
