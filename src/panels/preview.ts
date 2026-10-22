import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import type TurndownService from "turndown";

/**
 * 预览宿主：
 * - Markdown：markdown-it(html:false) + DOMPurify + highlight.js（均懒加载），
 *   块级元素打 data-line 标记，双栏滚动联动
 * - HTML：沙箱 iframe（sandbox="" 禁用脚本，CSS/图片正常渲染）
 * - 模式：编辑 / 预览 / 双栏（md/html 可切换；≥20MB 禁用预览）
 * - 图片标签走 mode-image（见 imageViewer）
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

export function pathKindOf(path: string | null): PreviewKind {
  if (!path) return null;
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return null;
}

/** 预览大小上限（超过则禁用预览） */
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** 双栏滚动联动：源行/块顶与各自视口顶之间保留的呼吸距离（px） */
const SYNC_TOP_MARGIN = 8;
/**
 * 双栏滚动联动：回显抑制窗口（ms）。
 * 一侧被程序滚动后，对方面板随之抛出的 scroll 事件在窗口内视为回显忽略，
 * 避免"你滚我滚"的死循环。程序滚动产生的 scroll 事件 1~2 帧内必到，
 * 120ms 足够覆盖；即便偶发超时也被当作一次真实滚动，计算结果相同、不会振荡，
 * 最多让对侧多同步一次（自收敛，无死循环）。
 */
const PREVIEW_ECHO_MS = 120;

/** 相对路径图片内联上限：超过则跳过，避免预览一次性读入大图 */
const INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 已内联图片缓存：同一图片在多次重渲染时复用；超出上限按插入顺序淘汰 */
const imageCache = new Map<string, Promise<string | null>>();
const IMAGE_CACHE_LIMIT = 24;

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

/**
 * 把 Markdown 中的本地图片地址解析为绝对路径：
 * 远程 / 内联地址返回 null；file:// 与盘符 / UNC 绝对路径直接归一化；
 * 其余按文档所在目录解析（支持 %20 等转义与正斜杠）。
 */
function resolveLocalImage(src: string, baseDir: string): string | null {
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

/** 导出用的独立文档样式（与预览面板排版一致，浅色） */
const EXPORT_CSS = `
body { font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.7; color: #24292f; margin: 24px auto; max-width: 860px; padding: 0 20px; }
h1, h2 { border-bottom: 1px solid #e1e4e8; padding-bottom: .3em; }
pre { background: #f6f8fa; border-radius: 6px; padding: 12px; overflow: auto; }
code { font-family: Consolas, "Courier New", monospace; font-size: 12px; background: rgba(175,184,193,.2); border-radius: 3px; padding: .1em .3em; }
pre code { background: none; padding: 0; }
img { max-width: 100%; }
table { border-collapse: collapse; }
th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
blockquote { border-left: 4px solid #d0d7de; margin: 0; padding: 0 12px; color: #57606a; }
a { color: #4c8dff; }
@media print { body { margin: 0; max-width: none; padding: 0; } }
`;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 组装独立 HTML 文档（导出 HTML / PDF 打印共用） */
export function buildStandaloneHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body><article class="md-body">${bodyHtml}</article></body>
</html>`;
}

/**
 * 组装 Word 兼容文档（HTML-based .doc）。
 * 说明：Word 以 HTML 渲染打开（ProgId=Word.Document），排版保真度对
 * 标题/表格/代码块足够；如需严格 OOXML .docx，可评估 docx npm 包。
 */
export function buildWordHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="Microsoft Word 15">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body><article class="md-body">${bodyHtml}</article></body>
</html>`;
}

/** 经系统打印对话框导出 PDF（WebView2 支持 window.print）。
 *  sandbox 不放行 allow-scripts：导出内容里的脚本不会执行
 *  （srcdoc 还会继承应用 CSP，双保险）；allow-same-origin
 *  保证父窗口仍可 focus/print 该iframe。 */
export function openPrintDialog(fullHtml: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;";
  iframe.srcdoc = fullHtml;
  iframe.addEventListener("load", () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (err) {
      console.error("[export] 调起打印失败", err);
    }
    // 打印对话框关闭后由用户决定；兜底 60s 后移除
    setTimeout(() => iframe.remove(), 60_000);
  });
  document.body.append(iframe);
}

