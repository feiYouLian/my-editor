/**
 * Markdown 预览管线：markdown-it + DOMPurify + highlight.js 懒加载，
 * 首次预览时构建一次，安装进宿主（installMarkdown）。
 */

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

/** 管线的宿主契约（PreviewHost 实现；避免本模块反向依赖具体类） */
export interface MarkdownPipelineHost {
  installMarkdown(
    md: { render(text: string): string },
    dompurify: { sanitize(html: string): string },
  ): void;
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
  host.installMarkdown(md as unknown as { render(text: string): string }, DOMPurify);
}
