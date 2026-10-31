/**
 * Markdown 目录（TOC）与标题锚点：纯函数，便于单测。
 *
 * 做法：在一趟 token 遍历里给 `heading_open` 加稳定 id，同时收集目录项。
 * 不用 markdown-it-anchor 之类插件——这里只需要"id + 目录数组"，插件反而多一层配置。
 */

export interface TocEntry {
  /** 标题级别（1–6） */
  level: number;
  /** 纯文本标题（去掉 ** 、` 等标记） */
  text: string;
  /** 页面内唯一锚点 id */
  id: string;
}

/** token 的最小结构：只依赖实际用到的字段，避免耦合 markdown-it 的类型路径 */
export interface MdToken {
  type: string;
  tag: string;
  content: string;
  children?: { type: string; content: string }[] | null;
  attrSet(name: string, value: string): void;
  attrJoin(name: string, value: string): void;
}

/**
 * 生成锚点 id：小写、空白转 `-`、去掉标点，保留中文（中文标题也能生成可读 id）。
 * 结果为空时返回 `section`，由调用方保证唯一性。
 */
export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "-")
    // 保留字母 / 数字 / 中文 / 连字符与下划线
    .replace(/[^\p{L}\p{N}\-_]+/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/** 从 inline token 里取纯文本（含代码、链接文字，忽略强调标记） */
function inlineText(inline: MdToken | undefined): string {
  if (!inline) return "";
  const children = inline.children;
  if (!children || children.length === 0) return inline.content.trim();
  let out = "";
  for (const child of children) {
    if (child.type === "text" || child.type === "code_inline") out += child.content;
    else if (child.type === "softbreak" || child.type === "hardbreak") out += " ";
  }
  return out.trim();
}

/**
 * 给标题打锚点并返回目录。
 * @param tokens markdown-it 的 block token 数组（原地修改 heading_open）
 */
export function applyHeadingAnchors(tokens: readonly MdToken[]): TocEntry[] {
  const toc: TocEntry[] = [];
  const used = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "heading_open") continue;
    const text = inlineText(tokens[i + 1]);
    const level = Number(token.tag.slice(1)) || 1;
    let id = slugify(text);
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    used.add(id);
    token.attrSet("id", id);
    // data 属性用于目录跳转：即使消毒策略改了 id 的处理方式也仍然可用
    token.attrSet("data-toc-anchor", id);
    token.attrJoin("class", "md-heading");
    toc.push({ level, text, id });
  }
  return toc;
}
