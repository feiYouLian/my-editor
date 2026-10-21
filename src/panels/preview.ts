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

/** 经系统打印对话框导出 PDF（WebView2 支持 window.print） */
export function openPrintDialog(fullHtml: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
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

export class PreviewHost {
  private mode: PreviewMode = "edit";
  private kind: PreviewKind = null;
  private activeId: string | null = null;
  private mdReady: Promise<void> | null = null;
  private md: { render(text: string): string } | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncAt = 0;
  private contentEl: HTMLElement;

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
      void this.renderNow(tab, this.kind);
    }
  }

  /** 编辑内容变化后的防抖重渲染 */
  scheduleRender(tab: PreviewTab): void {
    if (this.mode === "edit" || !this.kind || this.activeId !== tab.id) return;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.renderNow(tab, this.kind!), 300);
  }

  /** 编辑器滚动 → 预览滚动（双栏 Markdown） */
  syncFromEditor(view: EditorView): void {
    if (this.mode !== "split" || this.kind !== "md") return;
    const now = Date.now();
    if (now - this.lastSyncAt < 80) return;
    const rect = view.scrollDOM.getBoundingClientRect();
    const pos = view.posAtCoords({ x: rect.left + 20, y: rect.top + 2 }, false);
    if (pos == null) return;
    const lineNo = view.state.doc.lineAt(pos).number;
    const target = this.contentEl.querySelector<HTMLElement>(`[data-line="${lineNo}"]`);
    if (target) {
      this.lastSyncAt = now;
      this.contentEl.scrollTop = target.offsetTop - 8;
    }
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
      // markdown-it html:false + DOMPurify 兜底消毒（data:image 在媒体标签上被允许）
      this.contentEl.innerHTML = this.dompurify!.sanitize(holder.innerHTML);
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
        const [mdMod, dpMod, hljsMod] = await Promise.all([
          import("markdown-it"),
          import("dompurify"),
          import("highlight.js/lib/common"),
        ]);
        // highlight.js 浅色主题（预览面板为浅色文档底）
        await import("highlight.js/styles/github.css");
        const MarkdownIt = mdMod.default;
        // dompurify 类型解析不稳定（.mts default），运行时 default 必定存在
        const DOMPurify = (dpMod as unknown as {
          default: { sanitize(html: string): string };
        }).default;
        const hljs = hljsMod.default;
        const md = new MarkdownIt({
          html: false, // 不解析 raw HTML（安全）
          linkify: true,
          highlight(code, lang) {
            try {
              if (lang && hljs.getLanguage(lang)) {
                return hljs.highlight(code, { language: lang }).value;
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
        this.md = md;
        this.dompurify = DOMPurify;
      })();
    }
    await this.mdReady;
  }

  private dompurify: { sanitize(html: string): string } | null = null;

  /** 导出用：返回消毒后的正文 HTML（md 渲染并内联本地图片；html 原样） */
  async getExportBody(tab: PreviewTab): Promise<string> {
    if (pathKindOf(tab.path) === "md") {
      await this.ensureMarkdown();
      const holder = document.createElement("div");
      holder.innerHTML = this.md!.render(tab.content);
      // 导出文件可能被保存到任意目录：本地图片转 data URL，保证打开即可见
      await this.inlineLocalImages(holder, tab.path);
      return this.dompurify!.sanitize(holder.innerHTML);
    }
    return tab.content;
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

  private onPreviewScroll(): void {
    if (this.mode !== "split" || this.kind !== "md") return;
    const now = Date.now();
    if (now - this.lastSyncAt < 150) return;
    const lines = this.contentEl.querySelectorAll<HTMLElement>("[data-line]");
    if (lines.length === 0) return;
    const paneTop = this.contentEl.getBoundingClientRect().top;
    for (const el of lines) {
      if (el.getBoundingClientRect().top >= paneTop - 2) {
        const lineNo = Number(el.dataset.line);
        if (Number.isFinite(lineNo)) {
          this.lastSyncAt = now;
          this.onScrollToLine(lineNo);
        }
        return;
      }
    }
  }
}