// ---------------------------------------------------------------------------
// HTML → Markdown（导出 .md）：turndown + GFM（懒加载，与 markdown-it 同策略）
// ---------------------------------------------------------------------------

/**
 * 转换前预处理（DOMParser 之后、turndown 之前）：
 * - 剔除脚本 / 样式 / 模板 / SVG 等非正文节点，降低导出噪声
 * - <pre> 内 <br> 表示换行：替换为文本换行，否则代码行会被 textContent 粘连
 * - srcset 归一化为 src，避免图片丢失
 * - iframe / audio / video 无法转为 Markdown：降级为链接，保留可访问性
 */
function prepareForMarkdown(doc: Document): void {
  doc
    .querySelectorAll(
      "script,style,noscript,template,link,meta,head,svg,canvas,object,embed",
    )
    .forEach((el) => el.remove());
  doc.querySelectorAll("[aria-hidden='true'],[hidden]").forEach((el) => el.remove());
  // 内联样式隐藏的内容（保存的网页常见）：不属于导出正文
  doc
    .querySelectorAll(
      "[style*='display:none'],[style*='display: none'],[style*='visibility:hidden'],[style*='visibility: hidden']",
    )
    .forEach((el) => el.remove());
  // 微信代码块的行号列不属于正文
  doc.querySelectorAll(".code-snippet__line-index").forEach((el) => el.remove());
  doc.querySelectorAll("pre br").forEach((br) => br.replaceWith("\n"));
  doc.querySelectorAll("img[srcset]").forEach((img) => {
    if (!img.getAttribute("src")) {
      const first = (img.getAttribute("srcset") ?? "").split(",")[0]?.trim().split(/\s+/)[0];
      if (first) img.setAttribute("src", first);
    }
    img.removeAttribute("srcset");
  });
  doc.querySelectorAll("iframe[src],audio[src],video[src]").forEach((el) => {
    const src = el.getAttribute("src") ?? "";
    const link = doc.createElement("a");
    link.setAttribute("href", src);
    link.textContent = `嵌入内容：${src}`;
    el.replaceWith(link);
  });
  // GFM 表格单元格内的裸竖线会破坏表结构：先打占位符，转换后还原为 \|
  doc.querySelectorAll("td,th").forEach((cell) => {
    escapePipesInTextNodes(cell, (v) => v.replace(/\|/g, TABLE_PIPE_PLACEHOLDER));
  });
  // GFM 只转换带表头行（THEAD 或首个 TBODY 且全 TH）的表格，
  // 无表头表格会被原样保留为 HTML：将首行 td 提升为 th 并包进 thead。
  // （同时规避 isHeadingRow 的 every(childNodes) 对单元格间空白文本的误判）
  doc.querySelectorAll("table").forEach((table) => {
    const firstRow = table.querySelector("tr");
    if (!firstRow || firstRow.parentNode?.nodeName === "THEAD") return;
    const cells = Array.from(firstRow.children).filter((c) =>
      /^(td|th)$/i.test(c.tagName),
    );
    if (cells.length === 0 || cells.some((c) => c.tagName.toLowerCase() === "th")) return;
    cells.forEach((c) => {
      const th = doc.createElement("th");
      th.innerHTML = c.innerHTML;
      c.replaceWith(th);
    });
    const thead = doc.createElement("thead");
    firstRow.parentNode?.insertBefore(thead, firstRow);
    thead.appendChild(firstRow);
  });
  // 任务列表：吃掉 checkbox 前后空白，避免 "-   [x]  文本" 的多空格
  doc.querySelectorAll("li > input[type='checkbox']").forEach((box) => {
    const prev = box.previousSibling;
    if (prev && prev.nodeType === Node.TEXT_NODE && !prev.nodeValue?.trim()) prev.remove();
    const next = box.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE) {
      next.nodeValue = next.nodeValue?.replace(/^\s+/, "") ?? "";
    }
  });
}

/** 表格竖线占位符（Unicode 私用区，正常网页不会出现；转换后还原为 \|） */
const TABLE_PIPE_PLACEHOLDER = "\uE000";

