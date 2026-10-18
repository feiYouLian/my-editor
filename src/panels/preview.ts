import type { EditorView } from "@codemirror/view";

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
      const html = this.md!.render(tab.content);
      // markdown-it html:false + DOMPurify 兜底消毒
      this.contentEl.innerHTML = this.dompurify!.sanitize(html);
    } else {
      // 沙箱 iframe：sandbox="" 禁用脚本执行（防 XSS 触达 IPC），CSS/图片正常
      this.contentEl.innerHTML = '<iframe class="preview-iframe" sandbox=""></iframe>';
      const iframe = this.contentEl.querySelector("iframe")!;
      iframe.srcdoc = tab.content;
    }
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

  /** 导出用：返回消毒后的正文 HTML（md 渲染；html 原样） */
  async getExportBody(tab: PreviewTab): Promise<string> {
    if (pathKindOf(tab.path) === "md") {
      await this.ensureMarkdown();
      return this.dompurify!.sanitize(this.md!.render(tab.content));
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
