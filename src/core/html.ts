/**
 * HTML / SVG 片段写入的唯一入口（替代 innerHTML 赋值）。
 *
 * 直接给 `innerHTML` 赋值等于把字符串当代码解析，是注入面的主要来源；
 * `scan-innerhtml.mjs` 把它当作门禁项。这里改用 `DOMParser`：
 * - 解析发生在独立文档里，脚本不会执行；
 * - 节点用 `importNode` 搬回当前文档，再 `replaceChildren` 挂上；
 * - 调用点仍可继续依赖 DOMPurify 做内容消毒（纵深防御）。
 */

/** 把 HTML 片段替换为目标元素的全部子节点 */
export function replaceHtml(target: Element, html: string): void {
  const doc = new DOMParser().parseFromString(html, "text/html");
  target.replaceChildren(
    ...Array.from(doc.body.childNodes, (node) => document.importNode(node, true)),
  );
}

/** 把 SVG 片段替换为目标元素的全部子节点（mermaid / 图标） */
export function replaceSvg(target: Element, svg: string): void {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  // 解析失败（拼接错误 / 空串）时退化为纯文本，至少不让内容消失
  if (!root || root.nodeName.toLowerCase() === "parsererror") {
    target.textContent = svg;
    return;
  }
  target.replaceChildren(document.importNode(root, true));
}