/** 递归替换元素内所有文本节点的竖线 */
function escapePipesInTextNodes(root: Node, replace: (value: string) => string): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const value = child.nodeValue;
      if (value?.includes("|")) child.nodeValue = replace(value);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      escapePipesInTextNodes(child, replace);
    }
  }
}

/** 代码块语言标识：data-lang 属性或 class=language-xxx */
function codeLangOf(el: Element | null): string {
  if (!el) return "";
  return (
    el.getAttribute("data-lang") ||
    /language-([\w+#.-]+)/.exec(el.getAttribute("class") ?? "")?.[1] ||
    ""
  );
}

/** 围栏代码块统一出口；空内容不输出，避免产生 ``` 空块噪声 */
function fencedBlock(text: string, lang: string): string {
  const body = text.replace(/\n$/, "");
  if (!body.trim()) return "";
  return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
}

/**
 * 构建 turndown 实例（懒加载 + 自定义规则）：
 * - 多 <code> 的 <pre>（微信公众号代码块每行一个 <code>）：逐行拼接，
 *   否则 turndown 内置规则只取第一个 <code>，其余代码行丢失
 * - <pre> 直接含文本（无 <code> 子元素）：仍按代码块导出
 * - data: 图片未能落盘时降级为纯 alt，避免巨型 data URI 单行
 * - Word / 伪列表：以项目符号开头的段落还原为列表项
 * - 空标题不输出
 */
async function createMarkdownService(): Promise<TurndownService> {
  const [{ default: TurndownService }, { gfm }] = await Promise.all([
    import("turndown"),
    import("turndown-plugin-gfm"),
  ]);
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });
  gfm(service);

  service.addRule("multiCodePre", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      Array.from(node.children).filter((child) => child.nodeName === "CODE").length > 1,
    replacement: (_content, node) => {
      const codes = Array.from(node.children).filter((child) => child.nodeName === "CODE");
      return fencedBlock(
        codes.map((code) => code.textContent ?? "").join("\n"),
        codeLangOf(codes[0] ?? node),
      );
    },
  });

  service.addRule("barePre", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      !Array.from(node.children).some((child) => child.nodeName === "CODE"),
    replacement: (_content, node) => fencedBlock(node.textContent ?? "", codeLangOf(node)),
  });

  service.addRule("dataImage", {
    filter: (node) =>
      node.nodeName === "IMG" && /^data:/i.test(node.getAttribute("src") ?? ""),
    replacement: (_content, node) => {
      const alt = node.getAttribute("alt") ?? "";
      return alt ? `![${alt}]` : "";
    },
  });

  service.addRule("pseudoListItem", {
    filter: (node) => {
      if (node.nodeName !== "P") return false;
      if (node.querySelector("img,table,pre")) return false;
      return /^\s*[•·▪◦○●]\s+\S/.test(node.textContent ?? "");
    },
    replacement: (content) => `\n- ${content.replace(/^\s*[•·▪◦○●]\s+/, "")}\n`,
  });

  service.addRule("emptyHeading", {
    filter: (node) => /^H[1-6]$/.test(node.nodeName) && !(node.textContent ?? "").trim(),
    replacement: () => "",
  });

  return service;
}

/**
 * HTML → Markdown（导出 .md）。
 * turndown + GFM：标题 / 段落 / 列表 / 引用 / 围栏代码块 / GFM 表格 /
 * 删除线 / 任务列表 / 链接 / 图片。
 * 保存的网页常带导航 / 二维码等外壳：优先只转换微信正文容器（#js_content）。
 * 相对图片地址按原文保留，便于与原 HTML 放在同一目录使用。
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  prepareForMarkdown(doc);
  const root = doc.querySelector<HTMLElement>("#js_content") ?? doc.body;
  // frameset 等无 body 的文档：无正文可导出
  if (!root) return "";
  const service = await createMarkdownService();
  return service
    .turndown(root)
    .replace(/\uE000/g, "\\|")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .concat("\n");
}

/**
 * highlight.js/lib/common 未内置、但 Markdown 文档里高频出现的语言。
 * 动态 import 注册（懒加载，不进首屏）；注册后 ```dockerfile / ```powershell
 * 等围栏标识才能命中对应语法，否则只能按纯文本渲染。
 */
