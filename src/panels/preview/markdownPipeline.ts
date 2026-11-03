/**
 * Markdown 预览管线：markdown-it + DOMPurify + highlight.js 懒加载，
 * 首次预览时构建一次，安装进宿主（installMarkdown）。
 *
 * 额外能力（M4/G15）：标题锚点 + 目录、KaTeX 数学公式、Mermaid 图表占位。
 * 数学与图表都按需加载：Mermaid 只在文档里真有图表时才 import。
 */

import { applyHeadingAnchors, type MdToken, type TocEntry } from "./markdownToc";

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

/** DOMPurify 的最小契约：字符串模式用于导出，IN_PLACE 模式用于预览内联消毒 */
export interface Sanitizer {
  sanitize(html: string): string;
  sanitize(node: HTMLElement, config: { IN_PLACE: true }): HTMLElement;
}

/** 管线的宿主契约（PreviewHost 实现；避免本模块反向依赖具体类） */
export interface MarkdownPipelineHost {
  installMarkdown(md: MarkdownRenderer, dompurify: Sanitizer): void;
}

/** 渲染器：除纯 HTML 外再暴露目录（TOC 需要在同一次解析里收集） */
export interface MarkdownRenderer {
  render(text: string): string;
  renderWithToc(text: string): { html: string; toc: TocEntry[] };
  /**
   * 顶层块级 HTML（每项通常对应一个根元素）+ 起始源码行 + 源码指纹。
   * reuse 返回 true 时该块跳过渲染（html 为 undefined），预览直接复用原 DOM；
   * 仅当文档没有引用定义时调用方才会传入 reuse（引用会跨块影响渲染结果）。
   */
  renderBlocksWithToc(
    text: string,
    reuse?: (key: string) => boolean,
  ): {
    blocks: { key: string; line: number; html?: string }[];
    toc: TocEntry[];
  };
}

