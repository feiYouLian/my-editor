/**
 * 预览导出：独立 HTML / Word 文档组装、系统打印（PDF）、
 * HTML → Markdown（turndown + GFM，懒加载）。
 */

import type TurndownService from "turndown";

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

/** 递归替换元素内所有文本节点的竖线（replace 返回新值） */
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