const EXTRA_HLJS_LANGUAGES = [
  "dockerfile",
  "powershell",
  "dos",
  "nginx",
  "apache",
  "properties",
  "handlebars",
  "dart",
  "matlab",
  "julia",
  "fortran",
  "lisp",
  "clojure",
  "haskell",
  "erlang",
  "elixir",
  "groovy",
  "gradle",
  "cmake",
  "vim",
  "x86asm",
  "coffeescript",
] as const;

/** 自动探测的代码体积上限：highlightAuto 代价随语言数增长，超大块跳过 */
const HLJS_AUTO_MAX_CHARS = 20_000;

/** markdown-it + DOMPurify + highlight.js 懒加载管线（首次预览时构建一次）。
 *  抽成独立函数：加载失败时由 ensureMarkdown 统一捕获并允许重试。 */
async function loadMarkdownPipeline(host: PreviewHost): Promise<void> {
  const [mdMod, dpMod, hljsMod, ...extraLangMods] = await Promise.all([
    import("markdown-it"),
    import("dompurify"),
    import("highlight.js/lib/common"),
    // common 缺失的高频语言逐个注册（静态路径，保证 Vite 可静态分析分块）
    import("highlight.js/lib/languages/dockerfile"),
    import("highlight.js/lib/languages/powershell"),
    import("highlight.js/lib/languages/dos"),
    import("highlight.js/lib/languages/nginx"),
    import("highlight.js/lib/languages/apache"),
    import("highlight.js/lib/languages/properties"),
    import("highlight.js/lib/languages/handlebars"),
    import("highlight.js/lib/languages/dart"),
    import("highlight.js/lib/languages/matlab"),
    import("highlight.js/lib/languages/julia"),
    import("highlight.js/lib/languages/fortran"),
    import("highlight.js/lib/languages/lisp"),
    import("highlight.js/lib/languages/clojure"),
    import("highlight.js/lib/languages/haskell"),
    import("highlight.js/lib/languages/erlang"),
    import("highlight.js/lib/languages/elixir"),
    import("highlight.js/lib/languages/groovy"),
    import("highlight.js/lib/languages/gradle"),
    import("highlight.js/lib/languages/cmake"),
    import("highlight.js/lib/languages/vim"),
    import("highlight.js/lib/languages/x86asm"),
    import("highlight.js/lib/languages/coffeescript"),
  ]);
  // highlight.js 浅色主题（预览面板为浅色文档底）
  await import("highlight.js/styles/github.css");
  const MarkdownIt = mdMod.default;
  // dompurify 类型解析不稳定（.mts default），运行时 default 必定存在
  const DOMPurify = (dpMod as unknown as {
    default: { sanitize(html: string): string };
  }).default;
  const hljs = hljsMod.default;
  // 注册 common 之外的语言（下标与 EXTRA_HLJS_LANGUAGES 一一对应）
  extraLangMods.forEach((mod, i) =>
    hljs.registerLanguage(EXTRA_HLJS_LANGUAGES[i], mod.default),
  );
  const md = new MarkdownIt({
    html: false, // 不解析 raw HTML（安全）
    linkify: true,
    highlight(code, lang) {
      try {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        // 未标注语言或语言未注册（旧标识 / 拼写变体）：自动探测兜底，
        // 与 GitHub 行为一致；超大代码块跳过探测避免卡顿
        if (code.trim() && code.length <= HLJS_AUTO_MAX_CHARS) {
          return hljs.highlightAuto(code).value;
        }
      } catch {
        // 高亮失败降级为纯文本
      }
      return "";
    },
  });
  // 块级元素打源行标记（滚动联动）
  md.core.ruler.push("source-line", (state) => {
    for (const token of state.tokens) {
      if (token.map && token.type !== "inline") {
        token.attrSet("data-line", String(token.map[0] + 1));
      }
    }
  });
  host.installMarkdown(md as unknown as { render(text: string): string }, DOMPurify);
}

