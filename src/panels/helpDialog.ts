import { firstLine } from "../core/errors";

/**
 * 帮助对话框：用户指南 / 常见问题。
 *
 * 内容直接取自仓库 `docs/USER-GUIDE.md` 与 `docs/FAQ.md`（构建时以 `?raw` 内联），
 * 与应用外文档保持单一真源、离线可用；
 * 渲染走 markdown-it（`html:false`）+ DOMPurify，与预览共用同一套安全边界。
 * 渲染器与文档都懒加载：从不看帮助的用户不会为它付首屏体积。
 */

export type HelpTopic = "guide" | "faq";

/**
 * 文档按需加载（动态 import）：静态 import 会把两份 Markdown 打进首屏 chunk，
 * 而绝大多数会话根本不会打开帮助。
 */
const sources = new Map<HelpTopic, Promise<string>>();

function loadSource(topic: HelpTopic): Promise<string> {
  let pending = sources.get(topic);
  if (!pending) {
    // 直接用仓库根目录的正式文档：与应用内帮助保持单一真源，不再维护第二份副本
    pending =
      topic === "guide"
        ? import("../../docs/USER-GUIDE.md?raw").then((m) => m.default)
        : import("../../docs/FAQ.md?raw").then((m) => m.default);
    sources.set(topic, pending);
  }
  return pending;
}

const TOPICS: { id: HelpTopic; label: string }[] = [
  { id: "guide", label: "用户指南" },
  { id: "faq", label: "常见问题" },
];

/** 已打开的对话框（单实例：重复点击菜单不叠加） */
let opened: HTMLElement | null = null;

type Renderer = { render: (text: string) => string };

/** markdown-it 实例缓存在模块内：切换主题/重开对话框不重复加载 */
let rendererPromise: Promise<{ renderer: Renderer; sanitize: (html: string) => string }> | null = null;

function loadRenderer(): Promise<{ renderer: Renderer; sanitize: (html: string) => string }> {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const [mdMod, dpMod] = await Promise.all([import("markdown-it"), import("dompurify")]);
      const MarkdownIt = mdMod.default;
      const DOMPurify = dpMod.default;
      const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
      return {
        renderer: { render: (text: string) => md.render(text) },
        sanitize: (html: string) => DOMPurify.sanitize(html),
      };
    })().catch((e: unknown) => {
      // 加载失败允许重试：清掉失败的 promise
      rendererPromise = null;
      throw e;
    });
  }
  return rendererPromise;
}

/** 打开帮助（topic 决定初始页；已打开时只切换标签页） */
export function showHelpDialog(topic: HelpTopic = "guide"): void {
  if (opened) {
    const btn = opened.querySelector<HTMLButtonElement>(`[data-topic="${topic}"]`);
    btn?.click();
    return;
  }

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "dialog dialog-wide help-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "帮助");

  const head = document.createElement("div");
  head.className = "help-head";
  const title = document.createElement("h3");
  title.textContent = "帮助";
  const tabs = document.createElement("div");
  tabs.className = "help-tabs";
  head.append(title, tabs);

  const content = document.createElement("div");
  content.className = "preview-content md-doc help-body";

  // 文档里的链接不能交给 WebView 默认行为：会把整个应用导航到 file:// 而回不来
  const linkHint = document.createElement("div");
  linkHint.className = "help-link-hint";
  linkHint.hidden = true;

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "primary";
  closeBtn.textContent = "关闭";
  actions.append(closeBtn);

  dialog.append(head, content, linkHint, actions);
  backdrop.append(dialog);
  document.body.append(backdrop);
  opened = backdrop;

  let seq = 0;
  const render = (next: HelpTopic): void => {
    const current = ++seq;
    for (const btn of tabs.querySelectorAll<HTMLButtonElement>("[data-topic]")) {
      btn.classList.toggle("active", btn.dataset.topic === next);
      btn.setAttribute("aria-selected", String(btn.dataset.topic === next));
    }
    content.textContent = "正在渲染…";
    void Promise.all([loadRenderer(), loadSource(next)])
      .then(([{ renderer, sanitize }, source]) => {
        if (current !== seq) return;
        content.innerHTML = sanitize(renderer.render(source));
        content.scrollTop = 0;
      })
      .catch((e: unknown) => {
        if (current !== seq) return;
        content.textContent = `帮助文档渲染失败：${firstLine(e)}`;
      });
  };

  for (const item of TOPICS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.topic = item.id;
    btn.setAttribute("role", "tab");
    btn.textContent = item.label;
    btn.addEventListener("click", () => render(item.id));
    tabs.append(btn);
  }

  const close = (): void => {
    seq++;
    backdrop.remove();
    opened = null;
    previousFocus?.focus({ preventScroll: true });
  };

  content.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    const lower = href.toLowerCase();
    // 文档之间的相对链接：直接切到对应标签页，而不是跳出应用
    if (lower.includes("faq")) {
      render("faq");
      return;
    }
    if (lower.includes("user-guide")) {
      render("guide");
      return;
    }
    linkHint.hidden = false;
    linkHint.textContent = `外部链接：${href}（请在浏览器中打开；内置文档只含用户指南与常见问题）`;
  });

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });

  render(topic);
  closeBtn.focus({ preventScroll: true });
}