/** 构建并安装管线。加载失败由调用方（ensureMarkdown）统一捕获并允许重试。 */
export async function loadMarkdownPipeline(host: MarkdownPipelineHost): Promise<void> {
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
  const DOMPurify = (dpMod as unknown as { default: Sanitizer }).default;
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
  // ---- 数学公式（KaTeX）：懒加载插件与样式 ----
  const [mathMod] = await Promise.all([
    import("@vscode/markdown-it-katex"),
    // 字体与样式必须一起进来，否则公式会以排版错误的纯文本出现
    import("katex/dist/katex.min.css"),
  ]);
  const katexPlugin = (mathMod as unknown as {
    default: (md: unknown, opts?: unknown) => unknown;
  }).default;
  md.use(katexPlugin, {
    // 公式写错不该让整篇预览报错：KaTeX 会渲染出红色错误文本
    throwOnError: false,
    // 允许 ```math 围栏写法
    enableFencedBlocks: true,
  });

  // ---- Mermaid：只输出占位块，预览/导出时再替换为 SVG（见 preview/mermaid.ts） ----
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = (token.info || "").trim().split(/\s+/)[0].toLowerCase();
    if (lang === "mermaid") {
      const src = md.utils.escapeHtml(token.content);
      const line = token.map ? token.map[0] + 1 : 1;
      // data-line 与其它块保持一致：双栏滚动联动依赖它
      return (
        `<div class="md-mermaid" data-line="${line}" data-mermaid="${src}">` +
        `<div class="md-mermaid-pending">Mermaid 图表（渲染中…）</div></div>`
      );
    }
    return defaultFence
      ? defaultFence(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };

  // 表格外包一层滚动容器：宽表横向滚动 + 圆角边框（预览与导出共用）
  const defaultTableOpen = md.renderer.rules.table_open;
  const defaultTableClose = md.renderer.rules.table_close;
  md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
    `<div class="md-table-wrap">${
      defaultTableOpen
        ? defaultTableOpen(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options)
    }`;
  md.renderer.rules.table_close = (tokens, idx, options, env, self) =>
    `${
      defaultTableClose
        ? defaultTableClose(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options)
    }</div>`;
  // 块级元素打源行标记（滚动联动）
  md.core.ruler.push("source-line", (state) => {
    for (const token of state.tokens) {
      if (token.map && token.type !== "inline") {
        token.attrSet("data-line", String(token.map[0] + 1));
      }
    }
  });
  // 标题锚点 + 目录：一次遍历同时产出 id 与目录数组（存在 env 上）
  md.core.ruler.push("heading-anchors", (state) => {
    const env = state.env as { toc?: TocEntry[] };
    env.toc = applyHeadingAnchors(state.tokens as unknown as MdToken[]);
  });

  const render = (text: string): string => md.render(text);
  const renderWithToc = (text: string): { html: string; toc: TocEntry[] } => {
    const env: { toc?: TocEntry[] } = {};
    const html = md.render(text, env);
    return { html, toc: env.toc ?? [] };
  };
  /**
   * 块源码指纹（长度 + 双哈希）：直接在原文本区间上算，
   * 不 slice 出整段源码，避免每次重渲染都为所有块复制一份字符串。
   */
  const hashBlockRange = (text: string, from: number, to: number): string => {
    let a = 0x811c9dc5;
    let b = 5381;
    for (let i = from; i < to; i += 1) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = (Math.imul(b, 33) + c) >>> 0;
    }
    return `${to - from}:${a}:${b}`;
  };

  /**
   * 一次解析 + 分组渲染：块边界取「level 0 且带源行映射」的 token。
   * 整篇仍完整解析，所以引用定义、目录锚点等跨块状态与整篇渲染一致。
   * 无引用定义时，源码未变的块可通过 reuse 跳过渲染（含代码高亮等重活）。
   */
  const renderBlocksWithToc = (
    text: string,
    reuse?: (key: string) => boolean,
  ): { blocks: { key: string; line: number; html?: string }[]; toc: TocEntry[] } => {
    const env: { toc?: TocEntry[] } = {};
    const tokens = md.parse(text, env);
    // 引用定义会改变其它块的链接渲染结果：有定义时一律重新渲染。
    // KaTeX 的全局宏定义（\gdef / \newcommand）也会跨块生效，同样禁用复用。
    const references = (env as { references?: Record<string, unknown> }).references;
    const hasGlobalMacro = /\\gdef\b|\\def\b|\\newcommand\b|\\renewcommand\b/.test(text);
    const canReuse =
      (!references || Object.keys(references).length === 0) && !hasGlobalMacro;
    // 行首偏移：按块源码切片，用于内容指纹（仅数字数组，不复制整篇文本）
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    const rangeOf = (fromLine: number, toLineExclusive: number): [number, number] => [
      lineStarts[fromLine - 1] ?? text.length,
      lineStarts[toLineExclusive - 1] ?? text.length,
    ];
    const blocks: { key: string; line: number; html?: string }[] = [];
    const push = (list: typeof tokens, line: number, endLineExclusive: number): void => {
      if (list.length === 0) return;
      const [from, to] = rangeOf(line, endLineExclusive);
      const key = hashBlockRange(text, from, to);
      // 标题锚点 id 会受前文重复标题影响（title-2 / title-3）：这类块必须重新渲染
      const hasHeading = list.some((token) => token.type === "heading_open");
      if (canReuse && !hasHeading && reuse?.(key) === true) {
        blocks.push({ key, line });
        return;
      }
      const html = md.renderer.render(list, md.options, env);
      if (html) blocks.push({ key, line, html });
    };
    let start = -1;
    let startLine = 1;
    const maxLine = lineStarts.length + 1;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.level === 0 && token.map) {
        const line = token.map[0] + 1;
        if (start >= 0) push(tokens.slice(start, i), startLine, line);
        start = i;
        startLine = line;
      }
    }
    if (start >= 0) push(tokens.slice(start), startLine, maxLine);
    // 空文档 / 只有引用定义：整篇渲染一次，保持与旧路径一致
    else push(tokens, 1, maxLine);
    return { blocks, toc: env.toc ?? [] };
  };
  host.installMarkdown({ render, renderWithToc, renderBlocksWithToc }, DOMPurify);
}