export class PreviewHost {
  private mode: PreviewMode = "edit";
  private kind: PreviewKind = null;
  private activeId: string | null = null;
  private mdReady: Promise<void> | null = null;
  private md: { render(text: string): string } | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private contentEl: HTMLElement;

  // ---- 双栏滚动联动状态 ----
  /** 最近一次参与联动的编辑器视图（供重渲染 / 图片加载后校准用） */
  private syncView: EditorView | null = null;
  /** rAF 句柄：连续滚动每帧最多同步一次，保证末次事件必达（时间窗丢事件会累积偏移） */
  private syncRaf: number | null = null;
  /** 预览被本类程序滚动后，窗口内其 scroll 事件视为回显直接忽略 */
  private previewEchoUntil = 0;

  constructor(
    private pane: HTMLElement,
    private area: HTMLElement,
    private onScrollToLine: (line: number) => void,
    /**
     * HTML 预览渲染在 iframe 内，右键事件不会冒泡到宿主；
     * 通过同源访问 iframe 文档转发，坐标已换算为页面坐标。
     */
    private onContextMenu?: (x: number, y: number) => void,
  ) {
    this.pane.innerHTML = '<div class="preview-content"></div>';
    this.contentEl = this.pane.querySelector<HTMLElement>(".preview-content")!;
    this.contentEl.addEventListener("scroll", () => this.onPreviewScroll());
  }

  /** 移除预览区残留的图片工具条，避免连续打开图片时叠加 */
  private clearImageToolbar(): void {
    this.pane.querySelectorAll(".image-toolbar").forEach((el) => el.remove());
  }

  /** 标签/模式变化时调用：应用布局并按需渲染 */
  apply(tab: PreviewTab | null, mode: PreviewMode): void {
    this.activeId = tab?.id ?? null;
    this.clearImageToolbar();
    if (tab?.kind === "image") {
      this.kind = null;
      this.setAreaMode("image");
      this.renderImage(tab);
      return;
    }
    this.kind = tab ? pathKindOf(tab.path) : null;
    this.mode = this.kind && mode !== "edit" ? mode : "edit";
    this.setAreaMode(this.mode);
    if (this.mode !== "edit" && tab && this.kind) {
      this.renderSafe(tab, this.kind);
    }
  }

  /** 编辑内容变化后的防抖重渲染 */
  scheduleRender(tab: PreviewTab): void {
    if (this.mode === "edit" || !this.kind || this.activeId !== tab.id) return;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.renderSafe(tab, this.kind!), 300);
  }

  /** 渲染并兜底错误：组件加载失败时在预览区显示原因，绝不静默空白 */
  private renderSafe(tab: PreviewTab, kind: "md" | "html"): void {
    this.renderNow(tab, kind).catch((e) => {
      if (this.isStale(tab)) return;
      console.error("[preview] 渲染失败", e);
      this.contentEl.innerHTML = "";
      const note = document.createElement("div");
      note.className = "preview-note";
      note.textContent = String(e instanceof Error ? e.message : e);
      this.contentEl.append(note);
    });
  }

  /**
   * 编辑器滚动 → 预览滚动（双栏 Markdown）。
   *
   * 历史问题（滚动越久偏移越大）：
   * 1. 用 posAtCoords 取顶部行——快速拖动滚动条时该行常未渲染，返回 null 直接不同步；
   * 2. 时间窗（80ms）丢事件：一次滚动手势的最后一个事件落在窗口内就被丢弃，偏移永久残留；
   * 3. `[data-line="N"]` 精确匹配——行落在长段落中间时没有对应标记，同样不同步。
   *
   * 现在改为：rAF 节流（末次事件必达）+ 高度图取顶部可见行 + 最近标记 + 块内插值。
   */
  syncFromEditor(view: EditorView): void {
    if (!this.canSync()) return;
    // 注意：这里不能做回显抑制——previewEchoUntil 是本类自己滚动预览时打的
    // 标记，编辑器连续滚动时每一帧都会刷新它，若在这里判断会把真实滚动也吞掉
    // （每 200ms 才同步一次，且手势末次事件被丢弃，偏移再次累积）。
    // 回显抑制只属于 onPreviewScroll（预览侧）。
    this.syncView = view;
    this.scheduleSync(() => this.applyEditorToPreview());
  }

  /** 以编辑器顶部可见行为准，把预览滚到对应位置（块内按源行插值，滚动连续） */
  private applyEditorToPreview(): void {
    const view = this.syncView;
    if (!view || !this.canSync()) return;
    let line: number;
    try {
      const doc = view.state.doc;
      const scrollTop = view.scrollDOM.scrollTop;
      // lineBlockAtHeight 走高度图，不依赖坐标测量：目标行未渲染时同样可用。
      // +2 让"顶部边缘所在行"稳定落在视口内（0 时恰在行缝上会取到上一行）
      const block = view.lineBlockAtHeight(scrollTop + 2);
      // 视口顶落在该可视行内的比例 → 折算成小数源码行号；
      // 预览侧用同一套小数行号插值，双向对齐到亚行精度
      const frac =
        block.height > 0
          ? Math.min(1, Math.max(0, (scrollTop + 2 - block.top) / block.height))
          : 0;
      const pos = block.from + (block.to - block.from) * frac;
      const whole = doc.lineAt(Math.min(pos, doc.length)).number;
      const info = doc.line(whole);
      line = whole + (pos - info.from) / Math.max(1, info.to - info.from);
    } catch {
      return; // 视图已销毁等异常：放弃本次同步
    }
    const target = this.previewScrollTopForLine(line);
    if (target == null) return;
    this.previewEchoUntil = performance.now() + PREVIEW_ECHO_MS;
    this.contentEl.scrollTop = target;
  }

  /** 源码行号 → 预览滚动位置：取"起始行 ≤ lineNo"的最后一个块，块内线性插值 */
  private previewScrollTopForLine(lineNo: number): number | null {
    const markers = this.lineMarkers();
    if (markers.length === 0) return null;
    let idx = 0;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].line <= lineNo) idx = i;
      else break; // data-line 按文档序递增
    }
    const cur = markers[idx];
    const curTop = this.markerTop(cur.el);
    const next = markers[idx + 1];
    if (!next) return Math.max(0, curTop - SYNC_TOP_MARGIN);
    const nextTop = this.markerTop(next.el);
    const span = Math.max(1, next.line - cur.line);
    const frac = Math.min(1, Math.max(0, (lineNo - cur.line) / span));
    return Math.max(0, curTop + (nextTop - curTop) * frac - SYNC_TOP_MARGIN);
  }

  /** 块标记（data-line）按文档序收集 */
  private lineMarkers(): { el: HTMLElement; line: number }[] {
    const out: { el: HTMLElement; line: number }[] = [];
    for (const el of this.contentEl.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(el.dataset.line);
      if (Number.isFinite(line)) out.push({ el, line });
    }
    return out;
  }

  /** 标记元素相对滚动容器内容原点的顶部位置（rect 计算，不受 offsetParent 影响） */
  private markerTop(el: HTMLElement): number {
    return (
      el.getBoundingClientRect().top -
      this.contentEl.getBoundingClientRect().top +
      this.contentEl.scrollTop
    );
  }

  /** 重渲染 / 图片加载后：下一帧按编辑器位置重新校准预览滚动 */
  private scheduleResync(): void {
    this.scheduleSync(() => this.applyEditorToPreview());
  }

  /**
   * rAF 节流执行一次联动：同一帧内后到的事件更新鲜，取消前一次待执行任务，
   * 保证末次事件必达（时间窗丢事件是历史偏移累积的直接原因）。
   */
  private scheduleSync(run: () => void): void {
    if (this.syncRaf !== null) cancelAnimationFrame(this.syncRaf);
    this.syncRaf = requestAnimationFrame(() => {
      this.syncRaf = null;
      run();
    });
  }

  /** 联动条件：双栏 + Markdown + 管线就绪 */
  private canSync(): boolean {
    return this.mode === "split" && this.kind === "md" && this.md !== null;
  }

  private setAreaMode(mode: "edit" | "preview" | "split" | "image"): void {
    this.area.classList.remove("mode-edit", "mode-preview", "mode-split", "mode-image");
    this.area.classList.add(`mode-${mode}`);
  }

  private async renderNow(tab: PreviewTab, kind: "md" | "html"): Promise<void> {
    if (this.activeId !== tab.id || this.mode === "edit") return;
    if (tab.size > PREVIEW_MAX_BYTES) {
      this.contentEl.innerHTML = '<div class="preview-note">文件过大（≥20MB），预览已禁用</div>';
      return;
    }
    if (kind === "md") {
      await this.ensureMarkdown();
      // 先渲染为 DOM：本地图片需在消毒前替换为 data URL
      // （盘符路径会被 DOMPurify 当作未知协议而移除 src）
      const holder = document.createElement("div");
      holder.innerHTML = this.md!.render(tab.content);
      await this.inlineLocalImages(holder, tab.path);
      // 解析期间可能已切标签 / 切模式：丢弃过期结果
      if (this.isStale(tab)) return;
      // innerHTML 整体替换会把滚动位置重置为 0（输入期间预览"跳回顶部"的元凶）：
      // 先记录再恢复，随后以编辑器位置重新校准
      const scrollTop = this.contentEl.scrollTop;
      // markdown-it html:false + DOMPurify 兜底消毒（data:image 在媒体标签上被允许）
      this.contentEl.innerHTML = this.dompurify!.sanitize(holder.innerHTML);
      this.contentEl.scrollTop = scrollTop;
      this.bindImageLoadResync();
      this.scheduleResync();
    } else {
      // sandbox 仅放行 allow-same-origin 以便把右键事件转回宿主；
      // 未开启 allow-scripts，HTML 内脚本仍不执行
      this.contentEl.innerHTML =
        '<iframe class="preview-iframe" sandbox="allow-same-origin"></iframe>';
      const iframe = this.contentEl.querySelector("iframe")!;
      iframe.srcdoc = tab.content;
      iframe.addEventListener("load", () => this.bindIframeContextMenu(iframe));
    }
  }

  /** 把 iframe 内的右键菜单请求转发给宿主（坐标叠加 iframe 在页面中的位置） */
  private bindIframeContextMenu(iframe: HTMLIFrameElement): void {
    if (!this.onContextMenu) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const rect = iframe.getBoundingClientRect();
      this.onContextMenu?.(rect.left + event.clientX, rect.top + event.clientY);
    });
  }

  /** 异步渲染完成后判断标签 / 模式是否已变化 */
  private isStale(tab: PreviewTab): boolean {
    return this.activeId !== tab.id || this.mode === "edit";
  }

  /** 把预览 DOM 中的本地图片内联为 data URL；未保存文档（无路径）跳过 */
  private async inlineLocalImages(root: HTMLElement, mdPath: string | null): Promise<void> {
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

  private async ensureMarkdown(): Promise<void> {
    if (this.md) return;
    if (!this.mdReady) {
      this.mdReady = (async () => {
        try {
          await loadMarkdownPipeline(this);
        } catch (e) {
          // 加载失败（离线 / 缓存损坏）：清空缓存允许重试，抛出友好错误，
          // 避免调用方在 this.md! 上崩溃或静默无预览
          this.md = null;
          this.dompurify = null;
          throw new Error(
            `预览组件加载失败: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })().catch((e) => {
        this.mdReady = null;
        throw e;
      });
    }
    await this.mdReady;
  }

  private dompurify: { sanitize(html: string): string } | null = null;

  /** 管线构建完成后安装（供 loadMarkdownPipeline 回调） */
  installMarkdown(
    md: { render(text: string): string },
    dompurify: { sanitize(html: string): string },
  ): void {
    this.md = md;
    this.dompurify = dompurify;
  }

  /** 导出用：返回消毒后的正文 HTML（md 渲染并内联本地图片；html 先消毒） */
  async getExportBody(tab: PreviewTab): Promise<string> {
    if (pathKindOf(tab.path) === "md") {
      await this.ensureMarkdown();
      const holder = document.createElement("div");
      holder.innerHTML = this.md!.render(tab.content);
      // 导出文件可能被保存到任意目录：本地图片转 data URL，保证打开即可见
      await this.inlineLocalImages(holder, tab.path);
      return this.dompurify!.sanitize(holder.innerHTML);
    }
    // html 类文件：导出/打印前也过一遍消毒，避免把原始内容里的
    // <script> / 事件属性原样写进导出文档或无 sandbox 的打印 iframe
    await this.ensureMarkdown();
    return this.dompurify!.sanitize(tab.content);
  }

  // ---- 图片查看器（kind=image 的标签）----

  renderImage(tab: PreviewTab): void {
    this.contentEl.innerHTML = "";
    const stage = document.createElement("div");
    stage.className = "image-stage";
    const img = document.createElement("img");
    img.src = tab.dataUrl ?? "";
    img.alt = tab.name;
    stage.append(img);

    const bar = document.createElement("div");
    bar.className = "image-toolbar";
    const label = document.createElement("span");
    const btn = (text: string, title: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon-btn";
      b.textContent = text;
      b.title = title;
      b.addEventListener("click", run);
      return b;
    };
    let scale = 1; // 100% = 适应宽度
    const apply = () => {
      img.style.width = `${scale * 100}%`;
      label.textContent = `${Math.round(scale * 100)}%`;
    };
    bar.append(
      btn("－", "缩小", () => {
        scale = Math.max(0.1, scale - 0.25);
        apply();
      }),
      label,
      btn("＋", "放大", () => {
        scale = Math.min(8, scale + 0.25);
        apply();
      }),
      btn("适应", "适应宽度", () => {
        scale = 1;
        apply();
      }),
    );
    apply();
    this.pane.prepend(bar);
    this.contentEl.append(stage);
  }

  // ---- 预览滚动 → 编辑器滚动 ----

  /**
   * 预览滚动 → 编辑器滚动。
   *
   * 历史问题：时间窗（150ms）与 syncFromEditor 的 80ms 共用 lastSyncAt，
   * 滚动手势末尾的事件落在窗口内被丢弃 → 编辑器永久落后一截；
   * 且 onScrollToLine 用 coordsAtPos 定位，目标行未渲染时返回 null，
   * 快速拖动预览滚动条时编辑器完全不动 → 偏移持续放大。
   *
   * 现在改为：rAF 节流 + 顶部边缘所在块 + 块内插值出源行号。
   */
  private onPreviewScroll(): void {
    if (!this.canSync()) return;
    if (performance.now() < this.previewEchoUntil) return;
    this.scheduleSync(() => this.applyPreviewToEditor());
  }

  /** 取预览顶部边缘所在的块，插值出源码行号（支持小数）交给编辑器滚动 */
  private applyPreviewToEditor(): void {
    const markers = this.lineMarkers();
    if (markers.length === 0) return;
    // 全部用视口坐标（getBoundingClientRect）比较：容器顶边与元素顶边同处
    // 一个坐标系。注意不能拿内容坐标（相对滚动原点）和 paneTop 混用。
    // 顶部边缘所在的块 = 最后一个 rect.top <= paneTop 的标记
    // （比"第一个在边缘下方"的标记更稳：预览在块内滚动时编辑器连续跟随，不跳块）
    const paneTop = this.contentEl.getBoundingClientRect().top;
    let idx = -1;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].el.getBoundingClientRect().top <= paneTop + 2) idx = i;
      else break;
    }
    let line: number;
    if (idx < 0) {
      line = markers[0].line;
    } else {
      const cur = markers[idx];
      const next = markers[idx + 1];
      if (!next) {
        line = cur.line;
      } else {
        const curTop = cur.el.getBoundingClientRect().top;
        const nextTop = next.el.getBoundingClientRect().top;
        const frac =
          nextTop > curTop
            ? Math.min(1, Math.max(0, (paneTop - curTop) / (nextTop - curTop)))
            : 0;
        line = cur.line + frac * (next.line - cur.line);
      }
    }
    this.onScrollToLine(line);
  }

  /** 图片异步加载会改变文档高度：加载完成后按编辑器位置重新校准 */
  private bindImageLoadResync(): void {
    for (const img of this.contentEl.querySelectorAll("img")) {
      if (img.complete) continue;
      img.addEventListener("load", () => this.scheduleResync(), { once: true });
    }
  }
}
